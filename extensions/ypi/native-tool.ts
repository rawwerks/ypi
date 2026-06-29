import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	allocateCallCount,
	appendCostSummary,
	assertBudgetAvailable,
	assertTimeoutAvailable,
	assertWithinMaxCalls,
	canExecute,
	type CostSummary,
} from "./guardrails.ts";
import { currentDepth, maxDepth, nextDepth, safeTraceId, sharedSessionsEnabled } from "./env.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

const MAX_TOOL_OUTPUT_CHARS = 60 * 1024;
const READ_ONLY_TOOLS = "read,grep,find,ls,rlm_query";

const RlmQueryParams = Type.Object({
	prompt: Type.String({
		description: "Task for a child Pi agent. Keep it clear and bounded.",
	}),
	context: Type.Optional(Type.String({
		description: "Optional exact context to pass to the child via CONTEXT.",
	})),
	fork: Type.Optional(Type.Boolean({
		description: "Copy the current session file into the child session before running.",
	})),
});

interface NativeRunResult {
	code: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

interface Workspace {
	cwd: string;
	mode: "jj" | "none" | "off";
	readOnly: boolean;
	cleanup(): void;
}

interface ParsedJsonOutput {
	text: string;
	cost: CostSummary;
}

function nowTraceTime(): string {
	const d = new Date();
	return d.toTimeString().slice(0, 8) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function trace(message: string): void {
	if (process.env.PI_TRACE_FILE) {
		writeFileSync(process.env.PI_TRACE_FILE, `${message}\n`, { flag: "a" });
	}
}

function truncate(text: string): string {
	if (text.length <= MAX_TOOL_OUTPUT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Output truncated by ypi native rlm_query tool]`;
}

function createContextFile(params: { context?: string }): string | undefined {
	if (params.context !== undefined) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		writeFileSync(contextPath, params.context);
		return contextPath;
	}

	if (process.env.CONTEXT && existsSync(process.env.CONTEXT)) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		copyFileSync(process.env.CONTEXT, contextPath);
		return contextPath;
	}

	return undefined;
}

function createPromptFile(prompt: string): string {
	const promptPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_prompt_")), "prompt.txt");
	writeFileSync(promptPath, prompt);
	return promptPath;
}

function maybeCreateJjWorkspace(cwd: string, depth: number): Workspace {
	if (process.env.RLM_JJ === "0") {
		return { cwd, mode: "off", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	const root = spawnSync("jj", ["root"], { cwd, stdio: "ignore" });
	if (root.status !== 0) {
		return { cwd, mode: "none", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	const workspacePath = mkdtempSync(path.join(tmpdir(), `ypi_ws_d${depth}_`));
	const workspaceSuffix = path.basename(workspacePath).replace(/^ypi_ws_/, "");
	const name = `ypi-d${depth}-${process.pid}-${workspaceSuffix}`;
	const add = spawnSync("jj", ["workspace", "add", "--name", name, workspacePath], { cwd, stdio: "ignore" });
	if (add.status !== 0) {
		rmSync(workspacePath, { recursive: true, force: true });
		return { cwd, mode: "none", readOnly: process.env.RLM_UNSAFE_NO_JJ_WRITE !== "1", cleanup() {} };
	}

	return {
		cwd: workspacePath,
		mode: "jj",
		readOnly: false,
		cleanup() {
			spawnSync("jj", ["workspace", "forget", name], { cwd: workspacePath, stdio: "ignore" });
			rmSync(workspacePath, { recursive: true, force: true });
		},
	};
}

function commaEntry(value: string | undefined, oneBasedIndex: number): string {
	if (!value || oneBasedIndex < 1) return "";
	const parts = value.split(",").map((part) => part.trim());
	return parts[oneBasedIndex - 1] || "";
}

function providerModel(ctx: ExtensionContext, childDepth: number, rootThinkingLevel: string): { provider: string; model: string; thinkingLevel: string } {
	let provider = process.env.RLM_PROVIDER || ctx.model?.provider || "";
	let model = process.env.RLM_MODEL || ctx.model?.id || "";
	let thinkingLevel = process.env.RLM_THINKING_LEVEL || rootThinkingLevel || "";

	const depthModel = commaEntry(process.env.RLM_CHILD_MODELS, childDepth);
	const depthProvider = commaEntry(process.env.RLM_CHILD_PROVIDERS, childDepth);
	const depthThinking = commaEntry(process.env.RLM_CHILD_THINKING_LEVELS, childDepth);

	if (childDepth > 0) {
		if (depthModel) {
			model = depthModel;
		} else if (process.env.RLM_CHILD_MODEL) {
			model = process.env.RLM_CHILD_MODEL;
		}

		if (depthProvider) {
			provider = depthProvider;
		} else if (process.env.RLM_CHILD_PROVIDER && (depthModel || process.env.RLM_CHILD_MODEL)) {
			provider = process.env.RLM_CHILD_PROVIDER;
		}

		if (depthThinking) {
			thinkingLevel = depthThinking;
		} else if (process.env.RLM_CHILD_THINKING_LEVEL) {
			thinkingLevel = process.env.RLM_CHILD_THINKING_LEVEL;
		}
	}

	return { provider, model, thinkingLevel };
}

function sessionFile(ctx: ExtensionContext, depth: number, callCount: number): string | undefined {
	if (!sharedSessionsEnabled()) {
		return undefined;
	}
	const sessionDir = process.env.RLM_SESSION_DIR || (ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionDir() : "");
	if (!sessionDir) {
		return undefined;
	}
	mkdirSync(sessionDir, { recursive: true });
	return path.join(sessionDir, `${safeTraceId(process.env.RLM_TRACE_ID || "ypi")}_d${depth}_c${callCount}.jsonl`);
}

function copyForkSession(ctx: ExtensionContext, childSession: string | undefined, fork: boolean | undefined): void {
	const parentSession = ctx.sessionManager.getSessionFile();
	if (fork && childSession && parentSession && existsSync(parentSession)) {
		copyFileSync(parentSession, childSession);
	}
}

function childExtensionsEnabled(childDepth: number): boolean {
	let enabled = process.env.RLM_EXTENSIONS !== "0";
	if (childDepth > 0 && process.env.RLM_CHILD_EXTENSIONS) {
		enabled = process.env.RLM_CHILD_EXTENSIONS !== "0";
	}
	return enabled;
}

function removePathEntry(currentPath: string | undefined, entry: string): string | undefined {
	if (!currentPath) return currentPath;
	return currentPath.split(path.delimiter).filter((candidate) => candidate && candidate !== entry).join(path.delimiter);
}

const PROVIDER_ENV_ALLOWLIST = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	// Provider credentials that don't end in _API_KEY / _OAUTH_TOKEN (pi reads them by
	// these exact names; an env-var-only-authed parent must pass them to its children).
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"ANT_LING_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MOONSHOT_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_REGION",
	// Additional provider credentials/routing read by pi 0.79.4. Keep in sync with the shell
	// rlm_query allowlist and pi-mono; tests/test_provider_allowlist.sh enforces both.
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"OLLAMA_API_KEY",
	"PORTKEY_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AWS_DEFAULT_REGION",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_API_VERSION",
	"CLOUDFLARE_API_HOST",
	"CLOUDFLARE_AI_GATEWAY_HOST",
	"CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL",
	"CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL",
	"CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL",
	"CLOUDFLARE_WORKERS_AI_BASE_URL",
]);

function buildChildEnvironment(baseEnv: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv, runtime: YpiRuntime, childDepth: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME"]) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SHARE_VIEWER_URL"]) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of PROVIDER_ENV_ALLOWLIST) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const [key, value] of Object.entries(baseEnv)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE") {
			env[key] = value;
		}
	}
	Object.assign(env, overrides);

	if (childDepth >= maxDepth()) {
		env.PATH = removePathEntry(env.PATH, runtime.root);
	}
	if (!sharedSessionsEnabled()) {
		env.RLM_SESSION_DIR = "";
		env.RLM_SESSION_FILE = "";
	}
	return env;
}

function parsePiJsonOutput(stdout: string): ParsedJsonOutput {
	let text = "";
	let cost = 0;
	let tokens = 0;

	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				text += String(event.assistantMessageEvent.delta || "");
			}
			if (event.type === "turn_end") {
				const usage = event.message?.usage || {};
				cost += Number(usage.cost?.total || 0);
				tokens += Number(usage.totalTokens || 0);
			}
		} catch {
			// Ignore non-JSON chatter from extensions or wrappers.
		}
	}

	return { text, cost: { cost, tokens } };
}

function spawnChildPi(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutSeconds: number | undefined, signal?: AbortSignal): Promise<NativeRunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.env.YPI_PI_BIN || "pi", args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const killChild = (reason: "abort" | "timeout") => {
			if (reason === "timeout") {
				timedOut = true;
			}
			if (!child.pid) {
				child.kill("SIGTERM");
				return;
			}
			const target = process.platform === "win32" ? child.pid : -child.pid;
			try {
				process.kill(target, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			killTimer = setTimeout(() => {
				try {
					process.kill(target, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 1500);
		};
		const abortHandler = () => {
			killChild("abort");
		};
		const cleanupAbortHandler = () => {
			signal?.removeEventListener("abort", abortHandler);
			if (killTimer) clearTimeout(killTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};

		child.on("error", (error) => {
			cleanupAbortHandler();
			reject(error);
		});
		child.on("close", (code, childSignal) => {
			cleanupAbortHandler();
			resolve({ code: timedOut ? 124 : code ?? (childSignal ? 128 : 1), signal: childSignal, stdout, stderr, timedOut });
		});

		if (timeoutSeconds !== undefined) {
			timeoutTimer = setTimeout(() => killChild("timeout"), timeoutSeconds * 1000);
		}
		if (signal?.aborted) {
			abortHandler();
		} else {
			signal?.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

function cleanupTempFiles(paths: Array<string | undefined>): void {
	for (const filePath of paths) {
		if (filePath) {
			rmSync(path.dirname(filePath), { recursive: true, force: true });
		}
	}
}

export function registerNativeRlmQueryTool(pi: ExtensionAPI, runtime: YpiRuntime): void {
	const tool = defineTool({
		name: "rlm_query",
		label: "Recursive query",
		description: "Delegate a bounded task to a child Pi agent using ypi's native extension path. Does not require the ypi wrapper, shell helper, or jj.",
		promptSnippet: "Delegate a bounded task to a child Pi agent with a fresh context window.",
		promptGuidelines: [
			"Use rlm_query for clear subtasks that benefit from an extra context window.",
			"Pass exact source text through the context parameter when the child must inspect specific data.",
			"Do not recurse past the active RLM_MAX_DEPTH limit.",
		],
		parameters: RlmQueryParams,
		executionMode: "parallel" as const,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const depth = currentDepth();
			const childDepth = nextDepth();
			const limit = maxDepth();
			// Fail closed: a malformed depth config must not bypass the recursion limiter
			// (NaN comparisons would otherwise evaluate false and let the call through).
			if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(limit) || limit < 0) {
				throw new Error(`Invalid recursion depth config: RLM_DEPTH=${process.env.RLM_DEPTH ?? ""} RLM_MAX_DEPTH=${process.env.RLM_MAX_DEPTH ?? ""} (must be non-negative integers)`);
			}
			if (childDepth > limit) {
				throw new Error(`Max depth exceeded at ${depth}/${limit}`);
			}

			// Anchor the wall-clock timeout budget when a top-level tree begins so a long-running
			// root Pi process never inherits a stale start time. Children inherit it via the env.
			if (depth === 0) {
				process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000));
			}

			const callCount = await allocateCallCount();
			assertWithinMaxCalls(callCount);
			assertBudgetAvailable();
			const timeoutSeconds = assertTimeoutAvailable();
			const promptFile = createPromptFile(params.prompt);
			const contextFile = createContextFile(params);
			const { provider, model, thinkingLevel } = providerModel(ctx, childDepth, pi.getThinkingLevel());
			const childSession = sessionFile(ctx, childDepth, callCount);
			copyForkSession(ctx, childSession, params.fork);
			const workspace = maybeCreateJjWorkspace(ctx.cwd, childDepth);
			const env = buildChildEnvironment(process.env, {
				RLM_DEPTH: String(childDepth),
				RLM_MAX_DEPTH: String(limit),
				RLM_CALL_COUNT: String(callCount),
				RLM_PROVIDER: provider,
				RLM_MODEL: model,
				RLM_THINKING_LEVEL: thinkingLevel,
				RLM_SYSTEM_PROMPT: runtime.systemPromptPath,
				RLM_PROMPT_FILE: promptFile,
				RLM_SESSION_DIR: process.env.RLM_SESSION_DIR || "",
				RLM_SESSION_FILE: childSession || "",
				YPI_EXTENSION_ROOT: runtime.root,
				YPI_EXTENSION_PATH: runtime.extensionPath,
				YPI_RLM_QUERY_CALLER: "tool",
			}, runtime, childDepth);
			if (contextFile) {
				env.CONTEXT = contextFile;
			}

			const jsonMode = process.env.RLM_JSON !== "0";
			const args = jsonMode ? ["--mode", "json"] : ["-p"];
			if (provider) args.push("--provider", provider);
			if (model) args.push("--model", model);
			if (thinkingLevel) args.push("--thinking", thinkingLevel);
			if (workspace.readOnly) args.push("--tools", READ_ONLY_TOOLS);
			if (process.env.RLM_CHILD_DISCOVERY !== "1") {
				args.push("--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
			}
			args.push(childSession ? "--session" : "--no-session", childSession || "");
			if (!childSession) {
				args.pop();
			}
			if (!childExtensionsEnabled(childDepth)) {
				args.push("--no-extensions");
			} else if (existsSync(runtime.extensionPath)) {
				args.push("--no-extensions", "-e", runtime.extensionPath);
			}
			args.push(params.prompt);

			trace(`[${nowTraceTime()}] depth=${depth}→${childDepth} PID=${process.pid} call=${callCount} trace=${process.env.RLM_TRACE_ID || ""} caller=tool jj=${workspace.mode} prompt: ${params.prompt.slice(0, 120)}`);

			try {
				const started = Date.now();
				const result = await spawnChildPi(args, env, workspace.cwd, timeoutSeconds, signal);
				const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
				trace(`[${new Date().toISOString()}] depth=${depth} COMPLETED exit=${result.code} elapsed=${elapsed}s caller=tool`);
				const parsed = jsonMode ? parsePiJsonOutput(result.stdout) : undefined;
				if (parsed) {
					appendCostSummary(parsed.cost);
				}
				const stdout = parsed ? parsed.text : result.stdout;

				const text = truncate(result.stderr.trim()
					? `${stdout.trim()}\n\n[stderr]\n${result.stderr.trim()}`
					: stdout.trim());

				if (result.code !== 0) {
					const reason = result.timedOut ? `Child Pi timed out after ${timeoutSeconds}s` : `Child Pi exited with ${result.code}`;
					throw new Error(`${reason}${text ? `\n${text}` : ""}`);
				}

				return {
					content: [{ type: "text" as const, text }],
					details: {
						depth,
						childDepth,
						maxDepth: limit,
						callCount,
						caller: "tool",
						exitCode: result.code,
						signal: result.signal,
						jj: workspace.mode,
						readOnly: workspace.readOnly,
					},
				};
			} finally {
				workspace.cleanup();
				cleanupTempFiles([promptFile, contextFile]);
			}
		},
	});

	pi.registerTool(tool);
	debug("__YPI_NATIVE_TOOL_REGISTERED__ rlm_query");
	if (process.env.YPI_PI_BIN && !canExecute(process.env.YPI_PI_BIN)) {
		debug(`__YPI_NATIVE_PI_BIN_NOT_EXECUTABLE__ ${process.env.YPI_PI_BIN}`);
	}
}

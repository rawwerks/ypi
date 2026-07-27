import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment } from "../extensions/ypi/env.ts";
import recursiveExtension from "../extensions/recursive.ts";
import { registerNativeRlmQueryTool } from "../extensions/ypi/native-tool.ts";
import { buildYpiPrompt } from "../extensions/ypi/prompt.ts";
import { resolveRuntime } from "../extensions/ypi/runtime.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Observation = Record<string, string>;

const projectRoot = path.resolve(import.meta.dir, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_runtime_contract."));
const fakePi = path.join(scratch, "pi");
const logFile = path.join(scratch, "fake-pi.log");
const contextFile = path.join(scratch, "context.txt");
const staleRootPromptFile = path.join(scratch, "stale-root-prompt.txt");
const sessionDir = path.join(scratch, "sessions");
mkdirSync(sessionDir, { recursive: true });
writeFileSync(contextFile, "CONTRACT_CONTEXT");
writeFileSync(staleRootPromptFile, "STALE_ROOT_PROMPT");

let pass = 0;
let fail = 0;
let known = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function recordKnown(ok: boolean, label: string, detail: string): void {
	if (ok) {
		known++;
		console.log(`  ! KNOWN ${label}: ${detail}`);
	} else {
		fail++;
		console.error(`  ✗ known divergence changed: ${label}; update the contract classification`);
	}
}

function equal(label: string, left: unknown, right: unknown): void {
	record(left === right, label, `${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
}

function contains(label: string, value: string, expected: string): void {
	record(value.includes(expected), label, `expected ${JSON.stringify(expected)} in ${JSON.stringify(value)}`);
}

writeFileSync(fakePi, `#!/usr/bin/env bash
set -euo pipefail
SYSTEM_PROMPT_FILE=""
STDIN_CONTENT="$(cat)"
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "--system-prompt" ]; then
    j=$((i + 1))
    SYSTEM_PROMPT_FILE="\${!j}"
  fi
done
{
  printf 'ARGS='; printf '<%s>' "$@"; printf '\n'
  printf 'RLM_DEPTH=%s\n' "\${RLM_DEPTH:-unset}"
  printf 'RLM_MAX_DEPTH=%s\n' "\${RLM_MAX_DEPTH:-unset}"
  printf 'RLM_CALL_COUNT=%s\n' "\${RLM_CALL_COUNT:-unset}"
  printf 'RLM_PROVIDER=%s\n' "\${RLM_PROVIDER:-unset}"
  printf 'RLM_MODEL=%s\n' "\${RLM_MODEL:-unset}"
  printf 'RLM_THINKING_LEVEL=%s\n' "\${RLM_THINKING_LEVEL:-unset}"
  printf 'RLM_SESSION_FILE=%s\n' "\${RLM_SESSION_FILE:-unset}"
  printf 'RLM_SESSION_DIR=%s\n' "\${RLM_SESSION_DIR:-unset}"
  printf 'PROMPT_CONTENT=%s\n' "$(cat "\${RLM_PROMPT_FILE:-/dev/null}" 2>/dev/null || true)"
  printf 'STDIN_CONTENT=%s\n' "$STDIN_CONTENT"
  printf 'ROOT_PROMPT_CONTENT=%s\n' "$(cat "\${RLM_ROOT_PROMPT_FILE:-/dev/null}" 2>/dev/null || true)"
  printf 'CONTEXT_CONTENT=%s\n' "$(cat "\${CONTEXT:-/dev/null}" 2>/dev/null || true)"
  printf 'SYSTEM_PROMPT_CONTEXT=%s\n' "$(grep -F 'External task context:' "$SYSTEM_PROMPT_FILE" 2>/dev/null | head -1 || true)"
  printf 'SYSTEM_PROMPT_ROOT=%s\n' "$(grep -F 'Root task charter:' "$SYSTEM_PROMPT_FILE" 2>/dev/null | head -1 || true)"
} > "$YPI_FAKE_PI_LOG"
echo FAKE_CHILD_OK
`);
chmodSync(fakePi, 0o755);

// Do not let a parent ypi session's YPI_EXTENSION_ROOT redirect this harness
// away from the worktree under test.
process.env.YPI_EXTENSION_ROOT = projectRoot;
const runtime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
const configuredRoot = process.env.YPI_EXTENSION_ROOT;
const configuredPath = process.env.YPI_EXTENSION_PATH;
process.env.YPI_EXTENSION_ROOT = path.join(scratch, "stale-package");
process.env.YPI_EXTENSION_PATH = path.join(scratch, "stale-package", "extensions", "recursive.ts");
const explicitExtensionRuntime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
equal("explicit extension ignores mismatched ambient package root", explicitExtensionRuntime.root, projectRoot);
delete process.env.YPI_EXTENSION_PATH;
const rootOnlyRuntime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
equal("explicit extension ignores unbound ambient root hint", rootOnlyRuntime.root, projectRoot);
if (configuredRoot === undefined) delete process.env.YPI_EXTENSION_ROOT;
else process.env.YPI_EXTENSION_ROOT = configuredRoot;
if (configuredPath === undefined) delete process.env.YPI_EXTENSION_PATH;
else process.env.YPI_EXTENSION_PATH = configuredPath;
let nativeTool: Tool | undefined;
const pi = {
	registerTool(tool: Tool) {
		nativeTool = tool;
	},
	getThinkingLevel() {
		return "contract-thinking";
	},
	getAllTools() {
		return [
			{ name: "read" },
			{ name: "grep" },
			{ name: "find" },
			{ name: "ls" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "rlm_query" },
		];
	},
} as Pick<ExtensionAPI, "registerTool" | "getThinkingLevel" | "getAllTools"> as ExtensionAPI;

function extensionContext(): ExtensionContext {
	return {
		cwd: projectRoot,
		model: { provider: "contract-provider", id: "contract-model" },
		sessionManager: {
			getSessionFile: () => path.join(sessionDir, "parent.jsonl"),
			getSessionDir: () => sessionDir,
		},
	} as ExtensionContext;
}

function clearRuntimeEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE") {
			delete process.env[key];
		}
	}
}

function baseEnv(label: string): Record<string, string> {
	return {
		HOME: process.env.HOME || "",
		PATH: process.env.PATH || "",
		TMPDIR: scratch,
		YPI_PI_BIN: fakePi,
		YPI_FAKE_PI_LOG: logFile,
		YPI_EXTENSION_ROOT: projectRoot,
		YPI_EXTENSION_PATH: runtime.extensionPath,
			RLM_DEPTH: "0",
			RLM_MAX_DEPTH: "2",
			RLM_JSON: "0",
			RLM_SHARED_SESSIONS: "0",
		RLM_PROVIDER: "contract-provider",
		RLM_MODEL: "contract-model",
		RLM_THINKING_LEVEL: "contract-thinking",
		RLM_SYSTEM_PROMPT: runtime.systemPromptPath,
		RLM_TRACE_ID: `contract-${label}`,
		RLM_CALL_COUNTER_FILE: path.join(scratch, `${label}.counter`),
		CONTEXT: contextFile,
	};
}

function applyNativeEnv(env: Record<string, string>): void {
	clearRuntimeEnv();
	for (const [key, value] of Object.entries(env)) {
		process.env[key] = value;
	}
	writeFileSync(logFile, "");
	ensureEnvironment(runtime, extensionContext(), pi);
}

function parseObservation(): Observation {
	const result: Observation = {};
	for (const line of readFileSync(logFile, "utf8").split(/\r?\n/)) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator >= 0) result[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return result;
}

async function invokeNative(env: Record<string, string>, prompt: string, explicitContext?: string): Promise<{ observation?: Observation; error?: string }> {
	applyNativeEnv(env);
	try {
		if (!nativeTool) throw new Error("native rlm_query tool not registered");
		await nativeTool.execute("contract-call", { prompt, context: explicitContext }, undefined, undefined, extensionContext());
		return { observation: parseObservation() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

async function invokeCli(env: Record<string, string>, prompt: string): Promise<{ observation?: Observation; error?: string; code: number }> {
	writeFileSync(logFile, "");
	const child = Bun.spawn([path.join(projectRoot, "rlm_query"), prompt], {
		cwd: projectRoot,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return {
		observation: existsSync(logFile) && readFileSync(logFile, "utf8").trim() ? parseObservation() : undefined,
		error: stderr.trim() || undefined,
		code,
	};
}

function assertCommonObservation(native: Observation, cli: Observation): void {
	for (const key of [
		"RLM_DEPTH",
		"RLM_MAX_DEPTH",
		"RLM_CALL_COUNT",
		"RLM_PROVIDER",
		"RLM_MODEL",
		"RLM_THINKING_LEVEL",
		"PROMPT_CONTENT",
		"STDIN_CONTENT",
		"ROOT_PROMPT_CONTENT",
		"CONTEXT_CONTENT",
	]) {
		equal(`shared ${key}`, native[key], cli[key]);
	}
	contains("native disables shared sessions", native.ARGS, "<--no-session>");
	contains("CLI disables shared sessions", cli.ARGS, "<--no-session>");
	contains("native loads canonical extension", native.ARGS, `<${runtime.extensionPath}>`);
	contains("CLI loads canonical extension", cli.ARGS, `<${runtime.extensionPath}>`);
}

async function run(): Promise<void> {
	console.log("\n=== Recursion Runtime Contract Harness ===");
	clearRuntimeEnv();
	ensureEnvironment(runtime, extensionContext(), pi);
	equal("default max depth remains empirically bounded", process.env.RLM_MAX_DEPTH, "3");
	equal("default total call cap is bounded", process.env.RLM_MAX_CALLS, "128");
	registerNativeRlmQueryTool(pi, runtime);
	record(Boolean(nativeTool), "native adapter registered");
	const nativeAdapterSource = readFileSync(path.join(projectRoot, "extensions/ypi/native-tool.ts"), "utf8");
	const cliAdapterSource = readFileSync(path.join(projectRoot, "extensions/ypi/cli.ts"), "utf8");
	contains("native adapter depends on public runtime entrypoint", nativeAdapterSource, 'from "./runtime-core.ts"');
	record(!nativeAdapterSource.includes("./internal/"), "native adapter does not bypass runtime-core internals");
	contains("CLI adapter depends on public runtime entrypoint", cliAdapterSource, 'from "./runtime-core.ts"');
	record(!cliAdapterSource.includes("./internal/child-config") && !cliAdapterSource.includes("./internal/child-process") && !cliAdapterSource.includes("./internal/child-resources"), "CLI adapter does not bypass child-runtime internals");

	clearRuntimeEnv();
	process.env.YPI_SHELL_HELPER = "1";
	ensureEnvironment(runtime, extensionContext(), pi);
	const selfHostingPrompt = buildYpiPrompt(runtime);
	contains("wrapper prompt exposes canonical runtime section", selfHostingPrompt, "SECTION 6 - Canonical rlm_query Runtime Implementation");
	contains("wrapper prompt exposes runtime-core source", selfHostingPrompt, "export async function runRecursiveChild");
	contains("wrapper prompt exposes internal runtime owners", selfHostingPrompt, "// child-process.ts");
	contains("wrapper prompt exposes CLI adapter source", selfHostingPrompt, "export async function main");
	record(!selfHostingPrompt.includes("# rlm_query — Recursive Language Model sub-call for Pi."), "wrapper prompt embeds only the thin CLI launcher");
	process.env.CONTEXT = contextFile;
	process.env.RLM_PROMPT_FILE = staleRootPromptFile;
	const taskFilePrompt = buildYpiPrompt(runtime);
	contains("dynamic prompt exposes exact external context path", taskFilePrompt, `External task context: \`${contextFile}\``);
	contains("dynamic prompt prioritizes task context over persistent memory", taskFilePrompt, "Inspect it before using persistent memory");
	delete process.env.CONTEXT;
	delete process.env.RLM_PROMPT_FILE;

	const prompt = "CONTRACT_PROMPT";
	const nativeDefault = await invokeNative(baseEnv("native-default"), prompt, "CONTRACT_CONTEXT");
	const cliDefault = await invokeCli(baseEnv("cli-default"), prompt);
	record(!nativeDefault.error, "native default request succeeds", nativeDefault.error);
	record(cliDefault.code === 0, "CLI default request succeeds", cliDefault.error);
	if (nativeDefault.observation && cliDefault.observation) {
		assertCommonObservation(nativeDefault.observation, cliDefault.observation);
		equal("root delegation prompt falls back to delegated charter when no root capture exists", nativeDefault.observation.ROOT_PROMPT_CONTENT, prompt);
	} else {
		record(false, "both adapters emitted child observations");
	}

	const capturedRootNative = await invokeNative({ ...baseEnv("native-captured-root"), RLM_ROOT_PROMPT_FILE: staleRootPromptFile }, prompt);
	const capturedRootCli = await invokeCli({ ...baseEnv("cli-captured-root"), RLM_ROOT_PROMPT_FILE: staleRootPromptFile }, prompt);
	equal("native preserves captured human root charter", capturedRootNative.observation?.ROOT_PROMPT_CONTENT, "STALE_ROOT_PROMPT");
	equal("CLI preserves captured human root charter", capturedRootCli.observation?.ROOT_PROMPT_CONTENT, "STALE_ROOT_PROMPT");

	const routedNativeEnv = {
		...baseEnv("native-route"),
		RLM_DEPTH: "1",
		RLM_MAX_DEPTH: "3",
		RLM_CHILD_MODELS: "first-model,second-model",
		RLM_CHILD_PROVIDERS: "first-provider,second-provider",
		RLM_CHILD_THINKING_LEVELS: "low,high",
	};
	const routedCliEnv = {
		...baseEnv("cli-route"),
		RLM_DEPTH: "1",
		RLM_MAX_DEPTH: "3",
		RLM_CHILD_MODELS: "first-model,second-model",
		RLM_CHILD_PROVIDERS: "first-provider,second-provider",
		RLM_CHILD_THINKING_LEVELS: "low,high",
	};
	const routedNative = await invokeNative(routedNativeEnv, prompt, "CONTRACT_CONTEXT");
	const routedCli = await invokeCli(routedCliEnv, prompt);
	if (routedNative.observation && routedCli.observation) {
		for (const key of ["RLM_DEPTH", "RLM_PROVIDER", "RLM_MODEL", "RLM_THINKING_LEVEL"]) {
			equal(`depth-routed ${key}`, routedNative.observation[key], routedCli.observation[key]);
		}
		equal("second-depth model selected", routedNative.observation.RLM_MODEL, "second-model");
		equal("second-depth provider selected", routedNative.observation.RLM_PROVIDER, "second-provider");
		equal("second-depth thinking selected", routedNative.observation.RLM_THINKING_LEVEL, "high");
	} else {
		record(false, "both adapters emitted routed observations");
	}

	const malformedNative = await invokeNative({ ...baseEnv("native-malformed"), RLM_DEPTH: "0junk" }, prompt);
	const malformedCli = await invokeCli({ ...baseEnv("cli-malformed"), RLM_DEPTH: "0junk" }, prompt);
	record(
		Boolean(malformedNative.error?.includes("Invalid recursion depth config")) && malformedCli.code !== 0,
		"both adapters reject integer-prefix depth values",
		`native=${JSON.stringify(malformedNative.error)} CLI code=${malformedCli.code}`,
	);

	const reviewNative = await invokeNative(baseEnv("native-read-only"), prompt);
	const reviewCli = await invokeCli(baseEnv("cli-read-only"), prompt);
	record(
		!reviewNative.error
			&& reviewCli.code === 0
			&& reviewNative.observation?.ARGS.includes("<--exclude-tools><bash,edit,write>") === true
			&& reviewCli.observation?.ARGS.includes("<--exclude-tools><bash,edit,write>") === true,
		"both adapters choose read-only review without workspace setup",
		`native=${JSON.stringify(reviewNative.error)} CLI=${JSON.stringify(reviewCli.error)}`,
	);

	const extensionsOffNative = await invokeNative({ ...baseEnv("native-ext-off"), RLM_CHILD_EXTENSIONS: "0", RLM_ROOT_PROMPT_FILE: staleRootPromptFile }, prompt);
	const extensionsOffCli = await invokeCli({ ...baseEnv("cli-ext-off"), RLM_CHILD_EXTENSIONS: "0", RLM_ROOT_PROMPT_FILE: staleRootPromptFile }, prompt);
	if (extensionsOffNative.observation && extensionsOffCli.observation) {
		record(
			extensionsOffNative.observation.ARGS.includes("<--system-prompt>") && extensionsOffCli.observation.ARGS.includes("<--system-prompt>"),
			"both adapters retain a system prompt when extensions are disabled",
		);
		record(
			extensionsOffNative.observation.SYSTEM_PROMPT_CONTEXT?.includes("External task context: `") === true
				&& extensionsOffCli.observation.SYSTEM_PROMPT_CONTEXT?.includes("External task context: `") === true,
			"extension-disabled adapters project exact context paths into standalone prompts",
		);
		record(
			extensionsOffNative.observation.SYSTEM_PROMPT_ROOT?.includes(staleRootPromptFile) === true
				&& extensionsOffCli.observation.SYSTEM_PROMPT_ROOT?.includes(staleRootPromptFile) === true,
			"extension-disabled adapters preserve captured human root paths in standalone prompts",
		);
	} else {
		record(false, "both adapters emitted extensions-off observations");
	}

	const readOnlyNative = await invokeNative(baseEnv("native-readonly"), prompt);
	const readOnlyCli = await invokeCli(baseEnv("cli-readonly"), prompt);
	if (readOnlyNative.observation && readOnlyCli.observation) {
		record(
			readOnlyNative.observation.ARGS.includes("<--exclude-tools><bash,edit,write>")
				&& readOnlyCli.observation.ARGS.includes("<--exclude-tools><bash,edit,write>"),
			"both adapters exclude built-in mutators without a global tool allowlist",
		);
	} else {
		record(false, "both adapters emitted read-only observations");
	}

	for (const syntaxPrompt of ["--help", "@literal-file", "-short-option"]) {
		const syntaxNative = await invokeNative(baseEnv(`native-syntax-${syntaxPrompt}`), syntaxPrompt);
		const syntaxCli = await invokeCli(baseEnv(`cli-syntax-${syntaxPrompt}`), syntaxPrompt);
		record(!syntaxNative.error && syntaxCli.code === 0, `file-backed transport admits Pi-like prompt ${syntaxPrompt}`, syntaxNative.error || syntaxCli.error);
		equal(`native preserves Pi-like prompt ${syntaxPrompt}`, syntaxNative.observation?.PROMPT_CONTENT, syntaxPrompt);
		equal(`CLI preserves Pi-like prompt ${syntaxPrompt}`, syntaxCli.observation?.PROMPT_CONTENT, syntaxPrompt);
		equal(`native sends Pi-like prompt ${syntaxPrompt} through stdin`, syntaxNative.observation?.STDIN_CONTENT, syntaxPrompt);
		equal(`CLI sends Pi-like prompt ${syntaxPrompt} through stdin`, syntaxCli.observation?.STDIN_CONTENT, syntaxPrompt);
		record(
			syntaxNative.observation?.ARGS.includes(syntaxPrompt) !== true && syntaxCli.observation?.ARGS.includes(syntaxPrompt) !== true,
			`both adapters keep Pi-like prompt ${syntaxPrompt} out of argv`,
		);
	}

	clearRuntimeEnv();
	process.env.YPI_EXTENSION_ROOT = projectRoot;
	process.env.YPI_EXTENSION_PATH = runtime.extensionPath;
	process.env.RLM_DEPTH = "0";
	process.env.RLM_SHARED_SESSIONS = "1";
	const handlers = new Map<string, (...args: any[]) => any>();
	let firstRegistrations = 0;
	let duplicateRegistrations = 0;
	const lifecyclePi = (counter: () => void) => ({
		registerTool() { counter(); },
		on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); },
		getThinkingLevel() { return "medium"; },
		getAllTools() { return [{ name: "read" }, { name: "rlm_query" }]; },
	}) as unknown as ExtensionAPI;
	recursiveExtension(lifecyclePi(() => { firstRegistrations++; }));
	recursiveExtension(lifecyclePi(() => { duplicateRegistrations++; }));
	equal("only one recursive extension copy registers in a process", firstRegistrations, 1);
	equal("duplicate recursive extension copy stays inert", duplicateRegistrations, 0);
	const lifecycleContext = extensionContext();
	handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "ROOT HUMAN CHARTER",
		systemPrompt: "base",
		systemPromptOptions: { cwd: projectRoot },
	}, lifecycleContext);
	const capturedRootPrompt = process.env.RLM_ROOT_PROMPT_FILE;
	record(Boolean(capturedRootPrompt && existsSync(capturedRootPrompt)), "root prompt is captured before agent start");
	equal("extension context binds the current root session for shell --fork", process.env.RLM_SESSION_FILE, path.join(sessionDir, "parent.jsonl"));
	if (capturedRootPrompt) equal("captured root prompt is exact", readFileSync(capturedRootPrompt, "utf8"), "ROOT HUMAN CHARTER");
	handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, lifecycleContext);
	record(!capturedRootPrompt || !existsSync(capturedRootPrompt), "root prompt lease is removed at session shutdown");

	console.log(`\nResults: ${pass} passed, ${fail} failed, ${known} known divergences`);
	if (fail > 0) process.exitCode = 1;
}

try {
	await run();
} finally {
	clearRuntimeEnv();
	rmSync(scratch, { recursive: true, force: true });
}

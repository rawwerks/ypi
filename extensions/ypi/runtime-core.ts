import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	allocateCallCount,
	appendCostSummary,
	appendIncompleteCostMarker,
	assertTimeoutAvailable,
	assertWithinMaxCalls,
} from "./guardrails.ts";
import { currentDepth, maxDepth, nextDepth } from "./env.ts";
import {
	buildChildEnvironment,
	childExtensionsEnabled,
	IMPLEMENT_TOOL_ALLOWLIST,
	READ_ONLY_EXCLUDED_BUILTINS,
	resolveChildRoute,
	retainSelectedProviderEnvironment,
} from "./internal/child-config.ts";
import { formatCombinedChildOutput, normalizeChildOutput, type ChildToolActivity } from "./internal/child-output.ts";
import { runChildProcess } from "./internal/child-process.ts";
import { acquireChildResources } from "./internal/child-resources.ts";
import { normalizeImplementScope } from "./internal/implement-scope.ts";
import {
	WorkspaceFinalizationError,
	type ChildMode,
	type WorkspaceReport,
} from "./internal/workspace-policy.ts";
import type { YpiRuntime } from "./runtime.ts";
export type { ChildToolActivity } from "./internal/child-output.ts";

export interface ParentRuntimeContext {
	cwd: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sessionFile?: string;
	sessionDir?: string;
}

export interface RecursiveChildRequest {
	prompt: string;
	context?: string;
	contextPath?: string;
	fork?: boolean;
	caller: "tool" | "cli";
	parent: ParentRuntimeContext;
	// undefined uses the canonical extension; null intentionally selects the
	// standalone system-prompt path (CLI compatibility mode).
	extensionPath?: string | null;
	treeStartTimeSeconds?: number;
	onText?: (text: string) => boolean | void;
	onToolActivity?: (activity: ChildToolActivity) => void;
	onTextDrain?: () => Promise<void>;
	onAdmitted?: (callCount: number) => void;
	onChildSpawn?: (pid: number) => void;
	signal?: AbortSignal;
	mode?: ChildMode;
	scope?: string[];
}

export interface RecursiveChildDetails {
	implementation: "canonical";
	depth: number;
	childDepth: number;
	maxDepth: number;
	callCount: number;
	caller: "tool" | "cli";
	exitCode: number;
	signal: NodeJS.Signals | null;
	readOnly: boolean;
	requestedMode: ChildMode;
	workspace: WorkspaceReport;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	textTruncated: boolean;
	jsonEventTruncated: boolean;
	jsonCostIncomplete: boolean;
	cancelled: boolean;
}

export interface RecursiveChildResult {
	text: string;
	stderr: string;
	warnings: string[];
	details: RecursiveChildDetails;
}

export class RecursiveChildError extends Error {
	readonly exitCode: number;
	readonly details?: RecursiveChildDetails;

	constructor(message: string, exitCode: number, details?: RecursiveChildDetails) {
		super(message);
		this.name = "RecursiveChildError";
		this.exitCode = exitCode;
		this.details = details;
	}
}

function nowTraceTime(): string {
	const d = new Date();
	return d.toTimeString().slice(0, 8) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function trace(message: string): void {
	if (!process.env.PI_TRACE_FILE) return;
	try {
		writeFileSync(process.env.PI_TRACE_FILE, `${message}\n`, { flag: "a" });
	} catch {
		delete process.env.PI_TRACE_FILE;
	}
}

export function appendRuntimeTrace(event: string): void {
	trace(`[${new Date().toISOString()}] ${event}`);
}

function timeoutOrThrow(): number | undefined {
	try {
		return assertTimeoutAvailable();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new RecursiveChildError(message, message.startsWith("Invalid ") ? 1 : 124);
	}
}

export async function runRecursiveChild(runtime: YpiRuntime, request: RecursiveChildRequest): Promise<RecursiveChildResult> {
	if (request.signal?.aborted) throw new RecursiveChildError("Child Pi cancelled before admission", 130);
	const depth = currentDepth();
	const childDepth = nextDepth();
	const limit = maxDepth();
	if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(limit) || limit < 0) {
		throw new RecursiveChildError(`Invalid recursion depth config: RLM_DEPTH=${process.env.RLM_DEPTH ?? ""} RLM_MAX_DEPTH=${process.env.RLM_MAX_DEPTH ?? ""} (must be non-negative integers)`, 1);
	}
	if (childDepth > limit) throw new RecursiveChildError(`Max depth exceeded at ${depth}/${limit}`, 1);
	const requestedMode = request.mode ?? "review";
	let implementScope: string[] | undefined;
	if (requestedMode === "implement") {
		try {
			implementScope = normalizeImplementScope(request.scope);
		} catch (error) {
			throw new RecursiveChildError(error instanceof Error ? error.message : String(error), 1);
		}
	} else if (request.scope !== undefined) {
		throw new RecursiveChildError("Implement scope is valid only with mode=implement", 1);
	}
	if (requestedMode === "implement" && (depth > 0 || process.env.RLM_WRITE_MODE_CEILING === "review")) {
		throw new RecursiveChildError("Writable recursion is root-only and cannot be escalated by a child. Continue implementation in the current agent or delegate a read-only review.", 1);
	}
	if (depth === 0) process.env.RLM_START_TIME = String(request.treeStartTimeSeconds ?? Math.floor(Date.now() / 1000));

	const counterRemainingSeconds = timeoutOrThrow();
	const counterDeadlineMilliseconds = counterRemainingSeconds === undefined ? undefined : Date.now() + counterRemainingSeconds * 1000;
	assertWithinMaxCalls(0);
	const callCount = await allocateCallCount(counterDeadlineMilliseconds);
	assertWithinMaxCalls(callCount);
	const setupRemainingSeconds = timeoutOrThrow();
	// Implementer confinement is enforced by the exact canonical extension and
	// cannot be disabled by a review-oriented child-extension override.
	const extensionsEnabled = requestedMode === "implement" ? true : childExtensionsEnabled(childDepth);
	const fullResourceIsolation = !extensionsEnabled && process.env.RLM_CHILD_DISCOVERY === "0";
	const { provider, model, thinkingLevel } = resolveChildRoute(request.parent, childDepth);
	const resources = acquireChildResources({
		prompt: request.prompt,
		context: request.context,
		contextPath: request.contextPath,
		fork: request.fork,
		cwd: request.parent.cwd,
		parentSessionFile: request.parent.sessionFile,
		parentSessionDir: request.parent.sessionDir,
		childDepth,
		callCount,
		systemPromptPath: runtime.systemPromptPath,
		rootPromptPath: process.env.RLM_ROOT_PROMPT_FILE,
		setupDeadlineMilliseconds: setupRemainingSeconds === undefined ? undefined : Date.now() + setupRemainingSeconds * 1000,
		fullResourceIsolation,
		selectedProvider: provider,
		mode: requestedMode,
		scope: implementScope,
	});

	let workspace: WorkspaceReport | undefined;
	try {
		if (request.signal?.aborted) throw new RecursiveChildError("Child Pi cancelled during admission before work started", 130);
		const extensionPath = request.extensionPath === null ? "" : request.extensionPath || runtime.extensionPath;
		if (requestedMode === "implement" && (!extensionPath || !existsSync(extensionPath))) {
			throw new RecursiveChildError("Implement mode requires the exact canonical ypi extension so checkout write confinement cannot be bypassed. Continue implementation in the root session.", 1);
		}
		const env = buildChildEnvironment(process.env, {
			RLM_DEPTH: String(childDepth),
			RLM_MAX_DEPTH: String(limit),
			RLM_CALL_COUNT: String(callCount),
			RLM_PROVIDER: provider,
			RLM_MODEL: model,
			RLM_THINKING_LEVEL: thinkingLevel,
			RLM_SYSTEM_PROMPT: runtime.systemPromptPath,
			RLM_PROMPT_FILE: resources.promptFile,
			RLM_ROOT_PROMPT_FILE: process.env.RLM_ROOT_PROMPT_FILE || resources.promptFile,
			RLM_SESSION_DIR: process.env.RLM_SESSION_DIR || "",
			RLM_SESSION_FILE: resources.childSession || "",
			YPI_EXTENSION_ROOT: runtime.root,
			YPI_EXTENSION_PATH: extensionPath,
			YPI_RLM_QUERY_CALLER: request.caller,
			YPI_IMPLEMENT_ROOT: "",
			YPI_IMPLEMENT_AUDIT_FILE: "",
			YPI_IMPLEMENT_BASELINE_IGNORE_ROOT: "",
			YPI_IMPLEMENT_BASELINE_INDEX: "",
			YPI_IMPLEMENT_GIT_DIR: "",
			YPI_IMPLEMENT_SCOPE_FILE: "",
			YPI_IMPLEMENT_SUBMODULES_FILE: "",
			...resources.workspace.childEnvironment,
			RLM_WRITE_MODE_CEILING: "review",
			...(requestedMode === "implement" ? { RLM_AMBIENT_EXTENSIONS: "0" } : {}),
		}, runtime, childDepth);
		if (fullResourceIsolation) retainSelectedProviderEnvironment(env, provider);
		if (resources.contextFile) env.CONTEXT = resources.contextFile;
		if (resources.isolatedPiRoot) {
			env.PI_CODING_AGENT_DIR = path.join(resources.isolatedPiRoot, "agent");
			// PI_PACKAGE_DIR identifies Pi's own shipped assets, not user package
			// state. Preserve it so the pinned executable retains its real version;
			// installed package config is isolated by PI_CODING_AGENT_DIR.
			env.PI_OFFLINE = "1";
		}

		const jsonMode = process.env.RLM_JSON !== "0";
		const args = jsonMode ? ["--mode", "json"] : ["-p"];
		if (provider) args.push("--provider", provider);
		if (model) args.push("--model", model);
		if (thinkingLevel) args.push("--thinking", thinkingLevel);
		if (resources.workspace.readOnly) args.push("--exclude-tools", READ_ONLY_EXCLUDED_BUILTINS.join(","));
		else if (requestedMode === "implement") args.push("--tools", IMPLEMENT_TOOL_ALLOWLIST.join(","));
		if (process.env.RLM_CHILD_DISCOVERY === "0") args.push("--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
		if (resources.childSession) args.push("--session", resources.childSession);
		else args.push("--no-session");
		// Pi cannot unregister an older ambient ypi copy. Load only the exact
		// canonical child extension by default; ambient extension discovery is an
		// explicit compatibility opt-in for callers that accept version conflicts.
		if (requestedMode === "implement" || !extensionsEnabled || process.env.RLM_AMBIENT_EXTENSIONS !== "1") args.push("--no-extensions");
		if (extensionsEnabled && extensionPath && existsSync(extensionPath)) args.push("-e", extensionPath);
		else if (resources.standaloneSystemPromptFile) args.push("--system-prompt", resources.standaloneSystemPromptFile);

		const timeoutSeconds = timeoutOrThrow();
		request.onAdmitted?.(callCount);
		trace(`[${nowTraceTime()}] depth=${depth}→${childDepth} PID=${process.pid} call=${callCount} trace=${process.env.RLM_TRACE_ID || ""} caller=${request.caller} fork=${request.fork === true} mode=${requestedMode} workspace=${resources.workspace.mode}`);
		const started = Date.now();
		resources.workspace.prepareChildLaunch();
		const processResult = await runChildProcess({
			args,
			env,
			cwd: resources.workspace.cwd,
			timeoutSeconds,
			signal: request.signal,
			jsonMode,
			stdinText: request.prompt,
			onText: request.onText,
			onToolActivity: request.onToolActivity,
			onTextDrain: request.onTextDrain,
			onSpawn(pid) {
				try {
					resources.workspace.noteChildPid(pid);
				} catch (error) {
					try {
						if (process.platform === "win32") process.kill(pid, "SIGKILL");
						else process.kill(-pid, "SIGKILL");
					} catch {
						// The child may already have exited.
					}
					throw error;
				}
				request.onChildSpawn?.(pid);
			},
			quiesceProcessGroup: resources.workspace.quiesceProcessGroup,
			...(resources.workspace.childLaunchGate
				? {
					launchGate: {
						launcherPath: path.join(runtime.root, "scripts", "launch-implementer-child.ts"),
						...resources.workspace.childLaunchGate,
					},
				}
				: {}),
		});
		const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
		const output = normalizeChildOutput(processResult);
		if (jsonMode && (!output.cost || processResult.cancelled || processResult.timedOut)) {
			processResult.jsonCostIncomplete = true;
		}
		if (output.cost) appendCostSummary(output.cost);
		if (processResult.jsonCostIncomplete) {
			appendIncompleteCostMarker("child ended without a complete final cost boundary");
		}
		workspace = resources.workspace.finalize();
		trace(`[${new Date().toISOString()}] depth=${depth} child_depth=${childDepth} COMPLETED exit=${processResult.code} elapsed=${elapsed}s caller=${request.caller} call=${callCount} cost=${processResult.jsonCostIncomplete ? "incomplete" : output.cost?.cost ?? "untracked"} tokens=${processResult.jsonCostIncomplete ? "incomplete" : output.cost?.tokens ?? "untracked"} cancelled=${processResult.cancelled} timeout=${processResult.timedOut} truncated=${processResult.textTruncated || processResult.jsonEventTruncated} changed_paths=${workspace.changedPaths.length}`);
		const details: RecursiveChildDetails = {
			implementation: "canonical",
			depth,
			childDepth,
			maxDepth: limit,
			callCount,
			caller: request.caller,
			exitCode: processResult.code,
			signal: processResult.signal,
			readOnly: resources.workspace.readOnly,
			requestedMode,
			workspace,
			stdoutTruncated: processResult.stdoutTruncated,
			stderrTruncated: processResult.stderrTruncated,
			textTruncated: processResult.textTruncated,
			jsonEventTruncated: processResult.jsonEventTruncated,
			jsonCostIncomplete: processResult.jsonCostIncomplete,
			cancelled: processResult.cancelled,
		};
		if (processResult.code !== 0) {
			const reason = processResult.cancelled
				? "Child Pi cancelled"
				: processResult.timedOut
					? `Child Pi timed out after ${timeoutSeconds}s`
					: `Child Pi exited with ${processResult.code}`;
			const childOutput = formatCombinedChildOutput(output);
			const workspaceOutput = requestedMode === "implement" ? formatWorkspaceReport(workspace) : "";
			throw new RecursiveChildError(`${reason}${childOutput ? `\n${childOutput}` : ""}${workspaceOutput ? `\n\n${workspaceOutput}` : ""}`, processResult.code, details);
		}
		return { text: output.text, stderr: output.stderr, warnings: output.warnings, details };
	} catch (error) {
		if (!workspace) {
			try {
				workspace = resources.workspace.finalize();
			} catch (finalizationError) {
				if (finalizationError instanceof WorkspaceFinalizationError) {
					const original = error === finalizationError
						? ""
						: `Original child error: ${error instanceof Error ? error.message : String(error)}\n\n`;
					const report = formatWorkspaceReport(finalizationError.report);
					const exitCode = error instanceof RecursiveChildError ? error.exitCode : 1;
					throw new RecursiveChildError(`${original}${finalizationError.message}\n\n${report}`, exitCode);
				}
				throw finalizationError;
			}
		}
		if (requestedMode === "implement" && workspace) {
			const report = formatWorkspaceReport(workspace);
			if (error instanceof RecursiveChildError) {
				if (error.details) throw error;
				throw new RecursiveChildError(`${error.message}\n\n${report}`, error.exitCode);
			}
			throw new RecursiveChildError(
				`${error instanceof Error ? error.message : String(error)}\n\n${report}`,
				(error as Error & { exitCode?: number }).exitCode || 1,
			);
		}
		throw error;
	} finally {
		resources.cleanup();
	}
}

function displayPath(value: string): string {
	return value.replace(/[\r\n\t\0]/g, "?").slice(0, 240);
}

function formatWorkspaceReport(report: WorkspaceReport): string {
	const paths = report.changedPaths.slice(0, 20).map(displayPath);
	return [
		`[implementer workspace: ${report.workspaceMode}; report: ${report.reportComplete ? "complete" : "incomplete"}]`,
		paths.length > 0 ? `Changed paths (${report.changedPaths.length}): ${paths.join(", ")}${report.changedPaths.length > paths.length ? ", …" : ""}` : "Changed paths: none",
		...(report.baselineHead ? [`Baseline: ${displayPath(report.baselineHead)}`] : []),
		...(report.finalHead ? [`Final state: ${displayPath(report.finalHead)}`] : []),
		...(report.attemptRef ? [`Attempt ref: ${displayPath(report.attemptRef)}`] : []),
		...(report.attemptCommit ? [`Attempt commit: ${displayPath(report.attemptCommit)}`] : []),
		...(report.scope ? [`Declared scope: ${report.scope.map(displayPath).join(", ")}`] : []),
		...(report.diffStat ? [`Diffstat:\n${report.diffStat}`] : []),
		...(report.treeRestored !== undefined ? [`Ephemeral worktree removed: ${report.treeRestored ? "yes" : "no"}`] : []),
		...(!report.reportComplete && report.reportError ? [`Workspace report warning: ${report.reportError}`] : []),
	].join("\n");
}

export function formatRecursiveResultForTool(result: RecursiveChildResult): string {
	const output = formatCombinedChildOutput({ text: result.text, stderr: result.stderr, warnings: result.warnings });
	if (result.details.requestedMode !== "implement") return output;
	const suffix = formatWorkspaceReport(result.details.workspace);
	return `${output}${output ? "\n\n" : ""}${suffix}`;
}

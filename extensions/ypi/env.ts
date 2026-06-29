import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

export function currentDepth(): number {
	return Number.parseInt(process.env.RLM_DEPTH || "0", 10);
}

export function maxDepth(): number {
	return Number.parseInt(process.env.RLM_MAX_DEPTH || "3", 10);
}

export function nextDepth(): number {
	return currentDepth() + 1;
}

export function currentCallCount(): number {
	return Number.parseInt(process.env.RLM_CALL_COUNT || "0", 10);
}

export function shouldExposeRecursion(): boolean {
	return currentDepth() < maxDepth();
}

function prependPath(dir: string): void {
	const current = process.env.PATH || "";
	const entries = current.split(path.delimiter).filter(Boolean);
	if (!entries.includes(dir)) {
		process.env.PATH = [dir, ...entries].join(path.delimiter);
	}
}

export function sharedSessionsEnabled(): boolean {
	return process.env.RLM_SHARED_SESSIONS !== "0";
}

// The shell-compatible rlm_query helper (PATH entry + full source in the prompt) is
// convenience glue owned by the ypi wrapper. A bare `pi -e` / npm extension install
// defaults to the native rlm_query tool only; the wrapper opts in with YPI_SHELL_HELPER=1.
export function shellHelperEnabled(runtime: YpiRuntime): boolean {
	return process.env.YPI_SHELL_HELPER === "1" && existsSync(runtime.rlmQueryPath);
}

// Trace IDs flow into temp filenames and session-log filenames, so strip anything that
// could escape the intended directory before the value is used as a path component.
export function safeTraceId(traceId: string): string {
	return traceId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureCallCounterFile(): void {
	if (process.env.RLM_CALL_COUNTER_FILE) {
		return;
	}
	process.env.RLM_CALL_COUNTER_FILE = path.join(tmpdir(), `rlm_calls_${process.env.RLM_TRACE_ID}.counter`);
}

function ensureCostFile(): void {
	if (!process.env.RLM_BUDGET || process.env.RLM_COST_FILE) {
		return;
	}
	process.env.RLM_COST_FILE = path.join(tmpdir(), `rlm_cost_${process.env.RLM_TRACE_ID}.jsonl`);
}

export function ensureEnvironment(runtime: YpiRuntime, ctx?: ExtensionContext, pi?: ExtensionAPI): void {
	process.env.RLM_DEPTH = process.env.RLM_DEPTH || "0";
	process.env.RLM_MAX_DEPTH = process.env.RLM_MAX_DEPTH || "3";
	process.env.RLM_SYSTEM_PROMPT = process.env.RLM_SYSTEM_PROMPT || runtime.systemPromptPath;
	process.env.RLM_JJ = process.env.RLM_JJ || "1";
	process.env.RLM_EXTENSIONS = process.env.RLM_EXTENSIONS || "1";
	process.env.RLM_JSON = process.env.RLM_JSON || "1";
	process.env.RLM_SHARED_SESSIONS = process.env.RLM_SHARED_SESSIONS || "1";
	process.env.RLM_TRACE_ID = safeTraceId(process.env.RLM_TRACE_ID || randomBytes(4).toString("hex"));
	// RLM_START_TIME anchors the wall-clock timeout budget at the moment a recursion tree
	// begins, not at extension load. Seeding it here would freeze a long-running root Pi's
	// budget at session start; the native tool and shell rlm_query set it at the depth-0 call.
	process.env.YPI_EXTENSION_ROOT = runtime.root;
	process.env.YPI_EXTENSION_PATH = process.env.YPI_EXTENSION_PATH || runtime.extensionPath;
	ensureCallCounterFile();
	ensureCostFile();

	if (shouldExposeRecursion() && shellHelperEnabled(runtime)) {
		prependPath(runtime.root);
	}

	if (ctx?.sessionManager.getSessionFile() && sharedSessionsEnabled() && !process.env.RLM_SESSION_DIR) {
		process.env.RLM_SESSION_DIR = ctx.sessionManager.getSessionDir();
	}
	if (process.env.RLM_SESSION_DIR && sharedSessionsEnabled()) {
		mkdirSync(process.env.RLM_SESSION_DIR, { recursive: true });
	}

	if (ctx?.model) {
		// Pi's active root route is the source of truth. Refresh these on every
		// contextual environment pass so `/model` and thinking-level changes are
		// picked up by subsequent recursive children. Use RLM_CHILD_* for child-only
		// overrides instead of pinning stale root values here.
		process.env.RLM_PROVIDER = ctx.model.provider;
		process.env.RLM_MODEL = ctx.model.id;
		if (pi) {
			process.env.RLM_THINKING_LEVEL = pi.getThinkingLevel();
		}
		debug(`__YPI_EXTENSION_MODEL__ ${process.env.RLM_PROVIDER}/${process.env.RLM_MODEL}:${process.env.RLM_THINKING_LEVEL || ""}`);
	}
}

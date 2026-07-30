import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_CONCURRENT_CALLS } from "./internal/concurrency.ts";
import {
	createPrivateTempDirectory,
	ensurePrivateAppendFile,
	withPrivateUmask,
} from "./internal/private-path.ts";
import { ensureRootTreeCoordinator } from "./internal/tree-coordinator.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_CALLS = 65_536;

function exactNonNegativeInteger(value: string | undefined, fallback: string): number {
	const raw = value ?? fallback;
	if (!/^\d+$/.test(raw)) return Number.NaN;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export function currentDepth(): number {
	return exactNonNegativeInteger(process.env.RLM_DEPTH, "0");
}

export function maxDepth(): number {
	return exactNonNegativeInteger(process.env.RLM_MAX_DEPTH, String(DEFAULT_MAX_DEPTH));
}

export function nextDepth(): number {
	return currentDepth() + 1;
}

export function currentCallCount(): number {
	return Number.parseInt(process.env.RLM_CALL_COUNT || "0", 10);
}

export function shouldExposeRecursion(): boolean {
	const depth = currentDepth();
	const limit = maxDepth();
	// Keep the tool visible for malformed configuration so invoking it produces
	// the explicit fail-closed error instead of silently hiding recursion.
	if (!Number.isInteger(depth) || !Number.isInteger(limit)) return true;
	return depth < limit;
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

// The shell-compatible rlm_query helper (PATH entry plus canonical runtime and
// adapter source in the prompt) is convenience glue owned by the ypi wrapper.
// Direct `pi -e ./extensions/recursive.ts` use defaults to the native
// rlm_query tool only; the wrapper opts in with YPI_SHELL_HELPER=1.
export function shellHelperEnabled(runtime: YpiRuntime): boolean {
	return process.env.YPI_SHELL_HELPER === "1" && existsSync(runtime.rlmQueryPath);
}

// Trace IDs flow into temp filenames and session-log filenames, so strip anything that
// could escape the intended directory before the value is used as a path component.
export function safeTraceId(traceId: string): string {
	const sanitized = traceId.replace(/[^a-zA-Z0-9._-]/g, "_");
	if (sanitized === traceId && traceId.length <= 64) return traceId;
	const digest = createHash("sha256").update(traceId).digest("hex").slice(0, 32);
	return `${sanitized.slice(0, 31).padEnd(31, "_")}-${digest}`;
}

function ensurePiExecutable(runtime: YpiRuntime): void {
	if (process.env.YPI_PI_BIN) return;
	const candidate = path.join(runtime.root, "node_modules", ".bin", "pi");
	try {
		accessSync(candidate, constants.X_OK);
		process.env.YPI_PI_BIN = candidate;
	} catch {
		// Source distributions may intentionally rely on a compatible Pi on PATH.
	}
}

function ensureRuntimeStatePaths(): void {
	const missing = [
		"RLM_CALL_COUNTER_FILE",
		"RLM_CONCURRENCY_DIR",
		"PI_TRACE_FILE",
		"RLM_COST_FILE",
	].some((variable) => !process.env[variable]);
	if (!missing) return;

	const stateLabel = createHash("sha256")
		.update(process.env.RLM_TRACE_ID || "ypi")
		.digest("hex")
		.slice(0, 8);
	const stateRoot = createPrivateTempDirectory(path.join(
		tmpdir(),
		`ypi_runtime_${stateLabel}_`,
	));
	process.env.RLM_CALL_COUNTER_FILE ||= path.join(stateRoot, "calls.counter");
	process.env.RLM_CONCURRENCY_DIR ||= path.join(stateRoot, "concurrency");
	process.env.PI_TRACE_FILE ||= path.join(stateRoot, "trace.jsonl");
	process.env.RLM_COST_FILE ||= path.join(stateRoot, "cost.jsonl");
}

function ensurePrivateTelemetryFile(variable: "PI_TRACE_FILE" | "RLM_COST_FILE"): void {
	const filePath = process.env[variable];
	if (!filePath) return;
	const identityVariable = variable === "PI_TRACE_FILE"
		? "YPI_TRACE_FILE_IDENTITY"
		: "YPI_COST_FILE_IDENTITY";
	try {
		process.env[identityVariable] = JSON.stringify(ensurePrivateAppendFile(filePath));
	} catch {
		// Telemetry is observational. An unwritable or invalid sink must never
		// prevent product work from starting.
		delete process.env[variable];
		delete process.env[identityVariable];
	}
}

export function ensureEnvironment(runtime: YpiRuntime, ctx?: ExtensionContext, pi?: ExtensionAPI): void {
	process.env.YPI_NODE_BIN ||= process.execPath;
	ensurePiExecutable(runtime);
	process.env.RLM_DEPTH = process.env.RLM_DEPTH || "0";
	process.env.RLM_MAX_DEPTH = process.env.RLM_MAX_DEPTH || String(DEFAULT_MAX_DEPTH);
	process.env.RLM_MAX_CALLS = process.env.RLM_MAX_CALLS || String(DEFAULT_MAX_CALLS);
	process.env.RLM_MAX_CONCURRENT_CALLS = process.env.RLM_MAX_CONCURRENT_CALLS
		|| String(DEFAULT_MAX_CONCURRENT_CALLS);
	process.env.RLM_SYSTEM_PROMPT = process.env.RLM_SYSTEM_PROMPT || runtime.systemPromptPath;
	process.env.RLM_EXTENSIONS = process.env.RLM_EXTENSIONS || "1";
	process.env.RLM_JSON = process.env.RLM_JSON || "1";
	process.env.RLM_REQUIRE_TRANSCRIPTS = process.env.RLM_REQUIRE_TRANSCRIPTS || "0";
	process.env.RLM_SHARED_SESSIONS = process.env.RLM_SHARED_SESSIONS || "1";
	process.env.RLM_TRACE_ID = safeTraceId(process.env.RLM_TRACE_ID || randomBytes(4).toString("hex"));
	// Dollar caps are deliberately unsupported. Cost remains observable telemetry,
	// never an admission or termination condition.
	delete process.env.RLM_BUDGET;
	// RLM_START_TIME anchors the wall-clock timeout budget at the moment a recursion tree
	// begins, not at extension load. Seeding it here would freeze a long-running root Pi's
	// budget at session start; the native tool and shell rlm_query set it at the depth-0 call.
	process.env.YPI_EXTENSION_ROOT = runtime.root;
	process.env.YPI_EXTENSION_PATH = runtime.extensionPath;
	ensureRuntimeStatePaths();
	ensurePrivateTelemetryFile("PI_TRACE_FILE");
	ensurePrivateTelemetryFile("RLM_COST_FILE");
	ensureRootTreeCoordinator();

	if (shouldExposeRecursion() && shellHelperEnabled(runtime)) {
		prependPath(runtime.root);
	}

	if (ctx && sharedSessionsEnabled()) {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			process.env.RLM_SESSION_FILE = sessionFile;
			process.env.RLM_SESSION_DIR = ctx.sessionManager.getSessionDir();
		} else if (process.env.RLM_DEPTH === "0") {
			delete process.env.RLM_SESSION_FILE;
			delete process.env.RLM_SESSION_DIR;
		}
	}
	if (process.env.RLM_SESSION_DIR && sharedSessionsEnabled()) {
		withPrivateUmask(() => mkdirSync(process.env.RLM_SESSION_DIR!, {
			recursive: true,
			mode: 0o700,
		}));
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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment } from "../extensions/ypi/env.ts";
import { acquireConcurrencySlot } from "../extensions/ypi/internal/concurrency.ts";
import { registerNativeRlmQueryTool } from "../extensions/ypi/native-tool.ts";
import { resolveRuntime } from "../extensions/ypi/runtime.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

const projectRoot = path.resolve(import.meta.dir, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_native_tool_test."));
const fakePi = path.join(scratch, "pi");
const logFile = path.join(scratch, "fake-pi.log");
const sessionDir = path.join(scratch, "sessions");
mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
chmodSync(sessionDir, 0o700);

let pass = 0;
let fail = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function assertContains(label: string, haystack: string, needle: string): void {
	record(haystack.includes(needle), label, `expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 500))}`);
}

function assertNotContains(label: string, haystack: string, needle: string): void {
	record(!haystack.includes(needle), label, `did not expect ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 500))}`);
}

// The harness may itself run inside a git hook (pre-push), which exports
// GIT_DIR/GIT_WORK_TREE into the environment. Inherited values would redirect
// fixture `git init/add/commit` at the PARENT repository — committing test
// fixtures onto the real branch. Under Bun, deleting from process.env does NOT
// propagate to implicitly inherited child environments, so every fixture git
// spawn passes a scrubbed environment explicitly. N5a2 poisons GIT_* on
// purpose to prove the runtime-level scrub in workspace-policy.
function fixtureGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	return env;
}

function clearYpiEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("YPI_") || key === "CONTEXT" || key === "PI_TRACE_FILE" || key === "PI_CODING_AGENT_DIR" || key === "ANTHROPIC_API_KEY" || key === "OPENAI_API_KEY" || key === "SECRET_TOKEN" || key.startsWith("GIT_")) {
			delete process.env[key];
		}
	}
	process.env.TMPDIR = scratch;
	process.env.YPI_PI_BIN = fakePi;
	process.env.YPI_FAKE_PI_LOG = logFile;
}

function resetLog(): void {
	writeFileSync(logFile, "");
}

function readLog(): string {
	return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
}

writeFileSync(fakePi, `#!/usr/bin/env bash
SYSTEM_PROMPT_FILE=""
for ((i=1; i<=$#; i++)); do
  if [ "\${!i}" = "--system-prompt" ]; then
    j=$((i + 1))
    SYSTEM_PROMPT_FILE="\${!j}"
  fi
done
if [ -n "\${YPI_IMPLEMENT_CONFINEMENT_FILE:-}" ]; then
  YPI_IMPLEMENT_SCOPE_FILE="$(dirname "$YPI_IMPLEMENT_CONFINEMENT_FILE")/scope"
fi
{
  echo "ARGS: $*"
  echo "RLM_DEPTH=$RLM_DEPTH"
  echo "RLM_MODEL=$RLM_MODEL"
  echo "RLM_PROVIDER=$RLM_PROVIDER"
  echo "RLM_THINKING_LEVEL=\${RLM_THINKING_LEVEL:-unset}"
  echo "RLM_CALL_COUNT=$RLM_CALL_COUNT"
  echo "RLM_SESSION_FILE=\${RLM_SESSION_FILE:-unset}"
  echo "RLM_SESSION_DIR=\${RLM_SESSION_DIR:-unset}"
  echo "RLM_CALL_COUNTER_FILE=\${RLM_CALL_COUNTER_FILE:-unset}"
  echo "RLM_COST_FILE=\${RLM_COST_FILE:-unset}"
  echo "RLM_BUDGET=\${RLM_BUDGET:-unset}"
  echo "YPI_EXPLICIT_RELEASE_REQUEST=\${YPI_EXPLICIT_RELEASE_REQUEST:-unset}"
  echo "YPI_EXPLICIT_NON_OWNED_REMOTE=\${YPI_EXPLICIT_NON_OWNED_REMOTE:-unset}"
  echo "YPI_IMPLEMENT_ROOT=\${YPI_IMPLEMENT_ROOT:-unset}"
  echo "YPI_IMPLEMENT_SCOPE=$(tr '\\0' ',' < "\${YPI_IMPLEMENT_SCOPE_FILE:-/dev/null}" 2>/dev/null || true)"
  echo "WORKING_DIR=$PWD"
  echo "SECRET_TOKEN=\${SECRET_TOKEN:-unset}"
  echo "PI_CODING_AGENT_DIR=\${PI_CODING_AGENT_DIR:-unset}"
  echo "PI_PACKAGE_DIR=\${PI_PACKAGE_DIR:-unset}"
  echo "PI_OFFLINE=\${PI_OFFLINE:-unset}"
  if [ -f "\${PI_CODING_AGENT_DIR:-}/auth.json" ]; then
    echo "AUTH_FILE=present"
    echo "AUTH_MODE=$(stat -c '%a' "$PI_CODING_AGENT_DIR/auth.json")"
    grep -q '"anthropic"' "$PI_CODING_AGENT_DIR/auth.json" && echo "AUTH_SELECTED=present" || echo "AUTH_SELECTED=absent"
    grep -q '"other-provider"' "$PI_CODING_AGENT_DIR/auth.json" && echo "AUTH_OTHER=present" || echo "AUTH_OTHER=absent"
    [ -e "$PI_CODING_AGENT_DIR/settings.json" ] && echo "SETTINGS_FILE=present" || echo "SETTINGS_FILE=absent"
  else
    echo "AUTH_FILE=absent"
  fi
  [ -n "\${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_ENV=present" || echo "ANTHROPIC_ENV=absent"
  [ -n "\${OPENAI_API_KEY:-}" ] && echo "OPENAI_ENV=present" || echo "OPENAI_ENV=absent"
  echo "CHILD_PID=$$"
  echo "SYSTEM_PROMPT_CONTEXT=$(grep -E 'External task context:|Current delegated charter:' "$SYSTEM_PROMPT_FILE" 2>/dev/null | head -1 || true)"
} >> "$YPI_FAKE_PI_LOG"
if [ "\${YPI_FAKE_PI_MODE:-ok}" = "fail" ]; then
  echo "fake child failure" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "fail-and-corrupt-slot" ]; then
  printf '%s\n' 'not-json' > "$RLM_CONCURRENCY_DIR/slot-$RLM_ACTIVE_SLOT_TOKEN/lease.json"
  echo "fake child failure with cleanup corruption" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "fail-and-block-resource-cleanup" ]; then
  RESOURCE_ROOT=$(dirname "$RLM_PROMPT_FILE")
  printf '%s\n' "$RESOURCE_ROOT" > "$YPI_FAKE_RESOURCE_DIR_FILE"
  chmod 000 "$RESOURCE_ROOT"
  echo "fake child failure with resource cleanup obstruction" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "fail-and-corrupt-registry" ]; then
  printf '%s\n' 'unexpected' > "$RLM_CONCURRENCY_DIR/unexpected"
  echo "fake child failure with parent resume obstruction" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "signal" ]; then
  kill -TERM $$
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "huge" ]; then
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json" ]; then
  printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"JSON_CHILD_OK"}}'
  printf '%s\\n' '{"type":"turn_end","message":{"usage":{"totalTokens":7,"cost":{"total":0.123}}},"toolResults":[]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-cost-then-sleep" ]; then
  printf '%s\\n' '{"type":"turn_end","message":{"usage":{"totalTokens":5,"cost":{"total":0.25}}},"toolResults":[]}'
  printf '%s\\n' "$$" > "$YPI_FAKE_PID_FILE"
  sleep 30
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-long-text" ]; then
  python3 - <<'PY'
import json
for _ in range(100):
    print(json.dumps({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"X"*1000}}))
print(json.dumps({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"END_PROGRESS"}}))
print(json.dumps({"type":"turn_end","message":{"usage":{"totalTokens":9,"cost":{"total":0.2}}},"toolResults":[]}))
PY
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-tools" ]; then
  printf '%s\n' '{"type":"tool_execution_start","toolCallId":"id-1","toolName":"read","args":{"secret":"ARG_SECRET"}}'
  printf '%s\n' '{"type":"tool_execution_start","toolCallId":"id-2","toolName":"grep","args":{"secret":"ARG_SECRET"}}'
  printf '%s\n' '{"type":"tool_execution_start","toolCallId":"id-3","toolName":"SECRET_TOOL_NAME","args":{"secret":"ARG_SECRET"}}'
  printf '%s\n' '{"type":"tool_execution_start","toolCallId":"id-4","toolName":"ls","args":{"secret":"ARG_SECRET"}}'
  printf '%s\n' '{"type":"tool_execution_start","toolCallId":"id-5","toolName":"bash","args":{"command":"echo ARG_SECRET"}}'
  sleep 2.2
  printf '%s\n' '{"type":"tool_execution_end","toolCallId":"id-5","toolName":"bash","result":{"secret":"RESULT_SECRET"},"isError":false}'
  printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"TOOLS_DONE"}}'
  printf '%s\n' '{"type":"turn_end","message":{"usage":{"totalTokens":13,"cost":{"total":0.3}}},"toolResults":[]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-no-turn-end" ]; then
  printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"PARTIAL_ONLY"}}'
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-huge-tail" ]; then
  printf '%s' '{"type":"tool_result","payload":"'
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
  printf '%s\\n' '"}'
  printf '%s\\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"LATE_JSON_OK"}}'
  printf '%s\\n' '{"type":"turn_end","message":{"usage":{"totalTokens":11,"cost":{"total":0.456}}},"toolResults":[]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "json-huge-turn-end" ]; then
  printf '%s' '{"type":"turn_end","message":{"usage":{"totalTokens":99,"cost":{"total":9.99}}},"toolResults":["'
  head -c $((17 * 1024 * 1024)) /dev/zero | tr '\\0' X
  printf '%s\\n' '"]}'
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "sleep" ]; then
  sleep 30
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "concurrency" ]; then
  while ! mkdir "$YPI_FAKE_CONCURRENCY_LOCK" 2>/dev/null; do sleep 0.005; done
  active=$(cat "$YPI_FAKE_CONCURRENCY_ACTIVE" 2>/dev/null || printf 0)
  active=$((active + 1))
  printf '%s\n' "$active" > "$YPI_FAKE_CONCURRENCY_ACTIVE"
  maximum=$(cat "$YPI_FAKE_CONCURRENCY_MAX" 2>/dev/null || printf 0)
  if [ "$active" -gt "$maximum" ]; then
    printf '%s\n' "$active" > "$YPI_FAKE_CONCURRENCY_MAX"
  fi
  rmdir "$YPI_FAKE_CONCURRENCY_LOCK"
  sleep 0.25
  while ! mkdir "$YPI_FAKE_CONCURRENCY_LOCK" 2>/dev/null; do sleep 0.005; done
  active=$(cat "$YPI_FAKE_CONCURRENCY_ACTIVE")
  printf '%s\n' "$((active - 1))" > "$YPI_FAKE_CONCURRENCY_ACTIVE"
  rmdir "$YPI_FAKE_CONCURRENCY_LOCK"
  echo "CONCURRENCY_CHILD_OK"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "transcript" ]; then
  printf '%s\n' '{"type":"session","version":3,"id":"child-session"}' >> "$RLM_SESSION_FILE"
  printf '%s\n' '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}' >> "$RLM_SESSION_FILE"
  echo "TRANSCRIPT_CHILD_OK"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "invalid-transcript" ]; then
  printf '%s\n' 'not-json' >> "$RLM_SESSION_FILE"
  echo "INVALID_TRANSCRIPT_CHILD"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-file" ]; then
  printf '%s\n' 'implemented by child' > implemented.txt
  echo "IMPLEMENT_CHILD_OK"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-scope" ]; then
  SCOPE_PATH=$(tr '\\0' '\\n' < "$YPI_IMPLEMENT_SCOPE_FILE" | head -1)
  printf '%s\n' "implemented $SCOPE_PATH" > "$SCOPE_PATH"
  sleep 0.2
  echo "IMPLEMENT_SCOPE_OK"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-file-fail" ]; then
  printf '%s\n' 'partial implementation' > partial-implemented.txt
  echo "IMPLEMENT_CHILD_FAILED" >&2
  exit 42
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-then-sleep" ]; then
  printf '%s\n' 'interrupted implementation' > interrupted-implemented.txt
  echo "IMPLEMENT_CHILD_WAITING"
  sleep 30
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-background" ]; then
  (sleep 1; printf '%s\n' 'orphan write' > descendant-write.txt) >/dev/null 2>&1 &
  echo "BACKGROUND_CHILD_OK"
elif [ "\${YPI_FAKE_PI_MODE:-ok}" = "write-background-inherited-pipes" ]; then
  (sleep 10; printf '%s\n' 'late orphan write' > inherited-descendant-write.txt) &
  echo "BACKGROUND_INHERITED_CHILD_OK"
else
  echo "FAKE_CHILD_OK"
fi
`);
chmodSync(fakePi, 0o755);

// Do not let a parent ypi session's YPI_EXTENSION_ROOT redirect this harness
// away from the worktree under test.
process.env.YPI_EXTENSION_ROOT = projectRoot;
const runtime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
let tool: Tool | undefined;
const pi = {
	registerTool(registered: Tool) {
		tool = registered;
	},
	getThinkingLevel() {
		return "xhigh";
	},
	getAllTools() {
		return [
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "rlm_query" },
			{ name: "installed_status" },
			{ name: "installed_context_pack" },
		];
	},
} as Pick<ExtensionAPI, "registerTool" | "getThinkingLevel" | "getAllTools"> as ExtensionAPI;

function context(cwd = projectRoot): ExtensionContext {
	return {
		cwd,
		model: { provider: "test-provider", id: "test-root-model" },
		sessionManager: {
			getSessionFile: () => path.join(sessionDir, "parent.jsonl"),
			getSessionDir: () => sessionDir,
		},
	} as ExtensionContext;
}

async function invoke(prompt = "child prompt", signal?: AbortSignal, onUpdate?: (result: any) => void, mode: "review" | "implement" = "review"): Promise<string> {
	if (!tool) throw new Error("native tool was not registered");
	const result = await tool.execute(
		"test-call",
		{ prompt, mode, ...(mode === "implement" ? { scope: ["."] } : {}) },
		signal,
		onUpdate,
		context(),
	);
	const text = result.content.find((item) => item.type === "text")?.text || "";
	return text;
}

async function expectThrow(label: string, expected: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
		record(false, label, "expected throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(message.includes(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(message)}`);
	}
}

async function run(): Promise<void> {
	console.log("");
	console.log("=== Native rlm_query Tool Harness ===");

	clearYpiEnv();
	ensureEnvironment(runtime, context());
	registerNativeRlmQueryTool(pi, runtime);
	record(Boolean(tool), "native tool registered");
	record(tool?.executionMode === "parallel", "native tool permits bounded parallel slice calls");
	const generatedCounter = process.env.RLM_CALL_COUNTER_FILE || "";
	const generatedConcurrency = process.env.RLM_CONCURRENCY_DIR || "";
	const generatedStateRoot = path.dirname(generatedCounter);
	record(
		generatedStateRoot === path.dirname(generatedConcurrency)
			&& generatedStateRoot === path.dirname(process.env.PI_TRACE_FILE || "")
			&& generatedStateRoot === path.dirname(process.env.RLM_COST_FILE || ""),
		"default control and telemetry paths share one private runtime directory",
	);
	record(
		(statSync(generatedStateRoot).mode & 0o077) === 0,
		"default runtime directory rejects group and world access",
	);

	clearYpiEnv();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "1";
	ensureEnvironment(runtime, context());
	await expectThrow("N1: max depth throws", "Max depth exceeded", () => invoke());

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_WRITE_MODE_CEILING = "review";
	ensureEnvironment(runtime, context());
	await expectThrow("N1a: child cannot escalate to writable recursion", "cannot be escalated", () => invoke("nested writer", undefined, undefined, "implement"));
	assertNotContains("N1a: rejected writable escalation spawns no child", readLog(), "ARGS:");
	delete process.env.RLM_WRITE_MODE_CEILING;
	await expectThrow("N1a: depth alone prevents writable escalation", "root-only", () => invoke("nested writer without ceiling", undefined, undefined, "implement"));
	assertNotContains("N1a: missing ceiling cannot spawn writable child", readLog(), "ARGS:");

	// N1b: a non-integer depth config fails closed instead of bypassing the limiter.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "abc";
	ensureEnvironment(runtime, context());
	await expectThrow("N1b: non-integer RLM_MAX_DEPTH fails closed", "Invalid recursion depth config", () => invoke());
	assertNotContains("N1b: malformed depth did not spawn child", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0junk";
	process.env.RLM_MAX_DEPTH = "2";
	ensureEnvironment(runtime, context());
	await expectThrow("N1c: integer-prefix RLM_DEPTH fails closed", "Invalid recursion depth config", () => invoke());
	assertNotContains("N1c: integer-prefix depth did not spawn child", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	ensureEnvironment(runtime, context());
	const preAborted = new AbortController();
	preAborted.abort();
	await expectThrow("N1d: pre-aborted request stops before admission", "cancelled before admission", () => invoke("cancel before admission", preAborted.signal));
	assertNotContains("N1d: pre-aborted request spawns no child", readLog(), "ARGS:");
	record(!existsSync(process.env.RLM_CALL_COUNTER_FILE || ""), "N1d: pre-aborted request allocates no call slot");

	// N2: RLM_MAX_CALLS=N permits exactly N calls; the (N+1)th is blocked before spawning.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_MAX_CALLS = "1";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	const n2First = await invoke();
	assertContains("N2: max calls allows the first call", n2First, "FAKE_CHILD_OK");
	resetLog();
	await expectThrow("N2: max calls throws on the second call", "Max calls exceeded", () => invoke());
	assertNotContains("N2: blocked second call did not spawn child", readLog(), "ARGS:");

	// N3: a depth>0 child that inherited a stale tree start time still hits the timeout guard.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_TIMEOUT = "1";
	process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000) - 5);
	ensureEnvironment(runtime, context());
	await expectThrow("N3: expired timeout throws before spawn", "Timeout exceeded", () => invoke());
	assertNotContains("N3: expired timeout did not spawn child", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_TIMEOUT = "2147484";
	ensureEnvironment(runtime, context());
	await expectThrow(
		"N3b: timer-overflow timeout fails closed",
		"supported maximum of 2147483 seconds",
		() => invoke(),
	);
	assertNotContains("N3b: timer-overflow timeout did not spawn child", readLog(), "ARGS:");
	record(
		!existsSync(process.env.RLM_CALL_COUNTER_FILE || ""),
		"N3b: timer-overflow timeout allocates no call slot",
	);

	// N12: a fresh depth-0 call re-anchors the budget, so a stale session start time does not
	// make a long-running root Pi immediately time out.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_TIMEOUT = "30";
	process.env.RLM_JSON = "0";
	process.env.RLM_START_TIME = String(Math.floor(Date.now() / 1000) - 600);
	ensureEnvironment(runtime, context());
	const n12 = await invoke();
	assertContains("N12: depth-0 re-anchors a stale timeout budget", n12, "FAKE_CHILD_OK");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "fail";
	ensureEnvironment(runtime, context());
	await expectThrow("N4: nonzero child exit throws", "Child Pi exited with 42", () => invoke());

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "fail-and-corrupt-slot";
	ensureEnvironment(runtime, context());
	let primaryAndCleanupError: unknown;
	try {
		await invoke();
	} catch (error) {
		primaryAndCleanupError = error;
	}
	const primaryAndCleanupMessage = primaryAndCleanupError instanceof Error
		? primaryAndCleanupError.message
		: String(primaryAndCleanupError || "");
	record(
		primaryAndCleanupMessage.includes("Child Pi exited with 42")
			&& primaryAndCleanupMessage.includes("Recursive child cleanup also failed")
			&& (primaryAndCleanupError as Error & { exitCode?: number })?.exitCode === 42,
		"N4a: primary child failure retains secondary cleanup failure and exit classification",
		primaryAndCleanupMessage,
	);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "fail-and-block-resource-cleanup";
	const resourceDirectoryReceipt = path.join(scratch, "blocked-resource-directory");
	process.env.YPI_FAKE_RESOURCE_DIR_FILE = resourceDirectoryReceipt;
	ensureEnvironment(runtime, context());
	let primaryAndResourceError: unknown;
	try {
		await invoke();
	} catch (error) {
		primaryAndResourceError = error;
	}
	const primaryAndResourceMessage = primaryAndResourceError instanceof Error
		? primaryAndResourceError.message
		: String(primaryAndResourceError || "");
	record(
		primaryAndResourceMessage.includes("Child Pi exited with 42")
			&& primaryAndResourceMessage.includes("Recursive child cleanup also failed")
			&& (primaryAndResourceError as Error & { exitCode?: number })?.exitCode === 42,
		"N4a: primary child failure retains resource cleanup failure and exit classification",
		primaryAndResourceMessage,
	);
	if (existsSync(resourceDirectoryReceipt)) {
		const blockedResourceDirectory = readFileSync(resourceDirectoryReceipt, "utf8").trim();
		if (blockedResourceDirectory) {
			chmodSync(blockedResourceDirectory, 0o700);
			rmSync(blockedResourceDirectory, { recursive: true, force: true });
		}
	}

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.YPI_FAKE_PI_MODE = "fail-and-corrupt-registry";
	ensureEnvironment(runtime, context());
	const inheritedForResumeFailure = await acquireConcurrencySlot();
	process.env.RLM_ACTIVE_SLOT_TOKEN = inheritedForResumeFailure.token;
	let primaryAndResumeError: unknown;
	try {
		await invoke();
	} catch (error) {
		primaryAndResumeError = error;
	}
	const primaryAndResumeMessage = primaryAndResumeError instanceof Error
		? primaryAndResumeError.message
		: String(primaryAndResumeError || "");
	record(
		primaryAndResumeMessage.includes("Child Pi exited with 42")
			&& primaryAndResumeMessage.includes("Recursive child cleanup also failed")
			&& primaryAndResumeMessage.includes("unexpected state")
			&& (primaryAndResumeError as Error & { exitCode?: number })?.exitCode === 42,
		"N4a: primary child failure retains inherited-slot resume failure and exit classification",
		primaryAndResumeMessage,
	);
	rmSync(path.join(process.env.RLM_CONCURRENCY_DIR || "", "unexpected"), { force: true });
	await inheritedForResumeFailure.release();

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "signal";
	ensureEnvironment(runtime, context());
	await expectThrow("N4b: signalled child uses conventional exit status", "Child Pi exited with 143", () => invoke());

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	const readOnlyText = await invoke();
	assertContains("N5: child stdout returned", readOnlyText, "FAKE_CHILD_OK");
	assertContains("N5: review child excludes built-in mutators", readLog(), "--exclude-tools bash,edit,write");
	assertContains("N5: review child receives no write-scope authority", readLog(), "YPI_IMPLEMENT_ROOT=unset");
	assertNotContains("N5: review child avoids a global tool allowlist", readLog(), "--tools ");

	const implementRoot = mkdtempSync(path.join(scratch, "implement-git."));
	spawnSync("git", ["init", "-q"], { cwd: implementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(implementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: implementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: implementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.YPI_FAKE_PI_MODE = "write-file";
	ensureEnvironment(runtime, context(implementRoot));
	if (!tool) throw new Error("native tool was not registered");
	await expectThrow(
		"N5a: implement mode requires a declared path scope",
		"non-empty scope",
		() => tool!.execute("implement-missing-scope", { prompt: "unscoped implementation", mode: "implement" }, undefined, undefined, context(implementRoot)),
	);
	assertNotContains("N5a: missing scope spawns no child", readLog(), "ARGS:");
	const implementResult = await tool.execute(
		"implement-call",
		{ prompt: "bounded implementation", mode: "implement", scope: ["implemented.txt"] },
		undefined,
		undefined,
		context(implementRoot),
	);
	const implementText = implementResult.content.find((item) => item.type === "text")?.text || "";
	assertContains("N5a: one clean-Git implementer executes", implementText, "IMPLEMENT_CHILD_OK");
	assertContains("N5a: implementer result reports changed path", implementText, "implemented.txt");
	record(
		implementResult.details?.workspace?.workspaceMode === "git-worktree"
			&& implementResult.details?.workspace?.reportComplete === true
			&& implementResult.details?.workspace?.treeRestored === true
			&& Boolean(implementResult.details?.workspace?.attemptRef)
			&& Boolean(implementResult.details?.workspace?.attemptCommit),
		"N5a: implementer returns a complete worktree/ref report",
		JSON.stringify(implementResult.details),
	);
	assertContains("N5a: implementer receives the explicit confined tool allowlist", readLog(), "--tools read,grep,find,ls,edit,write,rlm_query");
	assertNotContains("N5a: implementer excludes process-spawning bash", readLog(), "--tools read,grep,find,ls,bash");
	assertContains("N5a: implementer forces canonical-only extension mode", readLog(), "--no-extensions");
	assertContains("N5a: implementer forces exact confinement extension", readLog(), `-e ${runtime.extensionPath}`);
	const loggedImplementRoot = /^YPI_IMPLEMENT_ROOT=(.+)$/m.exec(readLog())?.[1] || "";
	record(
		Boolean(loggedImplementRoot)
			&& loggedImplementRoot !== implementRoot
			&& loggedImplementRoot.includes("ypi_ws_"),
		"N5a: implementer receives an isolated write-scope root",
		loggedImplementRoot,
	);
	assertContains("N5a: implementer receives its declared scope", readLog(), "YPI_IMPLEMENT_SCOPE=implemented.txt");
	record(!existsSync(path.join(implementRoot, "implemented.txt")), "N5a: implementer edits leave the root checkout clean");
	const implementAttemptRef = implementResult.details?.workspace?.attemptRef || "";
	const implementedFromRef = spawnSync("git", ["show", `${implementAttemptRef}:implemented.txt`], { cwd: implementRoot, encoding: "utf8", env: fixtureGitEnv() });
	record(implementedFromRef.status === 0 && implementedFromRef.stdout === "implemented by child\n", "N5a: salvage ref contains the exact child edit");
	const implementCommonDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: implementRoot, encoding: "utf8", env: fixtureGitEnv() }).stdout.trim();
	const implementLeases = path.join(implementCommonDir, "ypi-implementers", "leases");
	record(!existsSync(implementLeases) || readdirSync(implementLeases).length === 0, "N5a: implementer releases writer lease after reporting");

	const parallelImplementRoot = mkdtempSync(path.join(scratch, "implement-parallel."));
	spawnSync("git", ["init", "-q"], { cwd: parallelImplementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(parallelImplementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: parallelImplementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: parallelImplementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "write-scope";
	ensureEnvironment(runtime, context(parallelImplementRoot));
	const parallelResults = await Promise.all([
		tool.execute(
			"parallel-a",
			{ prompt: "implement slice a", mode: "implement", scope: ["slice-a.txt"] },
			undefined,
			undefined,
			context(parallelImplementRoot),
		),
		tool.execute(
			"parallel-b",
			{ prompt: "implement slice b", mode: "implement", scope: ["slice-b.txt"] },
			undefined,
			undefined,
			context(parallelImplementRoot),
		),
	]);
	record(
		parallelResults.every((result) => result.details?.workspace?.reportComplete === true)
			&& parallelResults.every((result) => Boolean(result.details?.workspace?.attemptRef))
			&& !existsSync(path.join(parallelImplementRoot, "slice-a.txt"))
			&& !existsSync(path.join(parallelImplementRoot, "slice-b.txt")),
		"N5a3: two disjoint native implement calls run concurrently and leave the root clean",
		JSON.stringify(parallelResults.map((result) => result.details?.workspace)),
	);
	const parallelRefs = parallelResults.map((result) => result.details?.workspace?.attemptRef || "");
	const parallelA = spawnSync("git", ["show", `${parallelRefs[0]}:slice-a.txt`], { cwd: parallelImplementRoot, encoding: "utf8", env: fixtureGitEnv() });
	const parallelB = spawnSync("git", ["show", `${parallelRefs[1]}:slice-b.txt`], { cwd: parallelImplementRoot, encoding: "utf8", env: fixtureGitEnv() });
	record(
		parallelA.status === 0
			&& parallelA.stdout === "implemented slice-a.txt\n"
			&& parallelB.status === 0
			&& parallelB.stdout === "implemented slice-b.txt\n",
		"N5a3: each parallel native result returns its own exact slice ref",
	);

	// N5a2: git hooks export GIT_DIR (and friends) into the environment. The
	// lease's VCS checks must inspect the leased checkout, not whatever
	// repository the inherited hook variables point at — otherwise a clean
	// fixture looks dirty (or a dirty parent looks clean) whenever ypi runs
	// under `git push`.
	const hookVictimRoot = mkdtempSync(path.join(scratch, "implement-hook-victim."));
	spawnSync("git", ["init", "-q"], { cwd: hookVictimRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(hookVictimRoot, "dirty.txt"), "uncommitted\n");
	const hookImplementRoot = mkdtempSync(path.join(scratch, "implement-hook-clean."));
	spawnSync("git", ["init", "-q"], { cwd: hookImplementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(hookImplementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: hookImplementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: hookImplementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.YPI_FAKE_PI_MODE = "write-file";
	process.env.GIT_DIR = path.join(hookVictimRoot, ".git");
	process.env.GIT_WORK_TREE = hookVictimRoot;
	try {
		ensureEnvironment(runtime, context(hookImplementRoot));
		const hookImplementResult = await tool.execute(
			"implement-hook-call",
			{ prompt: "bounded implementation under git hook env", mode: "implement", scope: ["implemented.txt"] },
			undefined,
			undefined,
			context(hookImplementRoot),
		);
		const hookImplementText = hookImplementResult.content.find((item) => item.type === "text")?.text || "";
		assertContains("N5a2: implementer lease ignores inherited GIT_DIR/GIT_WORK_TREE", hookImplementText, "IMPLEMENT_CHILD_OK");
	} finally {
		delete process.env.GIT_DIR;
		delete process.env.GIT_WORK_TREE;
	}

	const failingImplementRoot = mkdtempSync(path.join(scratch, "implement-failure."));
	spawnSync("git", ["init", "-q"], { cwd: failingImplementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(failingImplementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: failingImplementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: failingImplementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "write-file-fail";
	ensureEnvironment(runtime, context(failingImplementRoot));
	try {
		await tool.execute(
			"implement-failure",
			{ prompt: "bounded failing implementation", mode: "implement", scope: ["partial-implemented.txt"] },
			undefined,
			undefined,
			context(failingImplementRoot),
		);
		record(false, "N5a: failed implementer returns its changed-path report", "expected failure");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(
			message.includes("partial-implemented.txt")
				&& message.includes("report: complete")
				&& message.includes("Attempt ref:")
				&& message.includes("Ephemeral worktree removed: yes"),
			"N5a: failed implementer returns its worktree/ref report",
			message,
		);
		record(!existsSync(path.join(failingImplementRoot, "partial-implemented.txt")), "N5a: failed implementer also leaves the root checkout clean");
	}

	const cancelledImplementRoot = mkdtempSync(path.join(scratch, "implement-cancelled."));
	spawnSync("git", ["init", "-q"], { cwd: cancelledImplementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(cancelledImplementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: cancelledImplementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: cancelledImplementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "write-then-sleep";
	ensureEnvironment(runtime, context(cancelledImplementRoot));
	const cancellation = new AbortController();
	setTimeout(() => cancellation.abort(), 150);
	try {
		await tool.execute(
			"implement-cancelled",
			{ prompt: "bounded cancelled implementation", mode: "implement", scope: ["interrupted-implemented.txt"] },
			cancellation.signal,
			undefined,
			context(cancelledImplementRoot),
		);
		record(false, "N5a: cancelled implementer preserves a worktree/ref result", "expected cancellation");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(
				message.includes("Child Pi cancelled")
					&& message.includes("interrupted-implemented.txt")
					&& message.includes("Ephemeral worktree removed: yes")
					&& !existsSync(path.join(cancelledImplementRoot, "interrupted-implemented.txt")),
				"N5a: cancelled implementer preserves a worktree/ref result",
			message,
		);
	}

	const timedImplementRoot = mkdtempSync(path.join(scratch, "implement-timeout."));
	spawnSync("git", ["init", "-q"], { cwd: timedImplementRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(timedImplementRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: timedImplementRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: timedImplementRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_TIMEOUT = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "write-then-sleep";
	ensureEnvironment(runtime, context(timedImplementRoot));
	try {
		await tool.execute(
			"implement-timeout",
			{ prompt: "bounded timed implementation", mode: "implement", scope: ["interrupted-implemented.txt"] },
			undefined,
			undefined,
			context(timedImplementRoot),
		);
		record(false, "N5a: timed-out implementer preserves a worktree/ref result", "expected timeout");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(
				message.includes("timed out")
					&& message.includes("interrupted-implemented.txt")
					&& message.includes("Ephemeral worktree removed: yes")
					&& !existsSync(path.join(timedImplementRoot, "interrupted-implemented.txt")),
				"N5a: timed-out implementer preserves a worktree/ref result",
			message,
		);
	}

	const spawnFailureRoot = mkdtempSync(path.join(scratch, "implement-spawn-failure."));
	spawnSync("git", ["init", "-q"], { cwd: spawnFailureRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(spawnFailureRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: spawnFailureRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: spawnFailureRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_PI_BIN = path.join(scratch, "missing-pi");
	ensureEnvironment(runtime, context(spawnFailureRoot));
	try {
		await tool.execute(
			"implement-spawn-failure",
			{ prompt: "bounded missing executable", mode: "implement", scope: ["."] },
			undefined,
			undefined,
			context(spawnFailureRoot),
		);
		record(false, "N5a: spawn failure still finalizes workspace", "expected spawn error");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(
			message.includes("ENOENT")
				&& message.includes("Attempt ref:")
				&& message.includes("Ephemeral worktree removed: yes")
				&& spawnSync("git", ["status", "--porcelain=v2", "--untracked-files=all"], { cwd: spawnFailureRoot, encoding: "utf8", env: fixtureGitEnv() }).stdout.trim() === "",
			"N5a: spawn failure still finalizes workspace",
			message,
		);
	}

	const descendantRoot = mkdtempSync(path.join(scratch, "implement-descendant."));
	spawnSync("git", ["init", "-q"], { cwd: descendantRoot, env: fixtureGitEnv() });
	writeFileSync(path.join(descendantRoot, "base.txt"), "base\n");
	spawnSync("git", ["add", "base.txt"], { cwd: descendantRoot, env: fixtureGitEnv() });
	spawnSync("git", ["-c", "user.name=ypi-test", "-c", "user.email=ypi@example.invalid", "commit", "-qm", "base"], { cwd: descendantRoot, env: fixtureGitEnv() });
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "write-background";
	ensureEnvironment(runtime, context(descendantRoot));
	if (!tool) throw new Error("native tool was not registered");
	await tool.execute(
		"implement-descendant",
		{ prompt: "bounded descendant cleanup", mode: "implement", scope: ["descendant-write.txt"] },
		undefined,
		undefined,
		context(descendantRoot),
	);
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	record(!existsSync(path.join(descendantRoot, "descendant-write.txt")), "N5a: writer lease cleanup terminates surviving child process-group descendants");
	process.env.YPI_FAKE_PI_MODE = "write-background-inherited-pipes";
	ensureEnvironment(runtime, context(descendantRoot));
	const inheritedStarted = Date.now();
	await tool.execute(
		"implement-descendant-inherited",
		{ prompt: "bounded inherited-pipe cleanup", mode: "implement", scope: ["inherited-descendant-write.txt"] },
		undefined,
		undefined,
		context(descendantRoot),
	);
	record(Date.now() - inheritedStarted < 5_000, "N5a: inherited descendant pipes cannot hold writer completion open");
	record(!existsSync(path.join(descendantRoot, "inherited-descendant-write.txt")), "N5a: early process-group sweep prevents inherited-pipe descendant writes");

	// N5b: an oversized child stream is drained but retained only to the bounded
	// capture limit. This protects the parent from V8's maximum string length.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "huge";
	ensureEnvironment(runtime, context());
	const oversizedText = await invoke();
	assertContains("N5b: oversized stdout reports streaming bound", oversizedText, "Child stdout stream exceeded 16777216 characters");
	record(oversizedText.length < 70 * 1024, "N5b: oversized stdout result stays near final tool-output cap", `length=${oversizedText.length}`);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_SHARED_SESSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N6: shared sessions off uses no-session", readLog(), "--no-session");
	assertContains("N6: shared sessions off clears session env", readLog(), "RLM_SESSION_FILE=unset");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_SHARED_SESSIONS = "0";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await expectThrow(
		"N6a: transcript-required mode rejects disabled session sharing before spawn",
		"RLM_SHARED_SESSIONS=1",
		() => invoke(),
	);
	assertNotContains("N6a: missing transcript transport spawns no child", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await expectThrow(
		"N6b: transcript-required mode rejects a child with no appended event",
		"did not append",
		() => invoke(),
	);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "invalid-transcript";
	ensureEnvironment(runtime, context());
	await expectThrow(
		"N6c: transcript-required mode rejects malformed appended JSONL",
		"invalid JSONL",
		() => invoke(),
	);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "transcript";
	ensureEnvironment(runtime, context());
	const transcriptResult = await invoke();
	assertContains(
		"N6d: transcript-required mode accepts an appended child session event",
		transcriptResult,
		"TRANSCRIPT_CHILD_OK",
	);
	const transcriptPath = /RLM_SESSION_FILE=([^\n]+)/.exec(readLog())?.[1] || "";
	const transcriptValidator = path.join(
		projectRoot,
		"scripts",
		"validate-recursion-transcripts.ts",
	);
	const validation = spawnSync(process.execPath, [
		transcriptValidator,
		"--trace",
		process.env.PI_TRACE_FILE || "",
		"--session-dir",
		process.env.RLM_SESSION_DIR || "",
	], { encoding: "utf8" });
	record(
		validation.status === 0
			&& String(validation.stdout).includes("TRANSCRIPT_VALIDATION=PASS calls=1"),
		"N6e: deterministic validator maps the admitted trace call to its session",
		String(validation.stderr || validation.stdout || ""),
	);
	rmSync(transcriptPath, { force: true });
	const missingValidation = spawnSync(process.execPath, [
		transcriptValidator,
		"--trace",
		process.env.PI_TRACE_FILE || "",
		"--session-dir",
		process.env.RLM_SESSION_DIR || "",
	], { encoding: "utf8" });
	record(
		missingValidation.status === 1
			&& String(missingValidation.stderr).includes("TRANSCRIPT_VALIDATION=FAIL"),
		"N6e: deterministic validator fails when an admitted transcript is missing",
		String(missingValidation.stderr || missingValidation.stdout || ""),
	);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "fail";
	ensureEnvironment(runtime, context());
	try {
		await invoke();
		record(false, "N6f: transcript failure preserves a nonzero child exit", "expected throw");
	} catch (error) {
		const failure = error as Error & { exitCode?: number };
		record(
			failure.exitCode === 42
				&& failure.message.includes("Child Pi exited with 42")
				&& failure.message.includes("Transcript proof failed"),
			"N6f: transcript failure preserves a nonzero child exit",
			failure.message,
		);
	}

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_MODEL = "child-model";
	process.env.RLM_CHILD_PROVIDER = "child-provider";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N7: root-to-child uses child model", readLog(), "--model child-model");
	assertContains("N7: root-to-child uses child provider", readLog(), "--provider child-provider");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "1";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_PROVIDER = "openai";
	process.env.RLM_MODEL = "gpt-5.5:xhigh";
	process.env.RLM_THINKING_LEVEL = "xhigh";
	process.env.RLM_CHILD_MODELS = "gpt-5.5:high,gpt-5.5:medium";
	process.env.RLM_CHILD_THINKING_LEVELS = "high,medium";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context(), pi);
	await invoke();
	assertContains("N7b: second-depth child model selected", readLog(), "--model gpt-5.5:medium");
	assertContains("N7b: second-depth child thinking selected", readLog(), "--thinking medium");
	assertContains("N7b: child thinking env selected", readLog(), "RLM_THINKING_LEVEL=medium");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_PROVIDER = "stale-provider";
	process.env.RLM_MODEL = "stale-model";
	process.env.RLM_THINKING_LEVEL = "low";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context(), pi);
	await invoke();
	assertContains("N7c: stale provider refreshed from active root", readLog(), "--provider test-provider");
	assertContains("N7c: stale model refreshed from active root", readLog(), "--model test-root-model");
	assertContains("N7c: stale thinking refreshed from active root", readLog(), "--thinking xhigh");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8: ambient extension copies are disabled by default", readLog(), "--no-extensions");
	assertNotContains("N8: skill discovery is enabled by default", readLog(), "--no-skills");
	assertContains("N8: ypi extension remains explicit", readLog(), `-e ${runtime.extensionPath}`);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8b: child extension override disables extensions", readLog(), "--no-extensions");
	assertContains("N8b: extension-isolated child keeps generated system prompt", readLog(), "--system-prompt ");
	assertContains("N8b: extension-isolated prompt exposes delegated charter", readLog(), "SYSTEM_PROMPT_CONTEXT=- Current delegated charter: `");
	assertNotContains("N8b: child extension override avoids explicit extension", readLog(), "-e ");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_DISCOVERY = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N8c: child discovery override disables non-extension skill discovery", readLog(), "--no-skills");
	assertContains("N8c: child discovery override disables context files", readLog(), "--no-context-files");
	assertContains("N8c: child discovery override keeps canonical-only extension mode", readLog(), "--no-extensions");
	assertContains("N8c: child discovery override still loads exact ypi", readLog(), `-e ${runtime.extensionPath}`);

	clearYpiEnv();
	resetLog();
	const fullIsolationParentAgent = path.join(scratch, "full-isolation-parent-agent");
	mkdirSync(fullIsolationParentAgent, { recursive: true, mode: 0o700 });
	const originalHome = process.env.HOME;
	const authCanary = "AUTH_SECRET_CANARY_MUST_NOT_LEAK";
	writeFileSync(
		path.join(fullIsolationParentAgent, "auth.json"),
		`${JSON.stringify({
			anthropic: { type: "oauth", access: authCanary },
			"other-provider": { type: "api_key", key: "OTHER_SECRET_MUST_NOT_LEAK" },
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(path.join(fullIsolationParentAgent, "settings.json"), '{"packages":["ambient-must-not-project"]}\n');
	process.env.HOME = scratch;
	process.env.PI_CODING_AGENT_DIR = "~/full-isolation-parent-agent";
	process.env.ANTHROPIC_API_KEY = "SELECTED_ENV_CANARY_MUST_NOT_LEAK";
	process.env.OPENAI_API_KEY = "OTHER_ENV_CANARY_MUST_NOT_LEAK";
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_CHILD_MODEL = "test-child-model";
	process.env.RLM_CHILD_PROVIDER = "anthropic";
	process.env.RLM_CHILD_DISCOVERY = "0";
	process.env.RLM_CHILD_EXTENSIONS = "0";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	await invoke();
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	const fullIsolationLog = readLog();
	assertContains("N8d: full child isolation disables extensions", fullIsolationLog, "--no-extensions");
	assertContains("N8d: full child isolation disables non-extension skills", fullIsolationLog, "--no-skills");
	assertContains("N8d: full child isolation keeps generated system prompt", fullIsolationLog, "--system-prompt ");
	assertContains("N8d: full child isolation exposes delegated charter", fullIsolationLog, "SYSTEM_PROMPT_CONTEXT=- Current delegated charter: `");
	assertContains("N8d: full child isolation uses a private Pi agent root", fullIsolationLog, "PI_CODING_AGENT_DIR=");
	assertNotContains("N8d: private Pi agent root is not the ambient default", fullIsolationLog, "PI_CODING_AGENT_DIR=~/full-isolation-parent-agent");
	assertContains("N8d: full child isolation forces offline package resolution", fullIsolationLog, "PI_OFFLINE=1");
	assertNotContains("N8d: full child isolation avoids explicit ypi extension", fullIsolationLog, "-e ");
	assertContains("N8d: selected provider auth is projected", fullIsolationLog, "AUTH_SELECTED=present");
	assertContains("N8d: projected auth is private", fullIsolationLog, "AUTH_MODE=600");
	assertContains("N8d: unselected provider auth is excluded", fullIsolationLog, "AUTH_OTHER=absent");
	assertContains("N8d: selected provider environment is retained", fullIsolationLog, "ANTHROPIC_ENV=present");
	assertContains("N8d: other provider environment is excluded", fullIsolationLog, "OPENAI_ENV=absent");
	assertContains("N8d: ambient settings are excluded", fullIsolationLog, "SETTINGS_FILE=absent");
	assertNotContains("N8d: auth secret is absent from child diagnostics", fullIsolationLog, authCanary);
	assertNotContains("N8d: selected environment secret is absent from child diagnostics", fullIsolationLog, "SELECTED_ENV_CANARY_MUST_NOT_LEAK");
	assertNotContains("N8d: other environment secret is absent from child diagnostics", fullIsolationLog, "OTHER_ENV_CANARY_MUST_NOT_LEAK");
	const isolatedAgentMatch = /^PI_CODING_AGENT_DIR=(.+)$/m.exec(fullIsolationLog);
	record(Boolean(isolatedAgentMatch && !existsSync(path.dirname(isolatedAgentMatch[1]))), "N8d: isolated auth root is removed after child completion");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.SECRET_TOKEN = "must-not-leak";
	process.env.YPI_EXPLICIT_RELEASE_REQUEST = "1";
	process.env.YPI_EXPLICIT_NON_OWNED_REMOTE = "github.com/otherowner/ypi";
	ensureEnvironment(runtime, context());
	await invoke();
	assertContains("N9: child env drops ambient secret", readLog(), "SECRET_TOKEN=unset");
	assertContains("N9: child cannot inherit release authority", readLog(), "YPI_EXPLICIT_RELEASE_REQUEST=unset");
	assertContains("N9: child cannot inherit remote override authority", readLog(), "YPI_EXPLICIT_NON_OWNED_REMOTE=unset");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_BUDGET = "0";
	process.env.YPI_FAKE_PI_MODE = "json";
	ensureEnvironment(runtime, context());
	record(process.env.RLM_BUDGET === undefined, "N10: inherited dollar cap is discarded");
	const progressUpdates: string[] = [];
	const jsonText = await invoke("PRIVATE_PROMPT_MUST_NOT_ENTER_TRACE", undefined, (update) => {
		progressUpdates.push(update.content?.find((item: any) => item.type === "text")?.text || "");
	});
	assertContains("N10: JSON child text parsed", jsonText, "JSON_CHILD_OK");
	assertContains("N10: native onUpdate receives bounded child progress", progressUpdates.join("\n"), "JSON_CHILD_OK");
	const costFile = process.env.RLM_COST_FILE || "";
	const traceFile = process.env.PI_TRACE_FILE || "";
	assertContains("N10: JSON child cost recorded without a budget", existsSync(costFile) ? readFileSync(costFile, "utf8") : "", '"cost":0.123');
	record((statSync(costFile).mode & 0o777) === 0o600 && (statSync(traceFile).mode & 0o777) === 0o600, "N10: automatic telemetry files are private");
	assertNotContains("N10: lifecycle trace excludes delegated prompt text", readFileSync(traceFile, "utf8"), "PRIVATE_PROMPT_MUST_NOT_ENTER_TRACE");
	assertContains("N10: child never receives dollar cap", readLog(), "RLM_BUDGET=unset");

	clearYpiEnv();
	resetLog();
	const permissiveTrace = path.join(scratch, "permissive-trace.jsonl");
	const permissiveCost = path.join(scratch, "permissive-cost.jsonl");
	writeFileSync(permissiveTrace, "");
	writeFileSync(permissiveCost, "");
	chmodSync(permissiveTrace, 0o644);
	chmodSync(permissiveCost, 0o644);
	process.env.PI_TRACE_FILE = permissiveTrace;
	process.env.RLM_COST_FILE = permissiveCost;
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
		process.env.RLM_JSON = "0";
		ensureEnvironment(runtime, context());
		await invoke("private telemetry permissions");
		record(
			process.env.PI_TRACE_FILE === undefined
				&& process.env.RLM_COST_FILE === undefined
				&& (statSync(permissiveTrace).mode & 0o777) === 0o644
				&& (statSync(permissiveCost).mode & 0o777) === 0o644
				&& readFileSync(permissiveTrace, "utf8") === ""
				&& readFileSync(permissiveCost, "utf8") === "",
			"N10: wrong-mode caller telemetry sinks are preserved and disabled",
		);

	clearYpiEnv();
	resetLog();
	process.env.PI_TRACE_FILE = "/dev/full";
	process.env.RLM_COST_FILE = "/dev/full";
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	ensureEnvironment(runtime, context());
	const telemetryFailureText = await invoke("telemetry failure must be observational");
	assertContains("N10: unusable telemetry sink cannot stop child work", telemetryFailureText, "FAKE_CHILD_OK");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-long-text";
	ensureEnvironment(runtime, context());
	const longProgressUpdates: string[] = [];
	const longText = await invoke("long progress", undefined, (update) => {
		longProgressUpdates.push(update.content?.find((item: any) => item.type === "text")?.text || "");
	});
	assertContains("N10a: native progress continues beyond final answer cap", longProgressUpdates.at(-1) || "", "END_PROGRESS");
	record(longText.length < 70_000, "N10a: final native result remains bounded");

	// N10b: diagnostic capture may be bounded, but the incremental JSON decoder
	// must still see late answer and cost events after an oversized tool event.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-huge-tail";
	ensureEnvironment(runtime, context());
	const lateJsonText = await invoke();
	assertContains("N10b: late JSON answer survives oversized prior event", lateJsonText, "LATE_JSON_OK");
	const lateCostFile = process.env.RLM_COST_FILE || "";
	assertContains("N10b: late JSON cost survives oversized prior event", existsSync(lateCostFile) ? readFileSync(lateCostFile, "utf8") : "", '"cost":0.456');

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-huge-turn-end";
	ensureEnvironment(runtime, context());
	await invoke();
	const incompleteCostFile = process.env.RLM_COST_FILE || "";
	assertContains("N10c: oversized cost boundary records incomplete telemetry without stopping work", readFileSync(incompleteCostFile, "utf8"), '"incomplete":true');
	assertNotContains("N10c: incomplete cost is not recorded as authoritative zero", readFileSync(incompleteCostFile, "utf8"), '"cost":0');

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-no-turn-end";
	ensureEnvironment(runtime, context());
	await expectThrow("N10d: failed JSON child reports its nonzero exit", "exited with 42", () => invoke());
	const missingTurnEndCostFile = process.env.RLM_COST_FILE || "";
	assertContains("N10d: missing turn_end writes an incomplete telemetry marker", readFileSync(missingTurnEndCostFile, "utf8"), '"incomplete":true');
	process.env.YPI_FAKE_PI_MODE = "json";
	resetLog();
	const afterIncomplete = await invoke();
	assertContains("N10d: incomplete telemetry never blocks later work", afterIncomplete, "JSON_CHILD_OK");
	assertContains("N10d: later child was spawned", readLog(), "ARGS:");

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-tools";
	process.env.YPI_STALL_WARNING_SECONDS = "1";
	ensureEnvironment(runtime, context());
	const toolProgress: any[] = [];
	const toolText = await invoke("tool progress", undefined, (update) => toolProgress.push(update));
	const renderedProgress = toolProgress.map((update) => update.content?.find((item: any) => item.type === "text")?.text || "").join("\n");
	assertContains("N10e: tool-only work produces activity before final text", renderedProgress, "… bash");
	assertContains("N10e: elapsed heartbeat advances without assistant text", renderedProgress, "elapsed 0m01s");
	assertContains("N10e: stale watchdog warns without terminating", renderedProgress, "still running — cancel manually if desired");
	assertContains("N10e: child completes after stale warning", toolText, "TOOLS_DONE");
	assertNotContains("N10e: progress never exposes tool args", renderedProgress, "ARG_SECRET");
	assertNotContains("N10e: progress never exposes tool results", renderedProgress, "RESULT_SECRET");
	assertNotContains("N10e: progress allowlists tool labels", renderedProgress, "SECRET_TOOL_NAME");
	const lastActivities = toolProgress.findLast((update) => update.details?.activities?.length === 4)?.details.activities || [];
	record(lastActivities.length === 4 && lastActivities.every((item: any) => !Object.hasOwn(item, "key")), "N10e: progress retains four sanitized activities without call ids", JSON.stringify(lastActivities));

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_SESSION_DIR = sessionDir;
	process.env.RLM_TRACE_ID = "parallel";
	ensureEnvironment(runtime, context());
	await Promise.all([invoke("first"), invoke("second")]);
	const log = readLog();
	assertContains("N11: first parallel call count appears", log, "RLM_CALL_COUNT=1");
	assertContains("N11: second parallel call count appears", log, "RLM_CALL_COUNT=2");
	assertContains("N11: first session file unique", log, "parallel_d1_c1.jsonl");
	assertContains("N11: second session file unique", log, "parallel_d1_c2.jsonl");

	clearYpiEnv();
	resetLog();
	const concurrencyActive = path.join(scratch, "concurrency.active");
	const concurrencyMaximum = path.join(scratch, "concurrency.max");
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "3";
	process.env.RLM_JSON = "0";
	process.env.RLM_MAX_CONCURRENT_CALLS = "3";
	process.env.YPI_FAKE_PI_MODE = "concurrency";
	process.env.YPI_FAKE_CONCURRENCY_ACTIVE = concurrencyActive;
	process.env.YPI_FAKE_CONCURRENCY_MAX = concurrencyMaximum;
	process.env.YPI_FAKE_CONCURRENCY_LOCK = path.join(scratch, "concurrency.lock");
	ensureEnvironment(runtime, context());
	const concurrencyResults = await Promise.all([
		invoke("concurrency one"),
		invoke("concurrency two"),
		invoke("concurrency three"),
		invoke("concurrency four"),
	]);
	record(
		concurrencyResults.every((result) => result.includes("CONCURRENCY_CHILD_OK")),
		"N11a: queued parallel review calls all complete",
	);
	record(
		readFileSync(concurrencyMaximum, "utf8").trim() === "3",
		"N11a: tree-wide child concurrency peaks at three",
		`observed=${readFileSync(concurrencyMaximum, "utf8").trim()}`,
	);

	// N13: a hostile RLM_TRACE_ID cannot escape the session directory via the child session filename.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	process.env.RLM_SESSION_DIR = sessionDir;
	process.env.RLM_TRACE_ID = "../../etc/evil";
	process.env.YPI_FAKE_PI_MODE = "transcript";
		ensureEnvironment(runtime, context());
		await invoke("hostile");
		const traceLog = readLog();
		assertContains(
			"N13: hostile trace id is sanitized in the session filename",
			traceLog,
			`${process.env.RLM_TRACE_ID}_d1_c1.jsonl`,
		);
	assertNotContains("N13: hostile trace id cannot traverse out of the session dir", traceLog, "etc/evil");
	const hostileValidation = spawnSync(process.execPath, [
		transcriptValidator,
		"--trace",
		process.env.PI_TRACE_FILE || "",
		"--session-dir",
		process.env.RLM_SESSION_DIR || "",
	], { encoding: "utf8" });
	record(
		hostileValidation.status === 0,
		"N13: sanitized trace identity also binds the receipt and completion",
		String(hostileValidation.stderr || hostileValidation.stdout || ""),
	);

	// N13b: cancellation crosses the adapter boundary and terminates the detached
	// child process group instead of leaving paid or writable work orphaned.
	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.RLM_JSON = "0";
	process.env.YPI_FAKE_PI_MODE = "sleep";
	ensureEnvironment(runtime, context());
	const controller = new AbortController();
	const cancelStarted = Date.now();
	const cancelled = invoke("cancel child", controller.signal);
	setTimeout(() => controller.abort(), 100);
	await expectThrow("N13b: cancellation returns explicit error", "Child Pi cancelled", () => cancelled);
	record(Date.now() - cancelStarted < 5_000, "N13b: cancellation returns promptly");
	const childPid = Number(/CHILD_PID=(\d+)/.exec(readLog())?.[1] || 0);
	let childAlive = false;
	if (childPid > 0) {
		try { process.kill(childPid, 0); childAlive = true; } catch { /* expected */ }
	}
	record(!childAlive, "N13b: cancelled child process is gone", `pid=${childPid}`);

	clearYpiEnv();
	resetLog();
	process.env.RLM_DEPTH = "0";
	process.env.RLM_MAX_DEPTH = "2";
	process.env.YPI_FAKE_PI_MODE = "json-cost-then-sleep";
	process.env.YPI_FAKE_PID_FILE = path.join(scratch, "cost-cancel.pid");
	ensureEnvironment(runtime, context());
	const costCancelController = new AbortController();
	const costCancelled = invoke("cancel after partial cost", costCancelController.signal);
	for (let attempt = 0; attempt < 100 && !existsSync(process.env.YPI_FAKE_PID_FILE); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	costCancelController.abort();
	await expectThrow("N13c: cancellation after turn_end is explicit", "Child Pi cancelled", () => costCancelled);
	const cancelledCostLedger = readFileSync(process.env.RLM_COST_FILE || "", "utf8");
	assertContains("N13c: known pre-cancel cost remains recorded", cancelledCostLedger, '"cost":0.25');
	assertContains("N13c: cancellation marks final cost boundary incomplete", cancelledCostLedger, '"incomplete":true');

	console.log("");
	console.log(`Results: ${pass} passed, ${fail} failed`);
	if (fail > 0) {
		process.exitCode = 1;
	}
}

try {
	await run();
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

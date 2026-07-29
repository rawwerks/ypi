import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureEnvironment } from "../extensions/ypi/env.ts";
import { appendCostSummary } from "../extensions/ypi/guardrails.ts";
import { appendRuntimeTrace } from "../extensions/ypi/runtime-core.ts";

let passed = 0;
function record(condition: boolean, label: string): void {
	if (!condition) throw new Error(`FAIL ${label}`);
	passed++;
	console.log(`PASS ${label}`);
}

const root = mkdtempSync(path.join(tmpdir(), "ypi-n84-treatment."));
const trace = path.join(root, "trace");
const cost = path.join(root, "cost");
const movedTrace = path.join(root, "trace.owned");
const movedCost = path.join(root, "cost.owned");
const traceCanary = path.join(root, "trace-canary");
const costCanary = path.join(root, "cost-canary");
for (const [candidate, content] of [
	[trace, ""],
	[cost, ""],
	[traceCanary, "TRACE CANARY\n"],
	[costCanary, "COST CANARY\n"],
] as const) {
	writeFileSync(candidate, content, { mode: 0o600 });
	chmodSync(candidate, 0o600);
}

process.env.RLM_TRACE_ID = "n84-treatment";
process.env.RLM_CALL_COUNTER_FILE = path.join(root, "counter");
process.env.RLM_CONCURRENCY_DIR = path.join(root, "concurrency");
process.env.PI_TRACE_FILE = trace;
process.env.RLM_COST_FILE = cost;
process.env.RLM_SHARED_SESSIONS = "0";
ensureEnvironment({
	root: process.cwd(),
	systemPromptPath: "SYSTEM_PROMPT.md",
	rlmQueryPath: "rlm_query",
	extensionPath: "extensions/ypi.ts",
} as never);

appendRuntimeTrace("owned trace");
appendCostSummary({ cost: 1, tokens: 2 });
renameSync(trace, movedTrace);
renameSync(cost, movedCost);
symlinkSync(traceCanary, trace);
symlinkSync(costCanary, cost);
appendRuntimeTrace("replacement trace");
appendCostSummary({ cost: 3, tokens: 4 });

record(
	readFileSync(traceCanary, "utf8") === "TRACE CANARY\n"
		&& readFileSync(costCanary, "utf8") === "COST CANARY\n",
	"replacement trace and cost targets remain byte-exact",
);
record(
	readFileSync(movedTrace, "utf8").includes("owned trace")
		&& !readFileSync(movedTrace, "utf8").includes("replacement trace")
		&& readFileSync(movedCost, "utf8") === '{"cost":1,"tokens":2}\n',
	"owned telemetry inodes receive only pre-replacement records",
);
record(
	process.env.PI_TRACE_FILE === undefined
		&& process.env.RLM_COST_FILE === undefined
		&& process.env.YPI_TRACE_FILE_IDENTITY === undefined
		&& process.env.YPI_COST_FILE_IDENTITY === undefined,
	"each invalid telemetry sink and identity is disabled independently",
);

rmSync(root, { recursive: true, force: true });
console.log(`N84_PASS=${passed}`);

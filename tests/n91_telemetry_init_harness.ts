import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureEnvironment } from "../extensions/ypi/env.ts";

let passed = 0;
function record(condition: boolean, label: string): void {
	if (!condition) throw new Error(`FAIL ${label}`);
	passed++;
	console.log(`PASS ${label}`);
}

const root = mkdtempSync(path.join(tmpdir(), "ypi-n91-treatment."));
const runtime = {
	root: process.cwd(),
	systemPromptPath: "SYSTEM_PROMPT.md",
	rlmQueryPath: "rlm_query",
	extensionPath: "extensions/ypi.ts",
} as never;
process.env.RLM_TRACE_ID = "n91-treatment";
process.env.RLM_CALL_COUNTER_FILE = path.join(root, "counter");
process.env.RLM_CONCURRENCY_DIR = path.join(root, "concurrency");
process.env.RLM_SHARED_SESSIONS = "0";

try {
	const traceCanary = path.join(root, "trace-canary");
	const costCanary = path.join(root, "cost-canary");
	const traceSymlink = path.join(root, "trace-symlink");
	const costHardlink = path.join(root, "cost-hardlink");
	writeFileSync(traceCanary, "TRACE EXACT\n", { mode: 0o644 });
	writeFileSync(costCanary, "COST EXACT\n", { mode: 0o600 });
	chmodSync(traceCanary, 0o644);
	chmodSync(costCanary, 0o600);
	symlinkSync(traceCanary, traceSymlink);
	linkSync(costCanary, costHardlink);
	process.env.PI_TRACE_FILE = traceSymlink;
	process.env.RLM_COST_FILE = costHardlink;
	ensureEnvironment(runtime);
	record(
		process.env.PI_TRACE_FILE === undefined
			&& process.env.RLM_COST_FILE === undefined,
		"symlinked and multiply linked caller sinks are disabled",
	);
	record(
		(lstatSync(traceCanary).mode & 0o777) === 0o644
			&& readFileSync(traceCanary, "utf8") === "TRACE EXACT\n"
			&& (lstatSync(costCanary).mode & 0o777) === 0o600
			&& readFileSync(costCanary, "utf8") === "COST EXACT\n"
			&& lstatSync(costCanary).nlink === 2,
		"invalid caller targets remain byte-, mode-, and link-exact",
	);

	const permissiveTrace = path.join(root, "permissive-trace");
	const validCost = path.join(root, "valid-cost");
	writeFileSync(permissiveTrace, "PERMISSIVE\n", { mode: 0o644 });
	writeFileSync(validCost, "VALID\n", { mode: 0o600 });
	chmodSync(permissiveTrace, 0o644);
	chmodSync(validCost, 0o600);
	process.env.PI_TRACE_FILE = permissiveTrace;
	process.env.RLM_COST_FILE = validCost;
	ensureEnvironment(runtime);
	record(
		process.env.PI_TRACE_FILE === undefined
			&& process.env.RLM_COST_FILE === validCost,
		"wrong-mode caller sink is disabled while valid private sink is retained",
	);
	record(
		(lstatSync(permissiveTrace).mode & 0o777) === 0o644
			&& readFileSync(permissiveTrace, "utf8") === "PERMISSIVE\n",
		"wrong-mode caller sink is not repaired or mutated",
	);

	const absentTrace = path.join(root, "absent-trace");
	const absentCost = path.join(root, "absent-cost");
	process.env.PI_TRACE_FILE = absentTrace;
	process.env.RLM_COST_FILE = absentCost;
	const previousUmask = process.umask(0o777);
	try {
		ensureEnvironment(runtime);
	} finally {
		process.umask(previousUmask);
	}
	record(
		process.env.PI_TRACE_FILE === absentTrace
			&& process.env.RLM_COST_FILE === absentCost
			&& existsSync(absentTrace)
			&& existsSync(absentCost)
			&& (lstatSync(absentTrace).mode & 0o777) === 0o600
			&& (lstatSync(absentCost).mode & 0o777) === 0o600,
		"absent owned sinks are created no-clobber with exact modes under umask 0777",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`N91_PASS=${passed}`);

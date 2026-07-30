import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ensureRootTreeCoordinator,
	terminateRootTreeCoordinator,
} from "../extensions/ypi/internal/tree-coordinator.ts";

const separator = process.argv.indexOf("--", 2);
const depth = process.argv[2];
if (
	separator !== 3
	|| !/^[1-9][0-9]*$/.test(depth || "")
	|| separator === process.argv.length - 1
) {
	throw new Error(
		"usage: bun tests/tree_authority_runner.ts <positive-depth> -- <command> [args...]",
	);
}

const scratch = mkdtempSync(path.join(tmpdir(), "yt."));
process.env.RLM_DEPTH = "0";
process.env.RLM_CONCURRENCY_DIR = path.join(scratch, "c");
process.env.RLM_CALL_COUNTER_FILE ||= path.join(scratch, "calls.counter");
process.env.RLM_MAX_CONCURRENT_CALLS ||= "3";
process.env.RLM_MAX_CALLS ||= "65536";
process.env.RLM_CALL_COUNT ||= "0";
delete process.env.RLM_ACTIVE_SLOT_TOKEN;
ensureRootTreeCoordinator();

const command = process.argv.slice(separator + 1);
try {
	const child = spawn(command[0], command.slice(1), {
		env: { ...process.env, RLM_DEPTH: depth },
		stdio: "inherit",
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		},
	);
	process.exitCode = result.code ?? (result.signal ? 128 : 1);
} finally {
	await terminateRootTreeCoordinator("test-authority-runner-complete");
	rmSync(scratch, { recursive: true, force: true });
}

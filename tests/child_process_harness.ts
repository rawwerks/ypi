import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChildProcess } from "../extensions/ypi/internal/child-process.ts";

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

console.log("\n=== Child process terminality harness ===");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_child_process."));
const previousPi = process.env.YPI_PI_BIN;

try {
	process.env.YPI_PI_BIN = process.execPath;
	let childPid = 0;
	let observed: unknown;
	try {
		await runChildProcess({
			args: ["-e", "setInterval(() => {}, 1000)"],
			env: process.env,
			cwd: scratch,
			jsonMode: false,
			onSpawn(pid) {
				childPid = pid;
				throw new Error("synthetic lease registration failure");
			},
		});
	} catch (error) {
		observed = error;
	}
	record(
		observed instanceof Error
			&& observed.message === "synthetic lease registration failure",
		"PID registration failure remains the primary error",
		observed instanceof Error ? observed.message : String(observed),
	);
	record(
		childPid > 0 && !processAlive(childPid),
		"PID registration failure settles only after the child is reaped",
		`pid=${childPid} alive=${childPid > 0 && processAlive(childPid)}`,
	);

	process.env.YPI_PI_BIN = path.join(scratch, "missing-pi");
	let spawnFailure: unknown;
	try {
		await runChildProcess({
			args: [],
			env: process.env,
			cwd: scratch,
			jsonMode: false,
		});
	} catch (error) {
		spawnFailure = error;
	}
	record(
		spawnFailure instanceof Error
			&& (spawnFailure as NodeJS.ErrnoException).code === "ENOENT",
		"spawn failure reaches a terminal close error",
		spawnFailure instanceof Error ? spawnFailure.message : String(spawnFailure),
	);
} finally {
	if (previousPi === undefined) delete process.env.YPI_PI_BIN;
	else process.env.YPI_PI_BIN = previousPi;
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

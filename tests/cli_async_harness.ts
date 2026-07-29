#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	discardAsyncJob,
	type AsyncJob,
	waitForAsyncAdmission,
} from "../extensions/ypi/internal/cli-async.ts";

let passed = 0;
let failed = 0;

function record(ok: boolean, name: string, detail = ""): void {
	if (ok) {
		console.log(`PASS: ${name}`);
		passed++;
		return;
	}
	console.error(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
	failed++;
}

function fixture(name: string): AsyncJob {
	const directory = path.join(tmpdir(), `ypi_cli_async_${process.pid}_${name}`);
	rmSync(directory, { recursive: true, force: true });
	mkdirSync(directory, { recursive: true });
	const jobPath = path.join(directory, "job.json");
	const outputPath = path.join(directory, "output.txt");
	writeFileSync(jobPath, "{}\n");
	writeFileSync(outputPath, "");
	return {
		prompt: "test",
		fork: false,
		cwd: process.cwd(),
		outputPath,
		sentinelPath: path.join(directory, "done"),
		admissionPath: path.join(directory, "admitted"),
		childPidPath: path.join(directory, "child.pid"),
		jobPath,
		extensionPath: null,
		treeStartTimeSeconds: Math.floor(Date.now() / 1000),
	};
}

const live = fixture("live");
let liveError = "";
try {
	discardAsyncJob(live, 999_999);
} catch (error) {
	liveError = error instanceof Error ? error.message : String(error);
}
record(
	liveError.includes("Refusing to discard non-terminal async job state")
		&& existsSync(path.dirname(live.jobPath)),
	"non-terminal launched job state cannot be discarded",
	liveError,
);
writeFileSync(live.sentinelPath, "143\n");
discardAsyncJob(live, 999_999);
record(!existsSync(path.dirname(live.jobPath)), "terminal launched job state can be discarded");

const unlaunched = fixture("unlaunched");
discardAsyncJob(unlaunched);
record(!existsSync(path.dirname(unlaunched.jobPath)), "unlaunched job state can be discarded");

const delayed = fixture("delayed");
setTimeout(() => writeFileSync(delayed.admissionPath, "accepted\n"), 40);
await waitForAsyncAdmission(delayed);
record(existsSync(delayed.admissionPath), "admission wait has no implicit product timeout");
rmSync(path.dirname(delayed.jobPath), { recursive: true, force: true });

const bounded = fixture("bounded");
let timeoutError = "";
try {
	await waitForAsyncAdmission(bounded, 20);
} catch (error) {
	timeoutError = error instanceof Error ? error.message : String(error);
}
record(
	timeoutError.includes("Async recursion admission timed out after 20ms"),
	"configured admission timeout remains enforceable",
	timeoutError,
);
rmSync(path.dirname(bounded.jobPath), { recursive: true, force: true });

console.log(`\nAsync CLI state tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

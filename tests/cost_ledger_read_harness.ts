#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	MAX_COST_LEDGER_BYTES,
	readCostSummary,
	setCostLedgerReadLifecycleHookForTests,
} from "../extensions/ypi/guardrails.ts";
import { capturePrivateFileIdentity } from "../extensions/ypi/internal/private-path.ts";

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

function privateFile(root: string, name: string, content: string): string {
	const candidate = path.join(root, name);
	writeFileSync(candidate, content, { mode: 0o600 });
	chmodSync(candidate, 0o600);
	return candidate;
}

function installSink(candidate: string): void {
	process.env.RLM_COST_FILE = candidate;
	process.env.YPI_COST_FILE_IDENTITY = JSON.stringify(
		capturePrivateFileIdentity(candidate),
	);
}

function invalidSinkIsObservational(candidate: string, name: string): void {
	process.env.RLM_COST_FILE = candidate;
	delete process.env.YPI_COST_FILE_IDENTITY;
	const started = Date.now();
	let summary;
	let error = "";
	try {
		summary = readCostSummary();
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	record(
		!error
			&& summary?.cost === 0
			&& summary.tokens === 0
			&& summary.incomplete
			&& process.env.RLM_COST_FILE === undefined
			&& process.env.YPI_COST_FILE_IDENTITY === undefined
			&& Date.now() - started < 1_000,
		name,
		error || JSON.stringify(summary),
	);
}

const root = mkdtempSync(path.join(tmpdir(), "ypi_cost_read."));
try {
	const valid = privateFile(
		root,
		"valid.jsonl",
		'{"cost":1.25,"tokens":125}\nmalformed\n{"cost":0.5,"tokens":50,"incomplete":true}\n',
	);
	installSink(valid);
	const validSummary = readCostSummary();
	record(
		validSummary.cost === 1.75
			&& validSummary.tokens === 175
			&& validSummary.incomplete
			&& process.env.RLM_COST_FILE === valid,
		"private bounded ledger is summarized without disabling its sink",
		JSON.stringify(validSummary),
	);

	const fifo = path.join(root, "fifo");
	const mkfifo = spawnSync("mkfifo", ["-m", "600", fifo], { encoding: "utf8" });
	if (mkfifo.status !== 0) throw new Error(mkfifo.stderr || "mkfifo failed");
	invalidSinkIsObservational(fifo, "FIFO ledger is rejected without blocking product work");

	const symlinkTarget = privateFile(root, "symlink-target", '{"cost":99,"tokens":99}\n');
	const symlink = path.join(root, "symlink");
	symlinkSync(symlinkTarget, symlink);
	invalidSinkIsObservational(symlink, "symlink ledger is rejected without following it");

	const hardlink = privateFile(root, "hardlink", '{"cost":99,"tokens":99}\n');
	linkSync(hardlink, path.join(root, "hardlink-alias"));
	invalidSinkIsObservational(hardlink, "multiply linked ledger is rejected");

	const permissive = privateFile(root, "permissive", '{"cost":99,"tokens":99}\n');
	chmodSync(permissive, 0o644);
	invalidSinkIsObservational(permissive, "wrong-mode ledger is rejected");

	const oversized = privateFile(root, "oversized", "");
	truncateSync(oversized, MAX_COST_LEDGER_BYTES + 1);
	invalidSinkIsObservational(oversized, "oversized sparse ledger is rejected before allocation");

	const replaced = privateFile(root, "replaced", '{"cost":2,"tokens":20}\n');
	installSink(replaced);
	const original = `${replaced}.original`;
	setCostLedgerReadLifecycleHookForTests(() => {
		renameSync(replaced, original);
		privateFile(root, "replaced", '{"cost":2,"tokens":20}\n');
	});
	const replacedSummary = readCostSummary();
	setCostLedgerReadLifecycleHookForTests(undefined);
	record(
		replacedSummary.cost === 0
			&& replacedSummary.tokens === 0
			&& replacedSummary.incomplete
			&& process.env.RLM_COST_FILE === undefined,
		"pathname replacement during observation is rejected",
		JSON.stringify(replacedSummary),
	);
} finally {
	setCostLedgerReadLifecycleHookForTests(undefined);
	delete process.env.RLM_COST_FILE;
	delete process.env.YPI_COST_FILE_IDENTITY;
	rmSync(root, { recursive: true, force: true });
}

console.log(`\nCost-ledger read tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

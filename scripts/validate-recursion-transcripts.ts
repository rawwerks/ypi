#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { safeTraceId } from "../extensions/ypi/env.ts";
import {
	type TranscriptReceipt,
	verifyTranscriptReceipt,
} from "../extensions/ypi/internal/transcript.ts";

interface ExpectedTranscript {
	traceId: string;
	parentDepth: number;
	childDepth: number;
	callCount: number;
	exitCode?: number;
}

interface ValidatorArguments {
	traceFile: string;
	sessionDir: string;
	allowRelocated: boolean;
}

function usage(): never {
	console.error(
		"usage: validate-recursion-transcripts.ts --trace <trace-file> --session-dir <directory> [--allow-relocated]",
	);
	process.exit(2);
}

function argumentsFrom(argv: string[]): ValidatorArguments {
	let traceFile = "";
	let sessionDir = "";
	let allowRelocated = false;
	for (let index = 0; index < argv.length;) {
		const flag = argv[index++];
		if (flag === "--allow-relocated") {
			allowRelocated = true;
			continue;
		}
		const value = argv[index++];
		if (!value) usage();
		if (flag === "--trace") traceFile = value;
		else if (flag === "--session-dir") sessionDir = value;
		else usage();
	}
	if (!traceFile || !sessionDir) usage();
	return { traceFile, sessionDir, allowRelocated };
}

function callKey(value: ExpectedTranscript): string {
	return `${value.traceId}\0${value.parentDepth}\0${value.childDepth}\0${value.callCount}`;
}

function expectedTranscripts(traceFile: string): ExpectedTranscript[] {
	const starts = new Map<string, ExpectedTranscript>();
	const completions = new Map<string, {
		exitCode: number;
		transcriptStatus: string;
	}>();
	const start = /\bdepth=(\d+)→(\d+)\b.*\bcall=(\d+)\s+trace=([^\s]+)/;
	const completion = /\bdepth=(\d+)\s+child_depth=(\d+)\s+COMPLETED\s+exit=(\d+)\b.*\bcall=(\d+)\b.*\btrace=([^\s]+)\s+.*\btranscript=(verified|failed|not-required)\b/;
	for (const line of readFileSync(traceFile, "utf8").split(/\r?\n/)) {
		const startMatch = start.exec(line);
		if (startMatch) {
			const value: ExpectedTranscript = {
				traceId: safeTraceId(startMatch[4]),
				parentDepth: Number(startMatch[1]),
				childDepth: Number(startMatch[2]),
				callCount: Number(startMatch[3]),
			};
			const key = callKey(value);
			if (starts.has(key)) throw new Error(`trace contains duplicate child start: call ${value.callCount}`);
			starts.set(key, value);
			continue;
		}
		const completionMatch = completion.exec(line);
		if (!completionMatch) continue;
		const completedIdentity: ExpectedTranscript = {
			traceId: safeTraceId(completionMatch[5]),
			parentDepth: Number(completionMatch[1]),
			childDepth: Number(completionMatch[2]),
			callCount: Number(completionMatch[4]),
		};
		const key = callKey(completedIdentity);
		const matching = starts.get(key);
		if (!matching) {
			throw new Error(`trace contains completion without a matching start: call ${completionMatch[4]}`);
		}
		if (completions.has(key)) {
			throw new Error(`trace contains duplicate child completion: call ${matching.callCount}`);
		}
		completions.set(key, {
			exitCode: Number(completionMatch[3]),
			transcriptStatus: completionMatch[6],
		});
	}
	if (starts.size === 0) {
		throw new Error(`trace contains no admitted recursive child starts: ${traceFile}`);
	}
	for (const [key, value] of starts) {
		const completionValue = completions.get(key);
		if (!completionValue) {
			throw new Error(`trace child has no terminal completion: call ${value.callCount}`);
		}
		if (completionValue.transcriptStatus !== "verified") {
			throw new Error(
				`trace child transcript was not verified: call ${value.callCount} status=${completionValue.transcriptStatus}`,
			);
		}
		value.exitCode = completionValue.exitCode;
	}
	return [...starts.values()];
}

function receiptMatches(
	receipt: TranscriptReceipt,
	expected: ExpectedTranscript,
): boolean {
	return (
		receipt.trace_id === expected.traceId
		&& receipt.parent_depth === expected.parentDepth
		&& receipt.child_depth === expected.childDepth
		&& receipt.call_count === expected.callCount
		&& receipt.child_exit_code === expected.exitCode
	);
}

function main(): void {
	const { traceFile, sessionDir, allowRelocated } = argumentsFrom(
		process.argv.slice(2),
	);
	const directoryMetadata = lstatSync(sessionDir);
	if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
		throw new Error(`session directory is not a regular non-symlink directory: ${sessionDir}`);
	}
	const expected = expectedTranscripts(traceFile);
	const expectedReceiptNames = new Set<string>();
	const expectedTranscriptNames = new Set<string>();
	for (const item of expected) {
		const transcriptFile = `${item.traceId}_d${item.childDepth}_c${item.callCount}.jsonl`;
		const receipt = verifyTranscriptReceipt(
			sessionDir,
			transcriptFile,
			!allowRelocated,
		);
		if (!receiptMatches(receipt, item)) {
			throw new Error(`transcript receipt does not match trace call ${item.callCount}`);
		}
		expectedTranscriptNames.add(transcriptFile);
		expectedReceiptNames.add(`${transcriptFile}.receipt.json`);
	}
	const traceIds = new Set(expected.map((item) => item.traceId));
	const tracePatterns = [...traceIds].map((traceId) => (
		new RegExp(
			`^${traceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_d\\d+_c\\d+\\.jsonl$`,
		)
	));
	const observedReceipts = readdirSync(sessionDir).filter((name) => (
		name.endsWith(".jsonl.receipt.json")
		&& [...traceIds].some((traceId) => name.startsWith(`${traceId}_d`))
	));
	for (const receipt of observedReceipts) {
		if (!expectedReceiptNames.has(receipt)) {
			throw new Error(`orphan transcript receipt is not represented by the trace: ${receipt}`);
		}
	}
	const observedTranscripts = readdirSync(sessionDir).filter((name) => (
		name.endsWith(".jsonl")
		&& tracePatterns.some((pattern) => pattern.test(name))
	));
	for (const transcript of observedTranscripts) {
		if (!expectedTranscriptNames.has(transcript)) {
			throw new Error(
				`orphan child transcript is not represented by the trace: ${transcript}`,
			);
		}
	}
	if (observedTranscripts.length !== expectedTranscriptNames.size) {
		throw new Error(
			`transcript file count mismatch: expected ${expectedTranscriptNames.size}, found ${observedTranscripts.length}`,
		);
	}
	if (observedReceipts.length !== expectedReceiptNames.size) {
		throw new Error(
			`transcript receipt count mismatch: expected ${expectedReceiptNames.size}, found ${observedReceipts.length}`,
		);
	}
	console.log(`TRANSCRIPT_VALIDATION=PASS calls=${expected.length}`);
}

try {
	main();
} catch (error) {
	console.error(
		`TRANSCRIPT_VALIDATION=FAIL ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}

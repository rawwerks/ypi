#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeTraceId } from "../extensions/ypi/env.ts";
import { validateTranscriptAppend } from "../extensions/ypi/internal/transcript.ts";

interface ExpectedTranscript {
	traceId: string;
	childDepth: number;
	callCount: number;
}

function usage(): never {
	console.error(
		"usage: validate-recursion-transcripts.ts --trace <trace-file> --session-dir <directory>",
	);
	process.exit(2);
}

function argumentsFrom(argv: string[]): { traceFile: string; sessionDir: string } {
	let traceFile = "";
	let sessionDir = "";
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!value) usage();
		if (flag === "--trace") traceFile = value;
		else if (flag === "--session-dir") sessionDir = value;
		else usage();
	}
	if (!traceFile || !sessionDir) usage();
	return { traceFile, sessionDir };
}

function expectedTranscripts(traceFile: string): ExpectedTranscript[] {
	const expected = new Map<string, ExpectedTranscript>();
	const start = /\bdepth=(\d+)→(\d+)\b.*\bcall=(\d+)\s+trace=([^\s]+)/;
	for (const line of readFileSync(traceFile, "utf8").split(/\r?\n/)) {
		const match = start.exec(line);
		if (!match) continue;
		const value: ExpectedTranscript = {
			traceId: safeTraceId(match[4]),
			childDepth: Number(match[2]),
			callCount: Number(match[3]),
		};
		expected.set(
			`${value.traceId}\0${value.childDepth}\0${value.callCount}`,
			value,
		);
	}
	return [...expected.values()];
}

function main(): void {
	const { traceFile, sessionDir } = argumentsFrom(process.argv.slice(2));
	const directoryMetadata = lstatSync(sessionDir);
	if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
		throw new Error(`session directory is not a regular non-symlink directory: ${sessionDir}`);
	}
	const expected = expectedTranscripts(traceFile);
	if (expected.length === 0) {
		throw new Error(`trace contains no admitted recursive child starts: ${traceFile}`);
	}
	for (const item of expected) {
		const candidate = path.join(
			sessionDir,
			`${item.traceId}_d${item.childDepth}_c${item.callCount}.jsonl`,
		);
		validateTranscriptAppend(candidate, 0);
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

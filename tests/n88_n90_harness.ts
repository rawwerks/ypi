import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ensureEnvironment,
	safeTraceId,
} from "../extensions/ypi/env.ts";
import {
	prepareTranscriptProof,
	setTranscriptLifecycleHookForTests,
} from "../extensions/ypi/internal/transcript.ts";

let passed = 0;
function record(condition: boolean, label: string): void {
	if (!condition) throw new Error(`FAIL ${label}`);
	passed++;
	console.log(`PASS ${label}`);
}

const root = mkdtempSync(path.join(tmpdir(), "ypi-n88-n90."));
chmodSync(root, 0o700);
try {
	const sessionDirectory = path.join(root, "sessions");
	const childSession = path.join(sessionDirectory, "trace_d1_c1.jsonl");
	mkdirSync(sessionDirectory, { mode: 0o700 });
	chmodSync(sessionDirectory, 0o700);
	writeFileSync(childSession, "PREEXISTING TARGET\n", { flag: "wx", mode: 0o600 });
	process.env.RLM_REQUIRE_TRANSCRIPTS = "1";
	let temporary = "";
	setTranscriptLifecycleHookForTests((stage, temporaryPath) => {
		if (stage !== "before-publish") return;
		temporary = temporaryPath;
		unlinkSync(temporaryPath);
		writeFileSync(temporaryPath, "SUCCESSOR ONLY COPY\n", {
			flag: "wx",
			mode: 0o600,
		});
	});
	let error: unknown;
	try {
		prepareTranscriptProof({ childSession });
	} catch (caught) {
		error = caught;
	} finally {
		setTranscriptLifecycleHookForTests(undefined);
	}
	record(error instanceof AggregateError, "replacement makes cleanup failure explicit");
	record(
		existsSync(temporary)
			&& readFileSync(temporary, "utf8") === "SUCCESSOR ONLY COPY\n",
		"replacement temporary survives byte-exact",
	);
	record(
		readFileSync(childSession, "utf8") === "PREEXISTING TARGET\n",
		"pre-existing transcript target survives byte-exact",
	);

	const postRetireSession = path.join(sessionDirectory, "post_retire_d1_c2.jsonl");
	let postRetireTemporary = "";
	setTranscriptLifecycleHookForTests((stage, temporaryPath) => {
		if (stage === "before-publish") postRetireTemporary = temporaryPath;
		if (stage === "after-temporary-retire") throw new Error("injected post-retire failure");
	});
	let postRetireError: unknown;
	try {
		prepareTranscriptProof({ childSession: postRetireSession });
	} catch (caught) {
		postRetireError = caught;
	} finally {
		setTranscriptLifecycleHookForTests(undefined);
	}
	record(
		postRetireError instanceof Error
			&& !(postRetireError instanceof AggregateError)
			&& postRetireError.message === "injected post-retire failure",
		"post-retirement failure preserves the primary error without double cleanup",
	);
	record(
		existsSync(postRetireSession) && !existsSync(postRetireTemporary),
		"post-retirement failure leaves no temporary pathname",
	);

	const longTrace = "x".repeat(300);
	const mapped = safeTraceId(longTrace);
	record(mapped.length === 64, "long trace ID maps to a 64-character component");
	record(mapped === safeTraceId(longTrace), "long trace mapping is deterministic");
	record(safeTraceId("short.trace-1") === "short.trace-1", "short trace ID is unchanged");

	for (const variable of [
		"RLM_CALL_COUNTER_FILE",
		"RLM_CONCURRENCY_DIR",
		"PI_TRACE_FILE",
		"RLM_COST_FILE",
	]) {
		delete process.env[variable];
	}
	process.env.RLM_TRACE_ID = longTrace;
	process.env.RLM_DEPTH = "0";
	process.env.RLM_SHARED_SESSIONS = "0";
	ensureEnvironment({
		root: process.cwd(),
		systemPromptPath: "SYSTEM_PROMPT.md",
		rlmQueryPath: "rlm_query",
		extensionPath: "extensions/ypi.ts",
	} as never);
	record(
		process.env.RLM_TRACE_ID === mapped
			&& Boolean(process.env.RLM_CALL_COUNTER_FILE?.includes(mapped)),
		"public environment initialization uses the shared bounded identity",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(`N88_N90_PASS=${passed}`);

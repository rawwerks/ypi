import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";

const MAX_VALIDATED_EVENT_BYTES = 1024 * 1024;

export function transcriptsRequired(): boolean {
	const configured = process.env.RLM_REQUIRE_TRANSCRIPTS || "0";
	if (configured !== "0" && configured !== "1") {
		const error = new Error(
			`Invalid RLM_REQUIRE_TRANSCRIPTS: ${JSON.stringify(configured)} must be 0 or 1.`,
		) as Error & { exitCode: number };
		error.exitCode = 1;
		throw error;
	}
	return configured === "1";
}

function regularTranscriptSize(candidate: string): number | undefined {
	let metadata;
	try {
		metadata = lstatSync(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error(`Required child transcript is not a regular non-symlink file: ${candidate}`);
	}
	return metadata.size;
}

export function requiredTranscriptBaseline(childSession: string | undefined): number | undefined {
	if (!transcriptsRequired()) return undefined;
	if (!childSession) {
		throw new Error(
			"RLM_REQUIRE_TRANSCRIPTS=1 requires RLM_SHARED_SESSIONS=1 and an explicit child session directory; do not run the root with --no-session.",
		);
	}
	return regularTranscriptSize(childSession) ?? 0;
}

export function validateTranscriptAppend(
	childSession: string | undefined,
	baselineBytes: number | undefined,
): void {
	if (baselineBytes === undefined) return;
	if (!childSession) {
		throw new Error("Required child transcript path became unavailable.");
	}
	const observedBytes = regularTranscriptSize(childSession);
	if (observedBytes === undefined) {
		throw new Error(
			`Required child transcript did not append a session event because the file was not created: ${childSession}`,
		);
	}
	if (observedBytes <= baselineBytes) {
		throw new Error(
			`Required child transcript did not append a session event: ${childSession}`,
		);
	}

	let descriptor: number | undefined;
	try {
		descriptor = openSync(childSession, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) {
			throw new Error(`Required child transcript is not a regular file: ${childSession}`);
		}
		const available = Math.min(
			metadata.size - baselineBytes,
			MAX_VALIDATED_EVENT_BYTES + 1,
		);
		const buffer = Buffer.alloc(available);
		const bytesRead = readSync(descriptor, buffer, 0, available, baselineBytes);
		const appended = buffer.subarray(0, bytesRead);
		const newline = appended.indexOf(0x0a);
		if (newline < 0) {
			throw new Error(
				`Required child transcript appended no complete JSONL event within ${MAX_VALIDATED_EVENT_BYTES} bytes: ${childSession}`,
			);
		}
		const line = appended.subarray(0, newline).toString("utf8").replace(/\r$/, "");
		if (!line) {
			throw new Error(`Required child transcript appended an empty JSONL event: ${childSession}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`Required child transcript appended invalid JSONL: ${childSession}`);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Required child transcript appended a non-object JSONL event: ${childSession}`);
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

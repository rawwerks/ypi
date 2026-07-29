import { createHash } from "node:crypto";
import path from "node:path";
import {
	implementerLeaseRecordDigest,
	parseImplementerLeaseRecord,
	type ImplementerLeaseRecord,
} from "./implementer-lease.ts";
import {
	appendOwnedPrivateFileTransaction,
	assertPrivatePathIdentity,
	capturePrivateFileIdentity,
	readOwnedPrivateFileBytes,
	type AppendOwnedPrivateFileTransactionOptions,
	type PrivatePathIdentity,
} from "./private-path.ts";

interface JournalLine {
	content: Buffer;
	start: number;
	end: number;
}

interface LeaseJournalState {
	record: ImplementerLeaseRecord;
	observedBytes: number;
	committedBytes: number;
}

export type ImplementerLeaseWriteOptions = AppendOwnedPrivateFileTransactionOptions;

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const commitPrefix = Buffer.from("commit\t");
const commitPattern = /^commit\t(0|[1-9][0-9]*)\t(0|[1-9][0-9]*)\t([a-f0-9]{64})$/;

function sameIdentity(
	left: PrivatePathIdentity,
	right: PrivatePathIdentity,
): boolean {
	return left.device === right.device
		&& left.inode === right.inode
		&& left.kind === right.kind
		&& left.mode === right.mode
		&& left.links === right.links;
}

function recordPayload(record: ImplementerLeaseRecord): Buffer {
	return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function payloadDigest(payload: Uint8Array): string {
	return createHash("sha256").update(payload).digest("hex");
}

function commitRecord(
	record: ImplementerLeaseRecord,
	payload: Buffer,
): Buffer {
	return Buffer.from(
		`commit\t${record.revision}\t${payload.length}\t${payloadDigest(payload)}\n`,
		"ascii",
	);
}

function assertImmutableLeaseState(
	previous: ImplementerLeaseRecord,
	current: ImplementerLeaseRecord,
): void {
	if (
		!sameIdentity(previous.leaseDirectoryIdentity, current.leaseDirectoryIdentity)
		|| !sameIdentity(previous.leaseFileIdentity, current.leaseFileIdentity)
		|| previous.ownerPid !== current.ownerPid
		|| previous.createdAtEpochSeconds !== current.createdAtEpochSeconds
		|| previous.root !== current.root
		|| previous.commonGitDir !== current.commonGitDir
		|| previous.baselineHead !== current.baselineHead
		|| previous.attemptRef !== current.attemptRef
		|| previous.scope.join("\0") !== current.scope.join("\0")
	) {
		throw new Error(`Implementer lease ${current.token} changed immutable state`);
	}
}

function completeLines(raw: Buffer): JournalLine[] {
	const lines: JournalLine[] = [];
	let offset = 0;
	while (offset < raw.length) {
		const terminator = raw.indexOf(0x0a, offset);
		if (terminator < 0) break;
		lines.push({
			content: raw.subarray(offset, terminator),
			start: offset,
			end: terminator + 1,
		});
		offset = terminator + 1;
	}
	return lines;
}

function decodeCompleteLine(
	line: Buffer,
	expectedToken: string,
	kind: "payload" | "commit",
): string {
	try {
		return fatalUtf8.decode(line);
	} catch {
		throw new Error(
			`Implementer lease ${expectedToken} has invalid UTF-8 in a committed ${kind}`,
		);
	}
}

function readLeaseJournal(
	leaseDirectory: string,
	expectedToken: string,
	commonGitDir: string,
): LeaseJournalState {
	const recordPath = path.join(leaseDirectory, "lease.json");
	const observedIdentity = capturePrivateFileIdentity(recordPath);
	const raw = readOwnedPrivateFileBytes(recordPath, observedIdentity);
	const lines = completeLines(raw);

	let record: ImplementerLeaseRecord | undefined;
	let committedBytes = 0;
	let lineIndex = 0;
	while (lineIndex + 1 < lines.length) {
		const payloadLine = lines[lineIndex];
		const commitLine = lines[lineIndex + 1];
		const commitText = decodeCompleteLine(
			commitLine.content,
			expectedToken,
			"commit",
		);
		const commit = commitPattern.exec(commitText);
		if (!commit) {
			throw new Error(`Implementer lease ${expectedToken} has a malformed complete commit`);
		}
		const revision = Number(commit[1]);
		const length = Number(commit[2]);
		if (
			!Number.isSafeInteger(revision)
			|| !Number.isSafeInteger(length)
			|| length !== payloadLine.end - payloadLine.start
		) {
			throw new Error(`Implementer lease ${expectedToken} has an invalid complete commit length`);
		}
		const payload = raw.subarray(payloadLine.start, payloadLine.end);
		if (payloadDigest(payload) !== commit[3]) {
			throw new Error(`Implementer lease ${expectedToken} has a complete commit digest mismatch`);
		}
		const payloadText = decodeCompleteLine(
			payloadLine.content,
			expectedToken,
			"payload",
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(payloadText);
		} catch {
			throw new Error(`Implementer lease ${expectedToken} has malformed committed state`);
		}
		const current = parseImplementerLeaseRecord(
			parsed,
			expectedToken,
			commonGitDir,
		);
		const expectedRevision = record ? record.revision + 1 : 0;
		if (
			revision !== expectedRevision
			|| current.revision !== revision
		) {
			throw new Error(`Implementer lease ${expectedToken} has a non-contiguous committed revision`);
		}
		if (!sameIdentity(observedIdentity, current.leaseFileIdentity)) {
			throw new Error("implementer lease record identity changed");
		}
		if (record) assertImmutableLeaseState(record, current);
		record = current;
		committedBytes = commitLine.end;
		lineIndex += 2;
	}

	if (
		lineIndex < lines.length
		&& lines[lineIndex].content.subarray(0, commitPrefix.length).equals(commitPrefix)
	) {
		throw new Error(`Implementer lease ${expectedToken} has an orphan complete commit`);
	}
	if (!record) {
		throw new Error(`Implementer lease ${expectedToken} has no complete committed revision`);
	}
	assertPrivatePathIdentity(leaseDirectory, record.leaseDirectoryIdentity);
	assertPrivatePathIdentity(recordPath, record.leaseFileIdentity);
	return {
		record,
		observedBytes: raw.length,
		committedBytes,
	};
}

export function readImplementerLeaseFile(
	leaseDirectory: string,
	expectedToken: string,
	commonGitDir: string,
): ImplementerLeaseRecord {
	return readLeaseJournal(leaseDirectory, expectedToken, commonGitDir).record;
}

export function writeImplementerLeaseFile(
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
	options: ImplementerLeaseWriteOptions = {},
): void {
	const persisted = readLeaseJournal(
		leaseDirectory,
		record.token,
		record.commonGitDir,
	);
	if (
		persisted.record.revision !== record.revision
		|| persisted.record.recordDigest !== record.recordDigest
	) {
		throw new Error("implementer lease record contents changed");
	}
	assertImmutableLeaseState(persisted.record, record);
	const next: ImplementerLeaseRecord = {
		...record,
		revision: record.revision + 1,
		recordDigest: "",
	};
	next.recordDigest = implementerLeaseRecordDigest(next);
	const payload = recordPayload(next);
	appendOwnedPrivateFileTransaction(
		path.join(leaseDirectory, "lease.json"),
		record.leaseFileIdentity,
		persisted.observedBytes,
		persisted.committedBytes,
		payload,
		commitRecord(next, payload),
		options,
	);
	Object.assign(record, next);
}

export function initializeImplementerLeaseFile(
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): void {
	assertPrivatePathIdentity(leaseDirectory, record.leaseDirectoryIdentity);
	const recordPath = path.join(leaseDirectory, "lease.json");
	const observed = readOwnedPrivateFileBytes(recordPath, record.leaseFileIdentity);
	if (observed.length !== 0 || record.revision !== 0) {
		throw new Error("implementer lease journal is not empty at initialization");
	}
	parseImplementerLeaseRecord(record, record.token, record.commonGitDir);
	const payload = recordPayload(record);
	appendOwnedPrivateFileTransaction(
		recordPath,
		record.leaseFileIdentity,
		0,
		0,
		payload,
		commitRecord(record, payload),
	);
}

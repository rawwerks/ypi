import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import path from "node:path";
import { atomicCreateFile } from "./atomic-file.ts";
import {
	assertDirectoryIdentity,
	assertPrivateRegularFile,
	checkedSize,
	type DirectoryLease,
	digestRegion,
	type FileIdentity,
	identityOf,
	openSecureDirectory,
	PRIVATE_FILE_MODE,
	proofError,
	validateJsonlRegion,
} from "./transcript-proof-io.ts";

export interface TranscriptProofLease extends FileIdentity {
	baselineBytes: number;
	baselineSha256: string;
	childSession: string;
	descriptor: number;
	directory: DirectoryLease;
	receiptPath: string;
}

export interface TranscriptProofIdentity {
	traceId: string;
	parentDepth: number;
	childDepth: number;
	callCount: number;
	childExitCode: number;
}

export interface TranscriptReceipt {
	schema_version: 1;
	trace_id: string;
	parent_depth: number;
	child_depth: number;
	call_count: number;
	child_exit_code: number;
	transcript_file: string;
	baseline_bytes: number;
	baseline_sha256: string;
	final_bytes: number;
	final_sha256: string;
	runtime_device: string;
	runtime_inode: string;
	message_events_appended: number;
}

export interface PrepareTranscriptProofInput {
	childSession?: string;
	forkSource?: string;
}

interface ForkSourceLease {
	descriptor: number;
	bytes: number;
	sha256: string;
}

export function transcriptsRequired(): boolean {
	const configured = process.env.RLM_REQUIRE_TRANSCRIPTS || "0";
	if (configured !== "0" && configured !== "1") {
		throw proofError(
			`Invalid RLM_REQUIRE_TRANSCRIPTS: ${JSON.stringify(configured)} must be 0 or 1.`,
		);
	}
	return configured === "1";
}

function openSecureForkSource(sourcePath: string): ForkSourceLease {
	if (!path.isAbsolute(sourcePath)) {
		throw proofError(
			`RLM_REQUIRE_TRANSCRIPTS=1 requires an absolute fork source path: ${sourcePath}`,
		);
	}
	const descriptor = openSync(
		sourcePath,
		constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
	);
	try {
		const metadata = fstatSync(descriptor, { bigint: true });
		const pathMetadata = lstatSync(sourcePath, { bigint: true });
		assertPrivateRegularFile(metadata, "Required fork source");
		if (
			pathMetadata.isSymbolicLink()
			|| !pathMetadata.isFile()
			|| pathMetadata.dev !== metadata.dev
			|| pathMetadata.ino !== metadata.ino
		) {
			throw proofError("Required fork source identity changed during admission.");
		}
		const size = checkedSize(metadata.size, "Required fork source");
		if (size === 0) throw proofError("Required fork source is empty.");
		validateJsonlRegion(descriptor, 0, size, "Required fork source", false);
		return {
			descriptor,
			bytes: size,
			sha256: digestRegion(descriptor, 0, size),
		};
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

function copyForkBaseline(
	source: ForkSourceLease | undefined,
	targetDescriptor: number,
): { bytes: number; sha256: string } {
	if (!source) {
		return {
			bytes: 0,
			sha256: digestRegion(targetDescriptor, 0, 0),
		};
	}
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	while (offset < source.bytes) {
		const requested = Math.min(buffer.length, source.bytes - offset);
		const bytesRead = readSync(
			source.descriptor,
			buffer,
			0,
			requested,
			offset,
		);
		if (bytesRead <= 0) {
			throw proofError(
				"Required fork source changed while it was being copied.",
			);
		}
		let written = 0;
		while (written < bytesRead) {
			const bytesWritten = writeSync(
				targetDescriptor,
				buffer,
				written,
				bytesRead - written,
				offset + written,
			);
			if (bytesWritten <= 0) {
				throw proofError("Required fork transcript copy made no progress.");
			}
			written += bytesWritten;
		}
		offset += bytesRead;
	}
	if (digestRegion(source.descriptor, 0, source.bytes) !== source.sha256) {
		throw proofError("Required fork source changed while it was being copied.");
	}
	if (digestRegion(targetDescriptor, 0, source.bytes) !== source.sha256) {
		throw proofError("Required fork transcript copy failed digest verification.");
	}
	return { bytes: source.bytes, sha256: source.sha256 };
}

function createHeldTranscript(
	childSession: string,
	directory: DirectoryLease,
	baselineSource: ForkSourceLease | undefined,
): TranscriptProofLease {
	const expectedParent = directory.path;
	if (path.dirname(childSession) !== expectedParent) {
		throw proofError("Required child transcript must be a direct child of the session directory.");
	}
	const temporary = path.join(
		expectedParent,
		`.${path.basename(childSession)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			temporary,
			constants.O_CREAT
				| constants.O_EXCL
				| constants.O_RDWR
				| (constants.O_NOFOLLOW || 0),
			PRIVATE_FILE_MODE,
		);
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		const baseline = copyForkBaseline(baselineSource, descriptor);
		fsyncSync(descriptor);
		linkSync(temporary, childSession);
		unlinkSync(temporary);
		fsyncSync(directory.descriptor);

		const metadata = fstatSync(descriptor, { bigint: true });
		const pathMetadata = lstatSync(childSession, { bigint: true });
		assertPrivateRegularFile(metadata, "Required child transcript");
		if (
			pathMetadata.isSymbolicLink()
			|| pathMetadata.dev !== metadata.dev
			|| pathMetadata.ino !== metadata.ino
		) {
			throw proofError("Required child transcript identity changed during creation.");
		}
		const identity = identityOf(metadata);
		return {
			...identity,
			baselineBytes: baseline.bytes,
			baselineSha256: baseline.sha256,
			childSession,
			descriptor,
			directory,
			receiptPath: `${childSession}.receipt.json`,
		};
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// Preserve uncertain filesystem evidence.
		}
		if (descriptor !== undefined) closeSync(descriptor);
		throw error;
	}
}

export function prepareTranscriptProof(
	input: PrepareTranscriptProofInput,
): TranscriptProofLease | undefined {
	if (!transcriptsRequired()) return undefined;
	if (!input.childSession) {
		throw proofError(
			"RLM_REQUIRE_TRANSCRIPTS=1 requires RLM_SHARED_SESSIONS=1 and an explicit child session directory; do not run the root with --no-session.",
		);
	}
	if (!path.isAbsolute(input.childSession)) {
		throw proofError(
			`RLM_REQUIRE_TRANSCRIPTS=1 requires an absolute child transcript path: ${input.childSession}`,
		);
	}
	const childSession = path.resolve(input.childSession);
	const directory = openSecureDirectory(path.dirname(childSession));
	try {
		assertDirectoryIdentity(directory);
		const baselineSource = input.forkSource
			? openSecureForkSource(input.forkSource)
			: undefined;
		try {
			return createHeldTranscript(childSession, directory, baselineSource);
		} finally {
			if (baselineSource) {
				try {
					closeSync(baselineSource.descriptor);
				} catch {
					// The read-only source is no longer needed once copied.
				}
			}
		}
	} catch (error) {
		try {
			closeSync(directory.descriptor);
		} catch {
			// Preserve the original proof failure.
		}
		throw error;
	}
}

function assertTranscriptIdentity(lease: TranscriptProofLease): number {
	assertDirectoryIdentity(lease.directory);
	const descriptorMetadata = fstatSync(lease.descriptor, { bigint: true });
	const pathMetadata = lstatSync(lease.childSession, { bigint: true });
	assertPrivateRegularFile(descriptorMetadata, "Required child transcript");
	if (
		pathMetadata.isSymbolicLink()
		|| !pathMetadata.isFile()
		|| pathMetadata.dev !== descriptorMetadata.dev
		|| pathMetadata.ino !== descriptorMetadata.ino
		|| lease.device !== descriptorMetadata.dev.toString()
		|| lease.inode !== descriptorMetadata.ino.toString()
	) {
		throw proofError("Required child transcript pathname no longer names the leased inode.");
	}
	return checkedSize(descriptorMetadata.size, "Required child transcript");
}

export function finalizeTranscriptProof(
	lease: TranscriptProofLease | undefined,
	identity: TranscriptProofIdentity,
): TranscriptReceipt | undefined {
	if (!lease) return undefined;
	fsyncSync(lease.descriptor);
	const finalBytes = assertTranscriptIdentity(lease);
	if (finalBytes <= lease.baselineBytes) {
		throw proofError(`Required child transcript did not append a session event: ${lease.childSession}`);
	}
	const observedBaselineHash = digestRegion(
		lease.descriptor,
		0,
		lease.baselineBytes,
	);
	if (observedBaselineHash !== lease.baselineSha256) {
		throw proofError("Required child transcript changed its secured baseline prefix.");
	}
	const appended = validateJsonlRegion(
		lease.descriptor,
		lease.baselineBytes,
		finalBytes - lease.baselineBytes,
		"Required child transcript append",
		true,
	);
	const receipt: TranscriptReceipt = {
		schema_version: 1,
		trace_id: identity.traceId,
		parent_depth: identity.parentDepth,
		child_depth: identity.childDepth,
		call_count: identity.callCount,
		child_exit_code: identity.childExitCode,
		transcript_file: path.basename(lease.childSession),
		baseline_bytes: lease.baselineBytes,
		baseline_sha256: lease.baselineSha256,
		final_bytes: finalBytes,
		final_sha256: digestRegion(lease.descriptor, 0, finalBytes),
		runtime_device: lease.device,
		runtime_inode: lease.inode,
		message_events_appended: appended.messageEvents,
	};
	atomicCreateFile(
		lease.receiptPath,
		`${JSON.stringify(receipt)}\n`,
		{ mode: PRIVATE_FILE_MODE },
	);
	assertDirectoryIdentity(lease.directory);
	return receipt;
}

export function closeTranscriptProof(lease: TranscriptProofLease | undefined): void {
	if (!lease) return;
	let firstError: unknown;
	for (const descriptor of [lease.descriptor, lease.directory.descriptor]) {
		try {
			closeSync(descriptor);
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError) throw firstError;
}

function parseReceipt(receiptPath: string): TranscriptReceipt {
	const descriptor = openSync(
		receiptPath,
		constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
	);
	try {
		const metadata = fstatSync(descriptor, { bigint: true });
		const pathMetadata = lstatSync(receiptPath, { bigint: true });
		assertPrivateRegularFile(metadata, "Transcript receipt");
		if (
			pathMetadata.isSymbolicLink()
			|| !pathMetadata.isFile()
			|| pathMetadata.dev !== metadata.dev
			|| pathMetadata.ino !== metadata.ino
			) {
				throw proofError(`Transcript receipt identity changed: ${receiptPath}`);
			}
			const receiptBytes = checkedSize(metadata.size, "Transcript receipt");
			if (receiptBytes > 64 * 1024) {
				throw proofError(`Transcript receipt exceeds 65536 bytes: ${receiptPath}`);
			}
			const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as TranscriptReceipt;
			if (
				parsed.schema_version !== 1
				|| typeof parsed.trace_id !== "string"
				|| !parsed.trace_id
				|| parsed.trace_id !== parsed.trace_id.replace(/[^a-zA-Z0-9._-]/g, "_")
				|| !Number.isSafeInteger(parsed.parent_depth)
				|| parsed.parent_depth < 0
				|| !Number.isSafeInteger(parsed.child_depth)
				|| parsed.child_depth !== parsed.parent_depth + 1
				|| !Number.isSafeInteger(parsed.call_count)
				|| parsed.call_count < 1
				|| !Number.isSafeInteger(parsed.child_exit_code)
				|| parsed.child_exit_code < 0
				|| typeof parsed.transcript_file !== "string"
				|| path.basename(parsed.transcript_file) !== parsed.transcript_file
				|| !parsed.transcript_file.endsWith(".jsonl")
				|| !Number.isSafeInteger(parsed.baseline_bytes)
				|| parsed.baseline_bytes < 0
				|| !/^[a-f0-9]{64}$/.test(parsed.baseline_sha256)
				|| !Number.isSafeInteger(parsed.final_bytes)
				|| parsed.final_bytes <= parsed.baseline_bytes
				|| !/^[a-f0-9]{64}$/.test(parsed.final_sha256)
				|| !/^\d+$/.test(parsed.runtime_device)
				|| !/^\d+$/.test(parsed.runtime_inode)
				|| !Number.isSafeInteger(parsed.message_events_appended)
				|| parsed.message_events_appended < 1
			) {
			throw proofError(`Invalid transcript receipt schema: ${receiptPath}`);
		}
		return parsed;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw proofError(`Invalid transcript receipt JSON: ${receiptPath}`);
		}
		throw error;
	} finally {
		closeSync(descriptor);
	}
}

export function verifyTranscriptReceipt(
	sessionDirectory: string,
	transcriptFile: string,
	requireRuntimeIdentity = true,
): TranscriptReceipt {
	if (path.basename(transcriptFile) !== transcriptFile || !transcriptFile.endsWith(".jsonl")) {
		throw proofError(`Invalid transcript filename: ${transcriptFile}`);
	}
	const directory = openSecureDirectory(sessionDirectory);
	try {
		const transcriptPath = path.join(directory.path, transcriptFile);
		const receipt = parseReceipt(`${transcriptPath}.receipt.json`);
		if (receipt.transcript_file !== transcriptFile) {
			throw proofError(`Transcript receipt filename mismatch: ${transcriptFile}`);
		}
		const descriptor = openSync(
			transcriptPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
		);
		try {
			const metadata = fstatSync(descriptor, { bigint: true });
			const pathMetadata = lstatSync(transcriptPath, { bigint: true });
			assertPrivateRegularFile(metadata, "Verified transcript");
			if (
				pathMetadata.isSymbolicLink()
				|| !pathMetadata.isFile()
				|| pathMetadata.dev !== metadata.dev
				|| pathMetadata.ino !== metadata.ino
			) {
				throw proofError(`Transcript identity changed during verification: ${transcriptFile}`);
			}
			const size = checkedSize(metadata.size, "Verified transcript");
			if (size !== receipt.final_bytes) {
				throw proofError(`Transcript size no longer matches its receipt: ${transcriptFile}`);
			}
			if (
				requireRuntimeIdentity
				&& (
					metadata.dev.toString() !== receipt.runtime_device
					|| metadata.ino.toString() !== receipt.runtime_inode
				)
			) {
				throw proofError(`Transcript inode no longer matches its runtime receipt: ${transcriptFile}`);
			}
			if (
				digestRegion(descriptor, 0, receipt.baseline_bytes)
				!== receipt.baseline_sha256
			) {
				throw proofError(`Transcript baseline digest no longer matches: ${transcriptFile}`);
			}
			if (digestRegion(descriptor, 0, size) !== receipt.final_sha256) {
				throw proofError(`Transcript final digest no longer matches: ${transcriptFile}`);
			}
			const appended = validateJsonlRegion(
				descriptor,
				receipt.baseline_bytes,
				size - receipt.baseline_bytes,
				"Verified transcript append",
				true,
			);
			if (appended.messageEvents !== receipt.message_events_appended) {
				throw proofError(`Transcript message count no longer matches: ${transcriptFile}`);
			}
		} finally {
			closeSync(descriptor);
		}
		assertDirectoryIdentity(directory);
		return receipt;
	} finally {
		closeSync(directory.descriptor);
	}
}

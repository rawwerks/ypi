import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const MAX_TRANSCRIPT_JSONL_EVENT_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export interface FileIdentity {
	device: string;
	inode: string;
	owner?: number;
}

export interface DirectoryLease extends FileIdentity {
	descriptor: number;
	path: string;
}

export function proofError(message: string): Error & { exitCode: number } {
	const error = new Error(message) as Error & { exitCode: number };
	error.exitCode = 1;
	return error;
}

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function numericMode(mode: bigint): number {
	return Number(mode & 0o777n);
}

export function identityOf(metadata: {
	dev: bigint;
	ino: bigint;
	uid: bigint;
}): FileIdentity {
	return {
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
		owner: currentUid() === undefined ? undefined : Number(metadata.uid),
	};
}

function assertOwner(owner: bigint, label: string): void {
	const uid = currentUid();
	if (uid !== undefined && Number(owner) !== uid) {
		throw proofError(`${label} is not owned by the current uid.`);
	}
}

export function assertPrivateRegularFile(
	metadata: BigIntStats,
	label: string,
): void {
	if (!metadata.isFile()) throw proofError(`${label} is not a regular file.`);
	if (metadata.nlink !== 1n) {
		throw proofError(`${label} must have exactly one hard link.`);
	}
	assertOwner(metadata.uid, label);
	if (
		process.platform !== "win32"
		&& numericMode(metadata.mode) !== PRIVATE_FILE_MODE
	) {
		throw proofError(`${label} must have mode 0600.`);
	}
}

export function openSecureDirectory(directoryPath: string): DirectoryLease {
	if (!path.isAbsolute(directoryPath)) {
		throw proofError(
			`RLM_REQUIRE_TRANSCRIPTS=1 requires an absolute session directory: ${directoryPath}`,
		);
	}
	const normalized = path.resolve(directoryPath);
	let resolved: string;
	try {
		resolved = realpathSync.native(normalized);
	} catch {
		throw proofError(
			`RLM_REQUIRE_TRANSCRIPTS=1 requires an existing private session directory: ${normalized}`,
		);
	}
	if (resolved !== normalized) {
		throw proofError(
			`RLM_REQUIRE_TRANSCRIPTS=1 rejects symlinked session-directory ancestry: ${normalized}`,
		);
	}
	const descriptor = openSync(
		normalized,
		constants.O_RDONLY
			| (constants.O_DIRECTORY || 0)
			| (constants.O_NOFOLLOW || 0),
	);
	try {
		const metadata = fstatSync(descriptor, { bigint: true });
		if (!metadata.isDirectory()) {
			throw proofError(
				`Required transcript session path is not a directory: ${normalized}`,
			);
		}
		assertOwner(metadata.uid, "Required transcript session directory");
		if (
			process.platform !== "win32"
			&& numericMode(metadata.mode) !== PRIVATE_DIRECTORY_MODE
		) {
			throw proofError(
				`RLM_REQUIRE_TRANSCRIPTS=1 requires session-directory mode 0700: ${normalized}`,
			);
		}
		return {
			...identityOf(metadata),
			descriptor,
			path: normalized,
		};
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

export function assertDirectoryIdentity(directory: DirectoryLease): void {
	const descriptorMetadata = fstatSync(directory.descriptor, { bigint: true });
	const pathMetadata = lstatSync(directory.path, { bigint: true });
	if (!descriptorMetadata.isDirectory() || !pathMetadata.isDirectory()) {
		throw proofError(
			"Required transcript session directory stopped being a directory.",
		);
	}
	if (
		pathMetadata.isSymbolicLink()
		|| descriptorMetadata.dev !== pathMetadata.dev
		|| descriptorMetadata.ino !== pathMetadata.ino
		|| directory.device !== descriptorMetadata.dev.toString()
		|| directory.inode !== descriptorMetadata.ino.toString()
	) {
		throw proofError("Required transcript session directory identity changed.");
	}
	assertOwner(descriptorMetadata.uid, "Required transcript session directory");
	if (
		process.platform !== "win32"
		&& numericMode(descriptorMetadata.mode) !== PRIVATE_DIRECTORY_MODE
	) {
		throw proofError(
			"Required transcript session directory permissions changed.",
		);
	}
}

export function checkedSize(size: bigint, label: string): number {
	if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw proofError(`${label} exceeds the supported safe byte range.`);
	}
	return Number(size);
}

export function digestRegion(
	descriptor: number,
	start: number,
	length: number,
): string {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(
		Math.min(READ_BUFFER_BYTES, Math.max(1, length)),
	);
	let offset = 0;
	while (offset < length) {
		const requested = Math.min(buffer.length, length - offset);
		const bytesRead = readSync(
			descriptor,
			buffer,
			0,
			requested,
			start + offset,
		);
		if (bytesRead <= 0) {
			throw proofError(
				"Required transcript became shorter during verification.",
			);
		}
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}

function parseJsonLine(line: string, label: string): boolean {
	const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (!normalized) {
		throw proofError(`${label} contains an empty JSONL event.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized);
	} catch {
		throw proofError(`${label} contains invalid JSONL.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw proofError(`${label} contains a non-object JSONL event.`);
	}
	const record = parsed as Record<string, unknown>;
	return (
		record.type === "message"
		&& !!record.message
		&& typeof record.message === "object"
		&& !Array.isArray(record.message)
	);
}

export function validateJsonlRegion(
	descriptor: number,
	start: number,
	length: number,
	label: string,
	requireMessage: boolean,
	maximumEventBytes = MAX_TRANSCRIPT_JSONL_EVENT_BYTES,
): { events: number; messageEvents: number } {
	if (!Number.isSafeInteger(maximumEventBytes) || maximumEventBytes < 1) {
		throw proofError(`${label} has an invalid JSONL event-size limit.`);
	}
	if (length === 0) {
		if (requireMessage) {
			throw proofError(`${label} did not append a session message.`);
		}
		return { events: 0, messageEvents: 0 };
	}
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, length));
	let pending = "";
	let pendingBytes = 0;
	let offset = 0;
	let events = 0;
	let messageEvents = 0;
	try {
		while (offset < length) {
			const requested = Math.min(buffer.length, length - offset);
			const bytesRead = readSync(
				descriptor,
				buffer,
				0,
				requested,
				start + offset,
			);
			if (bytesRead <= 0) {
				throw proofError(
					`${label} became shorter during JSONL verification.`,
				);
			}
			let segmentStart = 0;
			let newlineByte = buffer.indexOf(0x0a, segmentStart);
			while (newlineByte >= 0 && newlineByte < bytesRead) {
				pendingBytes += newlineByte - segmentStart;
				if (pendingBytes > maximumEventBytes) {
					throw proofError(
						`${label} contains a JSONL event larger than ${maximumEventBytes} bytes.`,
					);
				}
				pendingBytes = 0;
				segmentStart = newlineByte + 1;
				newlineByte = buffer.indexOf(0x0a, segmentStart);
			}
			pendingBytes += bytesRead - segmentStart;
			if (pendingBytes > maximumEventBytes) {
				throw proofError(
					`${label} contains a JSONL event larger than ${maximumEventBytes} bytes.`,
				);
			}
			pending += decoder.decode(buffer.subarray(0, bytesRead), {
				stream: true,
			});
			offset += bytesRead;
			let newline: number;
			while ((newline = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				events++;
				if (parseJsonLine(line, label)) messageEvents++;
			}
		}
		pending += decoder.decode();
	} catch (error) {
		if (error instanceof TypeError) {
			throw proofError(`${label} contains invalid UTF-8.`);
		}
		throw error;
	}
	if (pending.length !== 0) {
		throw proofError(
			`${label} does not end with a complete newline-terminated event.`,
		);
	}
	if (requireMessage && messageEvents === 0) {
		throw proofError(`${label} appended no Pi message event.`);
	}
	return { events, messageEvents };
}

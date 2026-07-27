import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
	mode?: number;
}

function syncDirectory(directory: string): void {
	const descriptor = openSync(directory, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

export function atomicWriteFile(
	target: string,
	content: string | Uint8Array,
	options: AtomicWriteOptions = {},
): void {
	const directory = path.dirname(target);
	const temporary = path.join(
		directory,
		`.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
	);
	let descriptor: number | undefined;
	try {
		const mode = options.mode ?? 0o600;
		descriptor = openSync(
			temporary,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			mode,
		);
		fchmodSync(descriptor, mode);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		try {
			closeSync(descriptor);
		} finally {
			descriptor = undefined;
		}
		renameSync(temporary, target);
		syncDirectory(directory);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the original write failure.
			}
		}
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function atomicWriteJson(target: string, value: unknown): void {
	atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

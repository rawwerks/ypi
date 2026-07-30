import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
	mode?: number;
	expectedContent?: string | Uint8Array;
	/** Journal-protected monotonic projections may write before truncating. */
	truncateBeforeWrite?: boolean;
}

export interface AtomicFileIdentity {
	device: string;
	inode: string;
	mode: number;
	links: string;
	owner?: number;
}

export type AtomicFileLifecycleStage =
	| "temporary-ready"
	| "before-publish"
	| "after-publish"
	| "before-temporary-retire"
	| "before-existing-commit"
	| "after-existing-commit";

export interface AtomicFileLifecycleEvent {
	stage: AtomicFileLifecycleStage;
	target: string;
	temporary?: string;
	identity: AtomicFileIdentity;
}

export type AtomicFileLifecycleHookForTests = (
	event: AtomicFileLifecycleEvent,
) => void;

let lifecycleHookForTests: AtomicFileLifecycleHookForTests | undefined;

/** Test-only deterministic race hook. It is inert unless explicitly installed. */
export function setAtomicFileLifecycleHookForTests(
	hook: AtomicFileLifecycleHookForTests | undefined,
): void {
	lifecycleHookForTests = hook;
}

interface HeldDirectory {
	descriptor: number;
	path: string;
	device: bigint;
	inode: bigint;
}

interface HeldTemporary {
	descriptor: number;
	path: string;
	identity: AtomicFileIdentity;
}

function currentUid(): number | undefined {
	return process.getuid?.();
}

function identityOf(metadata: Stats): AtomicFileIdentity {
	return {
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
		mode: metadata.mode & 0o777,
		links: metadata.nlink.toString(),
		owner: currentUid() === undefined ? undefined : metadata.uid,
	};
}

function sameIdentity(
	left: AtomicFileIdentity,
	right: AtomicFileIdentity,
	includeLinks = true,
): boolean {
	return left.device === right.device
		&& left.inode === right.inode
		&& left.mode === right.mode
		&& left.owner === right.owner
		&& (!includeLinks || left.links === right.links);
}

function privateFileIdentity(
	metadata: Stats,
	mode: number,
	label: string,
): AtomicFileIdentity {
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error(`${label} is not a regular file`);
	}
	const uid = currentUid();
	if (uid !== undefined && metadata.uid !== uid) {
		throw new Error(`${label} is not owned by the current user`);
	}
	if (process.platform !== "win32" && (metadata.mode & 0o777) !== mode) {
		throw new Error(`${label} must use mode ${mode.toString(8).padStart(4, "0")}`);
	}
	return identityOf(metadata);
}

function openHeldDirectory(directory: string): HeldDirectory {
	const descriptor = openSync(
		directory,
		constants.O_RDONLY
			| (constants.O_DIRECTORY || 0)
			| (constants.O_NOFOLLOW || 0),
	);
	try {
		const metadata = fstatSync(descriptor, { bigint: true });
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(`Atomic publication parent is not a directory: ${directory}`);
		}
		return {
			descriptor,
			path: directory,
			device: metadata.dev,
			inode: metadata.ino,
		};
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

function assertHeldDirectory(directory: HeldDirectory): void {
	const held = fstatSync(directory.descriptor, { bigint: true });
	const current = lstatSync(directory.path, { bigint: true });
	if (
		!held.isDirectory()
		|| !current.isDirectory()
		|| current.isSymbolicLink()
		|| held.dev !== directory.device
		|| held.ino !== directory.inode
		|| current.dev !== directory.device
		|| current.ino !== directory.inode
	) {
		throw new Error(`Atomic publication parent identity changed: ${directory.path}`);
	}
}

function syncHeldDirectory(directory: HeldDirectory): void {
	assertHeldDirectory(directory);
	fsyncSync(directory.descriptor);
	assertHeldDirectory(directory);
}

function writeAll(descriptor: number, content: string | Uint8Array): void {
	const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(
			descriptor,
			bytes,
			offset,
			bytes.length - offset,
			offset,
		);
		if (written <= 0) throw new Error("Atomic file write made no progress");
		offset += written;
	}
}

function assertPathNamesIdentity(
	candidate: string,
	expected: AtomicFileIdentity,
	expectedLinks: number,
	mode: number,
): void {
	const metadata = lstatSync(candidate);
	const observed = privateFileIdentity(metadata, mode, `Atomic file ${candidate}`);
	if (
		!sameIdentity(observed, expected, false)
		|| metadata.nlink !== expectedLinks
	) {
		throw new Error(`Atomic file pathname identity changed: ${candidate}`);
	}
}

function prepareTemporary(
	target: string,
	content: string | Uint8Array,
	mode: number,
): HeldTemporary {
	const directory = path.dirname(target);
	const temporaryPath = path.join(
		directory,
		`.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	let descriptor: number | undefined;
	let temporary: HeldTemporary | undefined;
	try {
		descriptor = openSync(
			temporaryPath,
			constants.O_CREAT
				| constants.O_EXCL
				| constants.O_RDWR
				| (constants.O_NOFOLLOW || 0),
			mode,
		);
		const createdMetadata = fstatSync(descriptor);
		temporary = {
			descriptor,
			path: temporaryPath,
			identity: identityOf(createdMetadata),
		};
		if (
			!createdMetadata.isFile()
			|| createdMetadata.isSymbolicLink()
			|| createdMetadata.nlink !== 1
			|| (currentUid() !== undefined && createdMetadata.uid !== currentUid())
		) {
			throw new Error("New atomic temporary is not an owned regular one-link file");
		}
		fchmodSync(descriptor, mode);
		const metadata = fstatSync(descriptor);
		const identity = privateFileIdentity(metadata, mode, "Atomic temporary");
		temporary.identity = identity;
		if (metadata.nlink !== 1) {
			throw new Error("Atomic temporary has an unexpected hard-link count");
		}
		writeAll(descriptor, content);
		fsyncSync(descriptor);
		assertPathNamesIdentity(temporaryPath, identity, 1, mode);
		return temporary;
	} catch (error) {
		if (temporary) {
			try {
				retireTemporaryAfterIdentityCheck(temporary, temporary.identity.mode, 1);
			} catch (cleanupError) {
				if (descriptor !== undefined) closeSync(descriptor);
				throw combineFailure(
					error,
					cleanupError,
					"Atomic temporary preparation failed and checked pathname retirement was unsafe",
				);
			}
		}
		if (descriptor !== undefined) closeSync(descriptor);
		throw error;
	}
}

function retireTemporaryAfterIdentityCheck(
	temporary: HeldTemporary,
	mode: number,
	expectedLinks: number,
): void {
	const held = privateFileIdentity(
		fstatSync(temporary.descriptor),
		mode,
		"Held atomic temporary",
	);
	if (!sameIdentity(held, temporary.identity, false) || held.links !== String(expectedLinks)) {
		throw new Error(`Atomic temporary inode changed; preserving ${temporary.path}`);
	}
	assertPathNamesIdentity(temporary.path, temporary.identity, expectedLinks, mode);
	// Portable Node has no inode-conditional unlink. This pathname deletion is
	// performed only after the last observable identity check; a hostile same-UID
	// replacement in the final check-to-unlink syscall interval remains a stated
	// residual and must never be described as exact or inode-conditional.
	unlinkSync(temporary.path);
}

function combineFailure(primary: unknown, cleanup: unknown, label: string): Error {
	const first = primary instanceof Error ? primary : new Error(String(primary));
	const second = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
	return new AggregateError([first, second], label, { cause: first });
}

function publishPreparedTemporary(
	target: string,
	temporary: HeldTemporary,
	directory: HeldDirectory,
	mode: number,
): AtomicFileIdentity {
	let published = false;
	try {
		lifecycleHookForTests?.({
			stage: "temporary-ready",
			target,
			temporary: temporary.path,
			identity: temporary.identity,
		});
		assertHeldDirectory(directory);
		assertPathNamesIdentity(temporary.path, temporary.identity, 1, mode);
		lifecycleHookForTests?.({
			stage: "before-publish",
			target,
			temporary: temporary.path,
			identity: temporary.identity,
		});
		assertHeldDirectory(directory);
		assertPathNamesIdentity(temporary.path, temporary.identity, 1, mode);
		// link(2) is the no-clobber linearization point: it either installs the
		// complete inode at an absent target or fails with EEXIST. A prior
		// existence check and rename are deliberately not used.
		linkSync(temporary.path, target);
		published = true;
		lifecycleHookForTests?.({
			stage: "after-publish",
			target,
			temporary: temporary.path,
			identity: temporary.identity,
		});
		assertPathNamesIdentity(temporary.path, temporary.identity, 2, mode);
		assertPathNamesIdentity(target, temporary.identity, 2, mode);
		syncHeldDirectory(directory);
		lifecycleHookForTests?.({
			stage: "before-temporary-retire",
			target,
			temporary: temporary.path,
			identity: temporary.identity,
		});
		// Both represented aliases and nlink=2 must still be proven immediately
		// before retiring our private alias. Any extra/external hard link or a
		// pathname replacement removes cleanup authority.
		assertPathNamesIdentity(target, temporary.identity, 2, mode);
		retireTemporaryAfterIdentityCheck(temporary, mode, 2);
		assertPathNamesIdentity(target, temporary.identity, 1, mode);
		syncHeldDirectory(directory);
		return { ...temporary.identity, links: "1" };
	} catch (error) {
		if (published) {
			// Once the canonical name may have become visible, blind rollback could
			// delete a successor. Preserve every represented name for inspection.
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}. Atomic publication may be visible; no further pathname was deleted, and every still-represented target/temporary artifact must be inspected.`,
				{ cause: error },
			);
		}
		try {
			retireTemporaryAfterIdentityCheck(temporary, mode, 1);
			syncHeldDirectory(directory);
		} catch (cleanupError) {
			throw combineFailure(
				error,
				cleanupError,
				"Atomic publication failed and checked temporary retirement was unsafe",
			);
		}
		throw error;
	}
}

function createTemporaryWithContent(
	target: string,
	content: string | Uint8Array,
	mode: number,
): HeldTemporary {
	return prepareTemporary(target, content, mode);
}

export function atomicCreateFile(
	target: string,
	content: string | Uint8Array,
	options: AtomicWriteOptions = {},
): AtomicFileIdentity {
	const mode = options.mode ?? 0o600;
	const directory = openHeldDirectory(path.dirname(target));
	let temporary: HeldTemporary | undefined;
	try {
		temporary = createTemporaryWithContent(target, content, mode);
		return publishPreparedTemporary(target, temporary, directory, mode);
	} finally {
		if (temporary) closeSync(temporary.descriptor);
		closeSync(directory.descriptor);
	}
}

export function atomicCopyFile(
	source: string,
	target: string,
	options: AtomicWriteOptions = {},
): AtomicFileIdentity {
	if (
		options.expectedContent !== undefined
		|| options.truncateBeforeWrite !== undefined
	) {
		throw new Error("Atomic copy supports only fresh no-clobber destinations");
	}
	// Production copy destinations are private fresh paths. Publication therefore
	// uses the same hard-link no-clobber linearization point as atomicCreateFile;
	// every pre-existing regular file, symlink, hard link, directory, or special
	// object is preserved and rejected rather than inspected, truncated, or
	// unlinked.
	return atomicCreateFile(target, readFileSync(source), {
		mode: options.mode ?? 0o600,
	});
}

function readDescriptorFromStart(descriptor: number): Buffer {
	const size = fstatSync(descriptor).size;
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("Atomic file size exceeds the supported range");
	}
	const bytes = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const count = readSync(descriptor, bytes, offset, size - offset, offset);
		if (count <= 0) throw new Error("Atomic file became shorter during verification");
		offset += count;
	}
	return bytes;
}

function bytesEqual(left: Uint8Array, right: string | Uint8Array): boolean {
	return Buffer.from(left).equals(
		typeof right === "string" ? Buffer.from(right) : Buffer.from(right),
	);
}

export function atomicConditionalReplaceFile(
	target: string,
	expected: AtomicFileIdentity,
	content: string | Uint8Array,
	options: AtomicWriteOptions = {},
): AtomicFileIdentity {
	const mode = options.mode ?? 0o600;
	const directory = openHeldDirectory(path.dirname(target));
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			target,
			constants.O_RDWR | (constants.O_NOFOLLOW || 0),
		);
		const openedMetadata = fstatSync(descriptor);
		const opened = privateFileIdentity(openedMetadata, mode, "Atomic replacement target");
		if (
			openedMetadata.nlink !== 1
			|| !sameIdentity(opened, expected)
		) {
			throw new Error(`Atomic replacement target identity changed: ${target}`);
		}
		assertPathNamesIdentity(target, expected, 1, mode);
		if (
			options.expectedContent !== undefined
			&& !bytesEqual(readDescriptorFromStart(descriptor), options.expectedContent)
		) {
			throw new Error(`Atomic replacement target contents changed: ${target}`);
		}
		lifecycleHookForTests?.({
			stage: "before-existing-commit",
			target,
			identity: expected,
		});
		assertHeldDirectory(directory);
		assertPathNamesIdentity(target, expected, 1, mode);
		const heldBefore = privateFileIdentity(
			fstatSync(descriptor),
			mode,
			"Held atomic replacement target",
		);
		if (!sameIdentity(heldBefore, expected)) {
			throw new Error(`Held atomic replacement target changed: ${target}`);
		}
		if (
			options.expectedContent !== undefined
			&& !bytesEqual(readDescriptorFromStart(descriptor), options.expectedContent)
		) {
			throw new Error(`Atomic replacement target contents changed before commit: ${target}`);
		}
		// Writing through the already-verified descriptor cannot overwrite a
		// pathname successor. It is a conditional durable update, not a rename
		// masquerading as compare-and-swap.
		const contentBytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
		if (options.truncateBeforeWrite !== false) ftruncateSync(descriptor, 0);
		writeAll(descriptor, contentBytes);
		ftruncateSync(descriptor, contentBytes.length);
		fsyncSync(descriptor);
		lifecycleHookForTests?.({
			stage: "after-existing-commit",
			target,
			identity: expected,
		});
		assertPathNamesIdentity(target, expected, 1, mode);
		const heldAfter = privateFileIdentity(
			fstatSync(descriptor),
			mode,
			"Committed atomic replacement target",
		);
		if (!sameIdentity(heldAfter, expected)) {
			throw new Error(`Atomic replacement target changed during commit: ${target}`);
		}
		if (!bytesEqual(readDescriptorFromStart(descriptor), content)) {
			throw new Error(`Atomic replacement target verification failed: ${target}`);
		}
		syncHeldDirectory(directory);
		return heldAfter;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		closeSync(directory.descriptor);
	}
}

export function atomicWriteFile(
	target: string,
	content: string | Uint8Array,
	options: AtomicWriteOptions = {},
): AtomicFileIdentity {
	let metadata: Stats;
	try {
		metadata = lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (options.expectedContent !== undefined) {
			throw new Error(`Atomic exact-existing target disappeared: ${target}`);
		}
		return atomicCreateFile(target, content, options);
	}
	const expected = privateFileIdentity(
		metadata,
		options.mode ?? 0o600,
		"Atomic write target",
	);
	if (metadata.nlink !== 1) {
		throw new Error(`Atomic write target has an unexpected hard-link count: ${target}`);
	}
	// ENOENT after this point means the observed pathname was displaced during
	// the conditional update. It must propagate; never reinterpret it as
	// authority to create and overwrite a successor name.
	return atomicConditionalReplaceFile(target, expected, content, options);
}

export function atomicWriteJson(target: string, value: unknown): AtomicFileIdentity {
	return atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

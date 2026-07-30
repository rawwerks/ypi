import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface PrivatePathIdentity {
	device: string;
	inode: string;
	kind: "directory" | "file";
	mode: number;
	links: string;
}

export interface OwnedPrivateDirectory {
	path: string;
	identity: PrivatePathIdentity;
}

export interface OwnedPrivateTree extends OwnedPrivateDirectory {
	entries: ReadonlyMap<string, PrivatePathIdentity>;
}

export interface RetireOwnedPrivateTreeOptions {
	afterEligibilityInventory?: () => void;
}

export interface WriteOwnedPrivateFileOptions {
	beforeOpen?: () => void;
}

export interface AppendOwnedPrivateFileTransactionOptions extends WriteOwnedPrivateFileOptions {
	afterTailTrim?: () => void;
	afterPayloadSync?: () => void;
	afterCommitWrite?: () => void;
}

export function parsePrivatePathIdentityValue(value: unknown): PrivatePathIdentity {
	const parsed = value as Partial<PrivatePathIdentity>;
	if (
		(parsed.kind !== "file" && parsed.kind !== "directory")
		|| typeof parsed.device !== "string"
		|| !/^\d+$/.test(parsed.device)
		|| typeof parsed.inode !== "string"
		|| !/^\d+$/.test(parsed.inode)
		|| parsed.mode !== (
			parsed.kind === "file"
				? PRIVATE_FILE_MODE
				: PRIVATE_DIRECTORY_MODE
		)
		|| typeof parsed.links !== "string"
		|| !/^(?:0|[1-9][0-9]*)$/.test(parsed.links)
		|| (parsed.kind === "file" && parsed.links !== "1")
	) {
		throw controlError("Invalid private path identity");
	}
	return {
		device: parsed.device,
		inode: parsed.inode,
		kind: parsed.kind,
		mode: parsed.mode,
		links: parsed.links,
	};
}

export function parsePrivateFileIdentity(raw: string): PrivatePathIdentity {
	const parsed = parsePrivatePathIdentityValue(JSON.parse(raw));
	if (parsed.kind !== "file") throw controlError("Invalid private file identity");
	return parsed;
}

function controlError(message: string): Error {
	return new Error(message);
}

function identityOf(metadata: BigIntStats): PrivatePathIdentity {
	const kind = metadata.isDirectory()
		? "directory"
		: metadata.isFile()
			? "file"
			: undefined;
	if (!kind || metadata.isSymbolicLink()) {
		throw controlError("Private runtime path is not a regular file or directory");
	}
	return {
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
		kind,
		mode: Number(metadata.mode & 0o777n),
		links: metadata.nlink.toString(),
	};
}

function sameIdentity(left: PrivatePathIdentity, right: PrivatePathIdentity): boolean {
	return left.device === right.device
		&& left.inode === right.inode
		&& left.kind === right.kind
		&& left.mode === right.mode
		&& (left.kind === "directory" || left.links === right.links);
}

function assertCurrentUser(metadata: BigIntStats, candidate: string): void {
	const uid = process.getuid?.();
	if (uid !== undefined && Number(metadata.uid) !== uid) {
		throw controlError(`Private runtime path is owned by another user: ${candidate}`);
	}
}

function inspectPrivatePath(candidate: string): PrivatePathIdentity {
	const metadata = lstatSync(candidate, { bigint: true });
	assertCurrentUser(metadata, candidate);
	const identity = identityOf(metadata);
	const expectedMode = identity.kind === "directory"
		? PRIVATE_DIRECTORY_MODE
		: PRIVATE_FILE_MODE;
	if (process.platform !== "win32" && identity.mode !== expectedMode) {
		throw controlError(
			`Private runtime ${identity.kind} must use mode ${expectedMode.toString(8)}: ${candidate}`,
		);
	}
	if (identity.kind === "file" && identity.links !== "1") {
		throw controlError(`Private runtime file has an unexpected hard-link count: ${candidate}`);
	}
	return identity;
}

export function assertPrivatePathIdentity(
	candidate: string,
	expected: PrivatePathIdentity,
): PrivatePathIdentity {
	const observed = inspectPrivatePath(candidate);
	if (!sameIdentity(observed, expected)) {
		throw controlError(`Private runtime path identity changed: ${candidate}`);
	}
	return observed;
}

export function capturePrivateFileIdentity(candidate: string): PrivatePathIdentity {
	const identity = inspectPrivatePath(candidate);
	if (identity.kind !== "file") {
		throw controlError(`Private runtime path is not a regular file: ${candidate}`);
	}
	return identity;
}

export function capturePrivatePathIdentity(candidate: string): PrivatePathIdentity {
	return inspectPrivatePath(candidate);
}

export function capturePrivateDirectoryIdentity(candidate: string): PrivatePathIdentity {
	const identity = inspectPrivatePath(candidate);
	if (identity.kind !== "directory") {
		throw controlError(`Private runtime path is not a directory: ${candidate}`);
	}
	return identity;
}

export function readOwnedPrivateFile(
	candidate: string,
	expected: PrivatePathIdentity,
	encoding: BufferEncoding = "utf8",
	maximumBytes?: number,
): string {
	return readOwnedPrivateFileBytes(candidate, expected, maximumBytes).toString(encoding);
}

export function readOwnedPrivateFileBytes(
	candidate: string,
	expected: PrivatePathIdentity,
	maximumBytes?: number,
): Buffer {
	if (expected.kind !== "file") {
		throw controlError(`Private runtime read target is not a file: ${candidate}`);
	}
	assertPrivatePathIdentity(candidate, expected);
	const descriptor = openSync(
		candidate,
		constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
	);
	try {
		const openedMetadata = fstatSync(descriptor, { bigint: true });
		const opened = identityOf(openedMetadata);
		if (!sameIdentity(opened, expected)) {
			throw controlError(`Private runtime read target identity changed: ${candidate}`);
		}
		if (openedMetadata.size < 0n || openedMetadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw controlError(`Private runtime read target size is unsupported: ${candidate}`);
		}
		const size = Number(openedMetadata.size);
		if (
			maximumBytes !== undefined
			&& (
				!Number.isSafeInteger(maximumBytes)
				|| maximumBytes < 0
				|| size > maximumBytes
			)
		) {
			throw controlError(`Private runtime read target exceeds ${maximumBytes} bytes: ${candidate}`);
		}
		const value = Buffer.alloc(size);
		let offset = 0;
		while (offset < value.length) {
			const count = readSync(
				descriptor,
				value,
				offset,
				value.length - offset,
				offset,
			);
			if (count <= 0) {
				throw controlError(`Private runtime read target became shorter: ${candidate}`);
			}
			offset += count;
		}
		assertPrivatePathIdentity(candidate, expected);
		return value;
	} finally {
		closeSync(descriptor);
	}
}

export function appendOwnedPrivateFile(
	candidate: string,
	expected: PrivatePathIdentity,
	content: string | Uint8Array,
): void {
	if (expected.kind !== "file") {
		throw controlError(`Private runtime append target is not a file: ${candidate}`);
	}
	assertPrivatePathIdentity(candidate, expected);
	const descriptor = openSync(
		candidate,
		constants.O_WRONLY
			| constants.O_APPEND
			| (constants.O_NOFOLLOW || 0),
	);
	try {
		const opened = identityOf(fstatSync(descriptor, { bigint: true }));
		if (!sameIdentity(opened, expected)) {
			throw controlError(`Private runtime append target identity changed: ${candidate}`);
		}
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		const written = identityOf(fstatSync(descriptor, { bigint: true }));
		if (!sameIdentity(written, expected)) {
			throw controlError(`Private runtime append target changed during write: ${candidate}`);
		}
			assertPrivatePathIdentity(candidate, expected);
	} finally {
		closeSync(descriptor);
	}
}

export function assertPrivateDirectory(candidate: string): void {
	const metadata = lstatSync(candidate);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw controlError(`Private runtime path is not an owned directory: ${candidate}`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && metadata.uid !== uid) {
		throw controlError(`Private runtime directory is owned by another user: ${candidate}`);
	}
	if (
		process.platform !== "win32"
		&& (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
	) {
		throw controlError(`Private runtime directory must use mode 0700: ${candidate}`);
	}
}

function secureCreatedDirectory(candidate: string): void {
	const descriptor = openSync(
		candidate,
		constants.O_RDONLY
			| (constants.O_DIRECTORY || 0)
			| (constants.O_NOFOLLOW || 0),
	);
	try {
		const before = fstatSync(descriptor, { bigint: true });
		if (!before.isDirectory()) {
			throw controlError(`New private runtime path is not a directory: ${candidate}`);
		}
		const uid = process.getuid?.();
		if (uid !== undefined && Number(before.uid) !== uid) {
			throw controlError(`New private runtime directory is owned by another user: ${candidate}`);
		}
		fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
		const held = fstatSync(descriptor, { bigint: true });
		const current = lstatSync(candidate, { bigint: true });
		if (
			current.isSymbolicLink()
			|| !current.isDirectory()
			|| current.dev !== held.dev
			|| current.ino !== held.ino
		) {
			throw controlError(`Private runtime directory identity changed during creation: ${candidate}`);
		}
	} finally {
		closeSync(descriptor);
	}
	assertPrivateDirectory(candidate);
}

export function ensurePrivateDirectory(candidate: string): boolean {
	let created = false;
	try {
		withPrivateUmask(() => mkdirSync(candidate, { mode: PRIVATE_DIRECTORY_MODE }));
		created = true;
		secureCreatedDirectory(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertPrivateDirectory(candidate);
	return created;
}

export function createPrivateDirectory(candidate: string): void {
	withPrivateUmask(() => mkdirSync(candidate, { mode: PRIVATE_DIRECTORY_MODE }));
	secureCreatedDirectory(candidate);
}

export function createPrivateTempDirectory(prefix: string): string {
	const directory = withPrivateUmask(() => mkdtempSync(prefix));
	secureCreatedDirectory(directory);
	return directory;
}

export function createOwnedPrivateTempDirectory(prefix: string): OwnedPrivateDirectory {
	const directory = createPrivateTempDirectory(prefix);
	const identity = inspectPrivatePath(directory);
	if (identity.kind !== "directory") {
		throw controlError(`New private runtime path is not a directory: ${directory}`);
	}
	return { path: directory, identity };
}

export function createOwnedPrivateFile(
	candidate: string,
	content: string | Uint8Array,
): PrivatePathIdentity {
	let descriptor: number | undefined;
	try {
		descriptor = withPrivateUmask(() => openSync(
			candidate,
			constants.O_CREAT
				| constants.O_EXCL
				| constants.O_WRONLY
				| (constants.O_NOFOLLOW || 0),
			PRIVATE_FILE_MODE,
		));
		fchmodSync(descriptor, PRIVATE_FILE_MODE);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		const held = fstatSync(descriptor, { bigint: true });
		const uid = process.getuid?.();
		if (
			!held.isFile()
			|| held.nlink !== 1n
			|| (uid !== undefined && Number(held.uid) !== uid)
		) {
			throw controlError(`New private runtime path is not an owned regular file: ${candidate}`);
		}
		const current = lstatSync(candidate, { bigint: true });
		if (
			current.isSymbolicLink()
			|| !current.isFile()
			|| current.dev !== held.dev
			|| current.ino !== held.ino
		) {
			throw controlError(`Private runtime file identity changed during creation: ${candidate}`);
		}
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	return capturePrivateFileIdentity(candidate);
}

function normalizeOwnedRelativePath(relativePath: string): string {
	if (
		relativePath === ""
		|| relativePath === "."
		|| path.isAbsolute(relativePath)
		|| relativePath === ".."
		|| relativePath.startsWith(`..${path.sep}`)
	) {
		throw controlError(`Invalid private runtime relative path: ${relativePath}`);
	}
	const normalized = path.normalize(relativePath);
	if (
		normalized === ""
		|| normalized === "."
		|| normalized === ".."
		|| normalized.startsWith(`..${path.sep}`)
		|| path.isAbsolute(normalized)
	) {
		throw controlError(`Invalid private runtime relative path: ${relativePath}`);
	}
	return normalized;
}

function inventoryPrivateTree(root: string): Map<string, PrivatePathIdentity> {
	const entries = new Map<string, PrivatePathIdentity>();
	const visit = (directory: string, relativeDirectory: string): void => {
		for (const name of readdirSync(directory).sort()) {
			const relativePath = relativeDirectory
				? path.join(relativeDirectory, name)
				: name;
			const candidate = path.join(root, relativePath);
			const identity = inspectPrivatePath(candidate);
			entries.set(relativePath, identity);
			if (identity.kind === "directory") visit(candidate, relativePath);
		}
	};
	visit(root, "");
	return entries;
}

export function sealOwnedPrivateDirectory(
	owner: OwnedPrivateDirectory,
	expectedRelativePaths: readonly string[],
): OwnedPrivateTree {
	assertPrivatePathIdentity(owner.path, owner.identity);
	const expected = [...new Set(expectedRelativePaths.map(normalizeOwnedRelativePath))].sort();
	if (expected.length !== expectedRelativePaths.length) {
		throw controlError(`Private runtime ownership inventory contains duplicate paths: ${owner.path}`);
	}
	const entries = inventoryPrivateTree(owner.path);
	const observed = [...entries.keys()].sort();
	if (
		expected.length !== observed.length
		|| expected.some((entry, index) => entry !== observed[index])
	) {
		throw controlError(
			`Private runtime ownership inventory does not match declared entries: ${owner.path}`,
		);
	}
	assertPrivatePathIdentity(owner.path, owner.identity);
	return { ...owner, entries };
}

export function assertOwnedPrivateTree(tree: OwnedPrivateTree): void {
	assertPrivatePathIdentity(tree.path, tree.identity);
	const observed = inventoryPrivateTree(tree.path);
	if (observed.size !== tree.entries.size) {
		throw controlError(`Private runtime tree gained or lost entries: ${tree.path}`);
	}
	for (const [relativePath, expected] of tree.entries) {
		const current = observed.get(relativePath);
		if (!current || !sameIdentity(current, expected)) {
			throw controlError(`Private runtime tree entry changed: ${path.join(tree.path, relativePath)}`);
		}
	}
	assertPrivatePathIdentity(tree.path, tree.identity);
}

export function retireOwnedPrivateTree(
	tree: OwnedPrivateTree,
	options: RetireOwnedPrivateTreeOptions = {},
): void {
	assertOwnedPrivateTree(tree);
	options.afterEligibilityInventory?.();
	assertOwnedPrivateTree(tree);
	const entries = [...tree.entries.entries()].sort(([leftPath, left], [rightPath, right]) => {
		const depthDifference = rightPath.split(path.sep).length - leftPath.split(path.sep).length;
		if (depthDifference !== 0) return depthDifference;
		if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
		return rightPath.localeCompare(leftPath);
	});
	for (const [relativePath, expected] of entries) {
		const candidate = path.join(tree.path, relativePath);
			assertPrivatePathIdentity(candidate, expected);
		if (expected.kind === "directory") rmdirSync(candidate);
		else unlinkSync(candidate);
	}
	assertPrivatePathIdentity(tree.path, tree.identity);
	rmdirSync(tree.path);
}

export function writeOwnedPrivateFile(
	candidate: string,
	expected: PrivatePathIdentity,
	content: string | Uint8Array,
	options: WriteOwnedPrivateFileOptions = {},
): void {
	if (expected.kind !== "file") {
		throw controlError(`Private runtime write target is not a file: ${candidate}`);
	}
	assertPrivatePathIdentity(candidate, expected);
	options.beforeOpen?.();
	const descriptor = openSync(
		candidate,
		constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
	);
	try {
		const opened = identityOf(fstatSync(descriptor, { bigint: true }));
		if (!sameIdentity(opened, expected)) {
			throw controlError(`Private runtime write target identity changed: ${candidate}`);
		}
		ftruncateSync(descriptor, 0);
		writeFileSync(descriptor, content);
		fsyncSync(descriptor);
		const afterWrite = identityOf(fstatSync(descriptor, { bigint: true }));
		if (!sameIdentity(afterWrite, expected)) {
			throw controlError(`Private runtime write target changed during write: ${candidate}`);
		}
			assertPrivatePathIdentity(candidate, expected);
	} finally {
		closeSync(descriptor);
	}
}

export function appendOwnedPrivateFileTransaction(
	candidate: string,
	expected: PrivatePathIdentity,
	observedBytes: number,
	committedBytes: number,
	payload: string | Uint8Array,
	commit: string | Uint8Array,
	options: AppendOwnedPrivateFileTransactionOptions = {},
): void {
	if (
		expected.kind !== "file"
		|| !Number.isSafeInteger(observedBytes)
		|| observedBytes < 0
		|| !Number.isSafeInteger(committedBytes)
		|| committedBytes < 0
		|| committedBytes > observedBytes
	) {
		throw controlError(`Invalid private runtime journal boundary: ${candidate}`);
	}
	assertPrivatePathIdentity(candidate, expected);
	options.beforeOpen?.();
	const descriptor = openSync(
		candidate,
		constants.O_RDWR
			| constants.O_APPEND
			| (constants.O_NOFOLLOW || 0),
	);
	try {
		const openedMetadata = fstatSync(descriptor, { bigint: true });
		const opened = identityOf(openedMetadata);
		if (!sameIdentity(opened, expected)) {
			throw controlError(`Private runtime journal identity changed: ${candidate}`);
		}
		if (openedMetadata.size !== BigInt(observedBytes)) {
			throw controlError(`Private runtime journal size changed: ${candidate}`);
		}
		if (committedBytes < observedBytes) {
			ftruncateSync(descriptor, committedBytes);
			fsyncSync(descriptor);
			options.afterTailTrim?.();
		}
		writeFileSync(descriptor, payload);
		fsyncSync(descriptor);
		options.afterPayloadSync?.();
		writeFileSync(descriptor, commit);
		options.afterCommitWrite?.();
		fsyncSync(descriptor);
		const writtenMetadata = fstatSync(descriptor, { bigint: true });
		const written = identityOf(writtenMetadata);
		const expectedSize = BigInt(
			committedBytes
			+ Buffer.byteLength(payload)
			+ Buffer.byteLength(commit),
		);
		if (
			!sameIdentity(written, expected)
			|| writtenMetadata.size !== expectedSize
		) {
			throw controlError(`Private runtime journal changed during append: ${candidate}`);
		}
		assertPrivatePathIdentity(candidate, expected);
	} finally {
		closeSync(descriptor);
	}
}

export function ensurePrivateAppendFile(candidate: string): PrivatePathIdentity {
	let descriptor: number | undefined;
	let created = false;
	let identity: PrivatePathIdentity | undefined;
	try {
		try {
			descriptor = withPrivateUmask(() => openSync(
				candidate,
				constants.O_CREAT
					| constants.O_EXCL
					| constants.O_APPEND
					| constants.O_WRONLY
					| (constants.O_NOFOLLOW || 0),
				PRIVATE_FILE_MODE,
			));
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			descriptor = openSync(
				candidate,
				constants.O_APPEND
					| constants.O_WRONLY
					| (constants.O_NOFOLLOW || 0),
			);
		}
		const before = fstatSync(descriptor, { bigint: true });
		const uid = process.getuid?.();
			if (
				!before.isFile()
				|| before.nlink !== 1n
				|| (uid !== undefined && Number(before.uid) !== uid)
			) {
				throw controlError(`Private append path is not an owned regular file: ${candidate}`);
			}
			const currentBeforeMode = lstatSync(candidate, { bigint: true });
			if (
				currentBeforeMode.isSymbolicLink()
				|| !currentBeforeMode.isFile()
				|| currentBeforeMode.dev !== before.dev
				|| currentBeforeMode.ino !== before.ino
			) {
				throw controlError(`Private append-file identity changed during validation: ${candidate}`);
			}
			if (created) fchmodSync(descriptor, PRIVATE_FILE_MODE);
			const held = fstatSync(descriptor, { bigint: true });
			const current = lstatSync(candidate, { bigint: true });
			if (
				current.isSymbolicLink()
				|| !current.isFile()
				|| current.dev !== held.dev
				|| current.ino !== held.ino
			) {
					throw controlError(`Private append-file identity changed during validation: ${candidate}`);
			}
			if (
				process.platform !== "win32"
				&& (
					Number(held.mode & 0o777n) !== PRIVATE_FILE_MODE
					|| Number(current.mode & 0o777n) !== PRIVATE_FILE_MODE
				)
			) {
					throw controlError(`Private append file must use mode 0600: ${candidate}`);
				}
			identity = identityOf(held);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
	if (!identity) throw controlError(`Private append-file identity is unavailable: ${candidate}`);
	return identity;
}

export function ensurePrivateDescendantDirectory(
	ownedRoot: string,
	descendant: string,
): void {
	assertPrivateDirectory(ownedRoot);
	const relative = path.relative(ownedRoot, descendant);
	if (
		relative === ""
		|| relative === "."
	) return;
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw controlError(`Private runtime descendant escapes its owned root: ${descendant}`);
	}
	let current = ownedRoot;
	for (const component of relative.split(path.sep)) {
		if (!component || component === ".") continue;
		current = path.join(current, component);
		ensurePrivateDirectory(current);
	}
}

export function withPrivateUmask<T>(action: () => T): T {
	if (process.platform === "win32") return action();
	const previous = process.umask(0o077);
	try {
		return action();
	} finally {
		process.umask(previous);
	}
}

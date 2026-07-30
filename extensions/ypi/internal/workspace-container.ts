import { createHash, randomBytes } from "node:crypto";
import {
	constants,
	lstatSync,
	openSync,
	closeSync,
	fstatSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type {
	ImplementerLeaseRecord,
	WorkspaceFilesystemIdentity,
} from "./implementer-lease.ts";

export interface WorkspaceLocation {
	container: string;
	worktree: string;
}

export interface RetireWorkspaceContainerOptions {
	afterFinalVerification?: () => void;
	afterQuarantine?: (quarantinePath: string) => void;
	afterQuarantineUnlink?: () => void;
}

const WORKTREE_GIT_FILE_MAX_BYTES = 64 * 1024;

function identity(metadata: { dev: bigint; ino: bigint }): { device: string; inode: string } {
	return {
		device: metadata.dev.toString(),
		inode: metadata.ino.toString(),
	};
}

function sameIdentity(
	metadata: { dev: bigint; ino: bigint },
	device: string,
	inode: string,
): boolean {
	return metadata.dev.toString() === device && metadata.ino.toString() === inode;
}

function lstatBigInt(candidate: string): BigIntStats {
	return lstatSync(candidate, { bigint: true }) as BigIntStats;
}

function readOwnerMarker(candidate: string): { metadata: BigIntStats; value: Buffer } {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor, { bigint: true }) as BigIntStats;
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
			throw new Error("workspace ownership marker is not a singly linked regular file");
		}
		return {
			metadata,
			value: Buffer.from(readFileSync(descriptor)),
		};
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function readWorktreeGitFile(candidate: string): {
	metadata: BigIntStats;
	digest: string;
} {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor, { bigint: true }) as BigIntStats;
		if (
			!metadata.isFile()
			|| metadata.isSymbolicLink()
			|| metadata.nlink !== 1n
			|| metadata.size > BigInt(WORKTREE_GIT_FILE_MAX_BYTES)
		) {
			throw new Error("checkout Git indirection is not a bounded singly linked regular file");
		}
		const value = Buffer.from(readFileSync(descriptor));
		const pathnameMetadata = lstatBigInt(candidate);
		if (
			!pathnameMetadata.isFile()
			|| pathnameMetadata.isSymbolicLink()
			|| pathnameMetadata.nlink !== 1n
			|| !sameIdentity(pathnameMetadata, metadata.dev.toString(), metadata.ino.toString())
		) {
			throw new Error("checkout Git indirection changed while it was inspected");
		}
		return {
			metadata,
			digest: createHash("sha256").update(value).digest("hex"),
		};
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function workspaceLocation(record: ImplementerLeaseRecord): WorkspaceLocation {
	if (!record.worktreeContainer || !record.worktreeRoot) {
		throw new Error("record has no worktree path");
	}
	const container = record.worktreeContainer;
	const worktree = record.worktreeRoot;
	if (
		!path.isAbsolute(container)
		|| !path.isAbsolute(worktree)
		|| path.basename(container) !== `ypi_ws_${record.token}`
		|| worktree !== path.join(container, "checkout")
	) {
		throw new Error("recorded worktree path is not an owned ypi workspace");
	}
	return { container, worktree };
}

export function captureWorkspaceContainerIdentity(
	record: ImplementerLeaseRecord,
): WorkspaceFilesystemIdentity {
	const { container } = workspaceLocation(record);
	const containerMetadata = lstatBigInt(container);
	if (!containerMetadata.isDirectory() || containerMetadata.isSymbolicLink()) {
		throw new Error("workspace container is not an owned directory");
	}
	const owner = readOwnerMarker(path.join(container, "owner"));
	if (!owner.value.equals(Buffer.from(`${record.token}\n`))) {
		throw new Error("workspace ownership marker does not match the lease");
	}
	const containerId = identity(containerMetadata);
	const ownerId = identity(owner.metadata);
	return {
		containerDevice: containerId.device,
		containerInode: containerId.inode,
		ownerDevice: ownerId.device,
		ownerInode: ownerId.inode,
	};
}

export function captureWorkspaceDirectoryIdentity(
	record: ImplementerLeaseRecord,
): WorkspaceFilesystemIdentity {
	const { container } = workspaceLocation(record);
	const metadata = lstatBigInt(container);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("workspace container is not an owned directory");
	}
	const captured = identity(metadata);
	return {
		containerDevice: captured.device,
		containerInode: captured.inode,
	};
}

export function captureWorkspaceTreeIdentity(
	record: ImplementerLeaseRecord,
): WorkspaceFilesystemIdentity {
	const current = verifyWorkspaceContainer(record, "capture");
	const metadata = lstatBigInt(current.worktree);
	const worktreeId = identity(metadata);
	const gitFile = readWorktreeGitFile(path.join(current.worktree, ".git"));
	const gitFileId = identity(gitFile.metadata);
	return {
		...record.workspaceIdentity!,
		worktreeDevice: worktreeId.device,
		worktreeInode: worktreeId.inode,
		worktreeGitFileDevice: gitFileId.device,
		worktreeGitFileInode: gitFileId.inode,
		worktreeGitFileDigest: gitFile.digest,
	};
}

export function verifyWorkspaceContainer(
	record: ImplementerLeaseRecord,
	worktreeState: "present" | "absent" | "either" | "capture",
): WorkspaceLocation {
	const location = workspaceLocation(record);
	const expected = record.workspaceIdentity;
	if (!expected) {
		throw new Error("workspace filesystem identity is unavailable; preserve it for explicit inspection");
	}
	const container = lstatBigInt(location.container);
	if (
		!container.isDirectory()
		|| container.isSymbolicLink()
		|| !sameIdentity(container, expected.containerDevice, expected.containerInode)
	) {
		throw new Error("workspace container identity changed; preserve it for explicit inspection");
	}
	const owner = readOwnerMarker(path.join(location.container, "owner"));
	if (
		!expected.ownerDevice
		|| !expected.ownerInode
		|| !sameIdentity(owner.metadata, expected.ownerDevice, expected.ownerInode)
		|| !owner.value.equals(Buffer.from(`${record.token}\n`))
	) {
		throw new Error("workspace ownership marker identity changed; preserve it for explicit inspection");
	}
	let worktree: BigIntStats | undefined;
	try {
		worktree = lstatBigInt(location.worktree);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if ((worktreeState === "present" || worktreeState === "capture") && !worktree) {
		throw new Error("recorded checkout disappeared; preserve the workspace for explicit inspection");
	}
	if (worktreeState === "absent" && worktree) {
		throw new Error("recorded checkout still exists; preserve the workspace for explicit inspection");
	}
	if (worktree) {
		if (
			!worktree.isDirectory()
			|| worktree.isSymbolicLink()
			|| (
				worktreeState !== "capture"
				&& (
					!expected.worktreeDevice
					|| !expected.worktreeInode
					|| !sameIdentity(worktree, expected.worktreeDevice, expected.worktreeInode)
				)
			)
		) {
			throw new Error("recorded checkout identity changed; preserve it for explicit inspection");
		}
		if (worktreeState !== "capture") {
			if (
				!expected.worktreeGitFileDevice
				|| !expected.worktreeGitFileInode
				|| !expected.worktreeGitFileDigest
			) {
				throw new Error(
					"recorded checkout Git indirection identity is unavailable; preserve it for explicit inspection",
				);
			}
			let gitFile: ReturnType<typeof readWorktreeGitFile>;
			try {
				gitFile = readWorktreeGitFile(path.join(location.worktree, ".git"));
			} catch {
				throw new Error(
					"recorded checkout Git indirection identity changed; preserve it for explicit inspection",
				);
			}
			if (
				!sameIdentity(
					gitFile.metadata,
					expected.worktreeGitFileDevice,
					expected.worktreeGitFileInode,
				)
				|| gitFile.digest !== expected.worktreeGitFileDigest
			) {
				throw new Error(
					"recorded checkout Git indirection identity changed; preserve it for explicit inspection",
				);
			}
		}
	}
	return location;
}

export function retireEmptyWorkspaceContainer(
	record: ImplementerLeaseRecord,
	options: RetireWorkspaceContainerOptions = {},
): void {
	const { container } = workspaceLocation(record);
	const expected = record.workspaceIdentity;
	if (!expected) {
		throw new Error("workspace filesystem identity is unavailable; preserve it for explicit inspection");
	}
	const assertExactContainer = (): void => {
		const metadata = lstatBigInt(container);
		if (
			!metadata.isDirectory()
			|| metadata.isSymbolicLink()
			|| !sameIdentity(
				metadata,
				expected.containerDevice,
				expected.containerInode,
			)
		) {
			throw new Error("workspace container identity changed; preserve it for explicit inspection");
		}
	};
	assertExactContainer();
	const entries = readdirSync(container);
	const retiredNames = entries.filter((entry) => (
		entry.startsWith(".owner-retired-")
		&& /^[.]owner-retired-[0-9a-f]{32}$/.test(entry)
	));
	let retiredOwnerPath: string;
	if (entries.length === 0) {
		options.afterQuarantineUnlink?.();
		assertExactContainer();
		rmdirSync(container);
		return;
	}
	if (entries.length === 1 && entries[0] === "owner") {
		if (!expected.ownerDevice || !expected.ownerInode) {
			throw new Error(
				"workspace ownership marker identity is unavailable; preserve it for explicit inspection",
			);
		}
		verifyWorkspaceContainer(record, "absent");
		options.afterFinalVerification?.();
		const ownerPath = path.join(container, "owner");
		retiredOwnerPath = path.join(
			container,
			`.owner-retired-${randomBytes(16).toString("hex")}`,
		);
		renameSync(ownerPath, retiredOwnerPath);
		options.afterQuarantine?.(retiredOwnerPath);
	} else if (entries.length === 1 && retiredNames.length === 1) {
		retiredOwnerPath = path.join(container, retiredNames[0]);
	} else {
		throw new Error("workspace container has unexpected content; preserve it for explicit inspection");
	}
	const retiredOwner = readOwnerMarker(retiredOwnerPath);
	if (
		!expected.ownerDevice
		|| !expected.ownerInode
		|| !sameIdentity(retiredOwner.metadata, expected.ownerDevice, expected.ownerInode)
		|| !retiredOwner.value.equals(Buffer.from(`${record.token}\n`))
	) {
		throw new Error(
			`workspace ownership marker changed during retirement; preserve it at ${retiredOwnerPath}`,
		);
	}
	assertExactContainer();
	const remaining = readdirSync(container);
	if (remaining.length !== 1 || remaining[0] !== path.basename(retiredOwnerPath)) {
		throw new Error(
			`workspace container changed during retirement; preserve it at ${container}`,
		);
	}
	unlinkSync(retiredOwnerPath);
	options.afterQuarantineUnlink?.();
	assertExactContainer();
	if (readdirSync(container).length !== 0) {
		throw new Error(
			`workspace container changed during retirement; preserve it at ${container}`,
		);
	}
	rmdirSync(container);
}

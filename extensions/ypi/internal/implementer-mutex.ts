import path from "node:path";
import { atomicCreateFile } from "./atomic-file.ts";
import {
	assertPrivatePathIdentity,
	capturePrivateFileIdentity,
	capturePrivateDirectoryIdentity,
	createPrivateDirectory,
	readOwnedPrivateFile,
	retireOwnedPrivateTree,
	sealOwnedPrivateDirectory,
	writeOwnedPrivateFile,
	type PrivatePathIdentity,
} from "./private-path.ts";

export interface ImplementerMutexOwner {
	schemaVersion: 1;
	token: string;
	pid: number;
	createdAtEpochSeconds: number;
	directoryIdentity: PrivatePathIdentity;
	ownerFileIdentity: PrivatePathIdentity;
}

function positiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function token(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function directoryIdentity(value: unknown): value is PrivatePathIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Partial<PrivatePathIdentity>;
	return identity.kind === "directory"
		&& typeof identity.device === "string"
		&& /^\d+$/.test(identity.device)
		&& typeof identity.inode === "string"
		&& /^\d+$/.test(identity.inode)
		&& identity.mode === 0o700
		&& typeof identity.links === "string"
		&& /^\d+$/.test(identity.links);
}

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

function sameOwner(
	left: ImplementerMutexOwner,
	right: ImplementerMutexOwner,
): boolean {
	return left.schemaVersion === right.schemaVersion
		&& left.token === right.token
		&& left.pid === right.pid
		&& left.createdAtEpochSeconds === right.createdAtEpochSeconds
		&& sameIdentity(left.directoryIdentity, right.directoryIdentity)
		&& sameIdentity(left.ownerFileIdentity, right.ownerFileIdentity);
}

export function createImplementerMutex(
	lockPath: string,
	mutexToken: string,
	createdAtEpochSeconds = Math.floor(Date.now() / 1000),
): ImplementerMutexOwner {
	if (!token(mutexToken)) throw new Error("implementer mutex token is invalid");
	createPrivateDirectory(lockPath);
	const identity = capturePrivateDirectoryIdentity(lockPath);
	const ownerPath = path.join(lockPath, "owner.json");
	atomicCreateFile(ownerPath, "{}\n", { mode: 0o600 });
	const ownerFileIdentity = capturePrivateFileIdentity(ownerPath);
	const owner: ImplementerMutexOwner = {
		schemaVersion: 1,
		token: mutexToken,
		pid: process.pid,
		createdAtEpochSeconds,
		directoryIdentity: identity,
		ownerFileIdentity,
	};
	try {
		writeOwnedPrivateFile(
			ownerPath,
			ownerFileIdentity,
			`${JSON.stringify(owner, null, 2)}\n`,
		);
	} catch (error) {
		// An incomplete no-clobber claim is uncertain state. Preserve it for
		// explicit recovery instead of recursively deleting its current path.
		throw error;
	}
	return owner;
}

export function parseImplementerMutexOwner(value: unknown): ImplementerMutexOwner {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("implementer mutex owner is malformed");
	}
	const owner = value as Partial<ImplementerMutexOwner>;
	if (
		owner.schemaVersion !== 1
		|| !token(owner.token)
		|| !positiveInteger(owner.pid)
		|| !nonNegativeInteger(owner.createdAtEpochSeconds)
		|| !directoryIdentity(owner.directoryIdentity)
		|| !owner.ownerFileIdentity
		|| owner.ownerFileIdentity.kind !== "file"
		|| typeof owner.ownerFileIdentity.device !== "string"
		|| !/^\d+$/.test(owner.ownerFileIdentity.device)
		|| typeof owner.ownerFileIdentity.inode !== "string"
		|| !/^\d+$/.test(owner.ownerFileIdentity.inode)
		|| owner.ownerFileIdentity.mode !== 0o600
		|| owner.ownerFileIdentity.links !== "1"
	) {
		throw new Error("implementer mutex owner is malformed");
	}
	return owner as ImplementerMutexOwner;
}

export function retireImplementerMutex(
	lockPath: string,
	expected: ImplementerMutexOwner,
): void {
	const ownerPath = path.join(lockPath, "owner.json");
	const observed = parseImplementerMutexOwner(
		JSON.parse(
			readOwnedPrivateFile(ownerPath, expected.ownerFileIdentity),
		),
	);
	if (!sameOwner(observed, expected)) {
		throw new Error("implementer mutex owner contents changed");
	}
	assertPrivatePathIdentity(ownerPath, expected.ownerFileIdentity);
	const tree = sealOwnedPrivateDirectory(
		{ path: lockPath, identity: expected.directoryIdentity },
		["owner.json"],
	);
	retireOwnedPrivateTree(tree);
}

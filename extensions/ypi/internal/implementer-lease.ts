import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeImplementScope } from "./implement-scope.ts";
import {
	PRIVATE_DIRECTORY_MODE,
	type PrivatePathIdentity,
} from "./private-path.ts";

export const IMPLEMENTER_LEASE_SCHEMA_VERSION = 3;

export type ImplementerLeaseState =
	| "reserved"
	| "worktree-ready"
	| "ref-verified"
	| "worktree-removed";

export interface WorkspaceFilesystemIdentity {
	containerDevice: string;
	containerInode: string;
	ownerDevice?: string;
	ownerInode?: string;
	worktreeDevice?: string;
	worktreeInode?: string;
}

export interface ImplementerLeaseRecord {
	schemaVersion: typeof IMPLEMENTER_LEASE_SCHEMA_VERSION;
	token: string;
	ownerPid: number;
	childPid?: number;
	childLaunchStartedAtEpochSeconds?: number;
	createdAtEpochSeconds: number;
	root: string;
	commonGitDir: string;
	baselineHead: string;
	scope: string[];
	state: ImplementerLeaseState;
	worktreeContainer?: string;
	worktreeRoot?: string;
	workspaceIdentity?: WorkspaceFilesystemIdentity;
	attemptRef: string;
	attemptCommit?: string;
	worktreeIndexOwnedByYpi: boolean;
	leaseResources: Record<string, PrivatePathIdentity>;
	leaseDirectoryIdentity: PrivatePathIdentity;
	leaseFileIdentity: PrivatePathIdentity;
	revision: number;
	recordDigest: string;
}

const VALID_STATES = new Set<ImplementerLeaseState>([
	"reserved",
	"worktree-ready",
	"ref-verified",
	"worktree-removed",
]);

export function isGitObjectId(value: unknown): value is string {
	return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function isImplementerToken(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function implementerAttemptRef(token: string): string {
	return `refs/ypi/attempt-${token}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCanonicalUnsignedInteger(value: unknown): value is string {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "recordDigest")
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalValue(entry)]),
	);
}

export function implementerLeaseRecordDigest(
	record: Omit<ImplementerLeaseRecord, "recordDigest"> | ImplementerLeaseRecord,
): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalValue(record)))
		.digest("hex");
}

function isWorkspaceFilesystemIdentity(value: unknown): value is WorkspaceFilesystemIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Partial<WorkspaceFilesystemIdentity>;
	return isCanonicalUnsignedInteger(identity.containerDevice)
		&& isCanonicalUnsignedInteger(identity.containerInode)
		&& (
			identity.ownerDevice === undefined
				? identity.ownerInode === undefined
				: isCanonicalUnsignedInteger(identity.ownerDevice)
					&& isCanonicalUnsignedInteger(identity.ownerInode)
		)
		&& (
			identity.worktreeDevice === undefined
				? identity.worktreeInode === undefined
				: isCanonicalUnsignedInteger(identity.worktreeDevice)
					&& isCanonicalUnsignedInteger(identity.worktreeInode)
		);
}

function isLeaseDirectoryIdentity(value: unknown): value is PrivatePathIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Partial<PrivatePathIdentity>;
	return identity.kind === "directory"
		&& isCanonicalUnsignedInteger(identity.device)
		&& isCanonicalUnsignedInteger(identity.inode)
		&& identity.mode === PRIVATE_DIRECTORY_MODE
		&& isCanonicalUnsignedInteger(identity.links);
}

function isLeaseFileIdentity(value: unknown): value is PrivatePathIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Partial<PrivatePathIdentity>;
	return identity.kind === "file"
		&& isCanonicalUnsignedInteger(identity.device)
		&& isCanonicalUnsignedInteger(identity.inode)
		&& identity.mode === 0o600
		&& identity.links === "1";
}

function isLeaseResourceIdentity(value: unknown): value is PrivatePathIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const identity = value as Partial<PrivatePathIdentity>;
	return (
		identity.kind === "file"
			? isLeaseFileIdentity(value)
			: identity.kind === "directory"
				? isLeaseDirectoryIdentity(value)
				: false
	);
}

function isLeaseResourceInventory(value: unknown): value is Record<string, PrivatePathIdentity> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const [relativePath, identity] of Object.entries(value)) {
		if (
			relativePath === ""
			|| relativePath === "."
			|| relativePath === "lease.json"
			|| path.isAbsolute(relativePath)
			|| path.normalize(relativePath) !== relativePath
			|| relativePath === ".."
			|| relativePath.startsWith(`..${path.sep}`)
			|| !isLeaseResourceIdentity(identity)
		) {
			return false;
		}
	}
	return true;
}

export function parseImplementerLeaseRecord(
	value: unknown,
	expectedToken: string,
	commonGitDir: string,
): ImplementerLeaseRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Implementer lease ${expectedToken} is malformed`);
	}
	const record = value as Partial<ImplementerLeaseRecord>;
	if (
		record.schemaVersion !== IMPLEMENTER_LEASE_SCHEMA_VERSION
		|| record.token !== expectedToken
		|| !isImplementerToken(expectedToken)
		|| !isPositiveSafeInteger(record.ownerPid)
		|| (record.childPid !== undefined && !isPositiveSafeInteger(record.childPid))
		|| (
			record.childLaunchStartedAtEpochSeconds !== undefined
			&& !isNonNegativeSafeInteger(record.childLaunchStartedAtEpochSeconds)
		)
		|| !isNonNegativeSafeInteger(record.createdAtEpochSeconds)
		|| typeof record.root !== "string"
		|| record.commonGitDir !== commonGitDir
		|| !isGitObjectId(record.baselineHead)
			|| record.attemptRef !== implementerAttemptRef(expectedToken)
			|| (record.attemptCommit !== undefined && !isGitObjectId(record.attemptCommit))
			|| typeof record.worktreeIndexOwnedByYpi !== "boolean"
			|| !isLeaseResourceInventory(record.leaseResources)
			|| !isLeaseDirectoryIdentity(record.leaseDirectoryIdentity)
		|| !isLeaseFileIdentity(record.leaseFileIdentity)
		|| !isNonNegativeSafeInteger(record.revision)
		|| typeof record.recordDigest !== "string"
		|| !/^[a-f0-9]{64}$/.test(record.recordDigest)
		|| (record.worktreeContainer !== undefined && typeof record.worktreeContainer !== "string")
		|| (record.worktreeRoot !== undefined && typeof record.worktreeRoot !== "string")
		|| (record.workspaceIdentity !== undefined && !isWorkspaceFilesystemIdentity(record.workspaceIdentity))
		|| !VALID_STATES.has(record.state as ImplementerLeaseState)
	) {
		throw new Error(`Implementer lease ${expectedToken} is malformed`);
	}
	const scope = normalizeImplementScope(record.scope);
	if (scope.join("\0") !== record.scope?.join("\0")) {
		throw new Error(`Implementer lease ${expectedToken} has a non-canonical scope`);
	}
	if (implementerLeaseRecordDigest(record as ImplementerLeaseRecord) !== record.recordDigest) {
		throw new Error(`Implementer lease ${expectedToken} has an invalid state digest`);
	}
	return record as ImplementerLeaseRecord;
}

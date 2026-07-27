import { normalizeImplementScope } from "./implement-scope.ts";

export const IMPLEMENTER_LEASE_SCHEMA_VERSION = 1;

export type ImplementerLeaseState =
	| "reserved"
	| "worktree-ready"
	| "ref-verified"
	| "worktree-removed";

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
	attemptRef: string;
	attemptCommit?: string;
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
		|| (record.worktreeContainer !== undefined && typeof record.worktreeContainer !== "string")
		|| (record.worktreeRoot !== undefined && typeof record.worktreeRoot !== "string")
		|| !VALID_STATES.has(record.state as ImplementerLeaseState)
	) {
		throw new Error(`Implementer lease ${expectedToken} is malformed`);
	}
	const scope = normalizeImplementScope(record.scope);
	if (scope.join("\0") !== record.scope?.join("\0")) {
		throw new Error(`Implementer lease ${expectedToken} has a non-canonical scope`);
	}
	return record as ImplementerLeaseRecord;
}

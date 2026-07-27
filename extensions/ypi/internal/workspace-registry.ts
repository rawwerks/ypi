import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeImplementScope, scopesOverlap } from "./implement-scope.ts";

export const MAX_PARALLEL_IMPLEMENTERS = 3;

export type ImplementerLeaseState =
	| "reserved"
	| "worktree-ready"
	| "ref-verified"
	| "worktree-removed";

export interface ImplementerLeaseRecord {
	schemaVersion: 1;
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

export interface RegistryPaths {
	root: string;
	leases: string;
	lock: string;
	retired: string;
	staging: string;
}

interface RegistryLock {
	token: string;
	path: string;
	release(): void;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function assertRegistryDirectory(directory: string): void {
	const metadata = lstatSync(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Implementer registry path ${directory} is not an owned directory. Inspect it before admitting writers.`);
	}
}

function ensureRegistryDirectory(directory: string): void {
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertRegistryDirectory(directory);
}

export function implementerRegistryPaths(commonGitDir: string): RegistryPaths {
	const root = path.join(commonGitDir, "ypi-implementers");
	return {
		root,
		leases: path.join(root, "leases"),
		lock: path.join(commonGitDir, "ypi-implementers.lock"),
		retired: path.join(root, "retired"),
		staging: path.join(root, "staging"),
	};
}

function wait(milliseconds: number): void {
	Atomics.wait(WAIT_ARRAY, 0, 0, milliseconds);
}

function acquireRegistryLock(commonGitDir: string, deadlineMilliseconds?: number): RegistryLock {
	const paths = implementerRegistryPaths(commonGitDir);
	ensureRegistryDirectory(paths.root);
	ensureRegistryDirectory(paths.leases);
	const deadline = deadlineMilliseconds ?? Date.now() + DEFAULT_LOCK_TIMEOUT_MS;
	const token = randomBytes(16).toString("hex");
	while (true) {
		try {
			mkdirSync(paths.lock, { mode: 0o700 });
			writeFileSync(
				path.join(paths.lock, "owner.json"),
				`${JSON.stringify({ schemaVersion: 1, token, pid: process.pid, createdAtEpochSeconds: Math.floor(Date.now() / 1000) })}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) {
				throw new Error(`Implementer lease registry is busy or interrupted at ${paths.lock}. Run rlm_cleanup --repo <checkout> to inspect and recover stale state.`);
			}
			wait(Math.min(20, Math.max(1, deadline - Date.now())));
		}
	}
	return {
		token,
		path: paths.lock,
		release() {
			try {
				const owner = JSON.parse(readFileSync(path.join(paths.lock, "owner.json"), "utf8")) as { token?: unknown };
				if (owner.token === token) rmSync(paths.lock, { recursive: true, force: true });
			} catch {
				// Uncertain ownership remains for explicit cleanup.
			}
		},
	};
}

export function withImplementerRegistryLock<T>(
	commonGitDir: string,
	action: (paths: RegistryPaths) => T,
	deadlineMilliseconds?: number,
): T {
	const lock = acquireRegistryLock(commonGitDir, deadlineMilliseconds);
	try {
		return action(implementerRegistryPaths(commonGitDir));
	} finally {
		lock.release();
	}
}

function validateRecord(value: unknown, expectedToken: string, commonGitDir: string): ImplementerLeaseRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Implementer lease ${expectedToken} is malformed`);
	}
	const record = value as Partial<ImplementerLeaseRecord>;
	const validState = record.state === "reserved"
		|| record.state === "worktree-ready"
		|| record.state === "ref-verified"
		|| record.state === "worktree-removed";
	if (
		record.schemaVersion !== 1
		|| record.token !== expectedToken
		|| !/^[a-f0-9]{32}$/.test(expectedToken)
		|| !Number.isSafeInteger(record.ownerPid)
		|| Number(record.ownerPid) <= 0
		|| (record.childPid !== undefined && (!Number.isSafeInteger(record.childPid) || record.childPid <= 0))
		|| (
			record.childLaunchStartedAtEpochSeconds !== undefined
			&& (!Number.isSafeInteger(record.childLaunchStartedAtEpochSeconds) || record.childLaunchStartedAtEpochSeconds < 0)
		)
		|| !Number.isSafeInteger(record.createdAtEpochSeconds)
		|| Number(record.createdAtEpochSeconds) < 0
		|| typeof record.root !== "string"
		|| record.commonGitDir !== commonGitDir
		|| typeof record.baselineHead !== "string"
		|| !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.baselineHead)
		|| typeof record.attemptRef !== "string"
		|| (record.attemptCommit !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.attemptCommit))
		|| (record.worktreeContainer !== undefined && typeof record.worktreeContainer !== "string")
		|| (record.worktreeRoot !== undefined && typeof record.worktreeRoot !== "string")
		|| !validState
	) {
		throw new Error(`Implementer lease ${expectedToken} is malformed`);
	}
	const scope = normalizeImplementScope(record.scope);
	if (scope.join("\0") !== record.scope?.join("\0")) {
		throw new Error(`Implementer lease ${expectedToken} has a non-canonical scope`);
	}
	if (record.attemptRef !== `refs/ypi/attempt-${expectedToken}`) {
		throw new Error(`Implementer lease ${expectedToken} has an invalid attempt ref`);
	}
	return record as ImplementerLeaseRecord;
}

export function readImplementerLeaseRecords(commonGitDir: string): ImplementerLeaseRecord[] {
	const paths = implementerRegistryPaths(commonGitDir);
	if (!existsSync(paths.root)) return [];
	assertRegistryDirectory(paths.root);
	if (!existsSync(paths.leases)) return [];
	assertRegistryDirectory(paths.leases);
	const entries = readdirSync(paths.leases, { withFileTypes: true });
	const unexpected = entries.find((entry) => !entry.isDirectory());
	if (unexpected) {
		throw new Error(`Implementer lease registry contains unexpected entry ${path.join(paths.leases, unexpected.name)}. Run rlm_cleanup --repo <checkout> and inspect it before admitting more writers.`);
	}
	return entries
		.map((entry) => {
			const recordPath = path.join(paths.leases, entry.name, "lease.json");
			try {
				const metadata = lstatSync(recordPath);
				if (!metadata.isFile() || metadata.isSymbolicLink()) {
					throw new Error(`Implementer lease ${entry.name} metadata is not a regular file`);
				}
				return validateRecord(JSON.parse(readFileSync(recordPath, "utf8")), entry.name, commonGitDir);
			} catch (error) {
				const cause = error instanceof Error ? error.message : String(error);
				throw new Error(`${cause}. Run rlm_cleanup --repo <checkout> and inspect ${recordPath} before admitting more writers.`);
			}
		})
		.sort((a, b) => a.token.localeCompare(b.token));
}

export function implementerLeaseDirectory(commonGitDir: string, token: string): string {
	return path.join(implementerRegistryPaths(commonGitDir).leases, token);
}

export function writeImplementerLeaseRecord(record: ImplementerLeaseRecord): void {
	const directory = implementerLeaseDirectory(record.commonGitDir, record.token);
	if (!existsSync(directory)) {
		throw new Error(`Implementer lease directory ${directory} is unavailable`);
	}
	assertRegistryDirectory(directory);
	const target = path.join(directory, "lease.json");
	const temporary = path.join(directory, `.lease.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temporary, target);
}

function createImplementerLeaseRecord(
	record: ImplementerLeaseRecord,
	onStaged?: (record: ImplementerLeaseRecord) => void,
): void {
	const paths = implementerRegistryPaths(record.commonGitDir);
	ensureRegistryDirectory(paths.staging);
	const finalDirectory = implementerLeaseDirectory(record.commonGitDir, record.token);
	const stagingDirectory = path.join(
		paths.staging,
		`.lease-${record.token}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	mkdirSync(stagingDirectory, { mode: 0o700 });
	try {
		writeFileSync(
			path.join(stagingDirectory, "lease.json"),
			`${JSON.stringify(record, null, 2)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		onStaged?.(record);
		renameSync(stagingDirectory, finalDirectory);
	} catch (error) {
		rmSync(stagingDirectory, { recursive: true, force: true });
		throw error;
	}
}

export function removeImplementerLeaseRecord(commonGitDir: string, token: string): void {
	const paths = implementerRegistryPaths(commonGitDir);
	const active = implementerLeaseDirectory(commonGitDir, token);
	if (!existsSync(active)) return;
	assertRegistryDirectory(active);
	ensureRegistryDirectory(paths.retired);
	const retired = path.join(paths.retired, `.lease-${token}-${process.pid}-${randomBytes(4).toString("hex")}.done`);
	renameSync(active, retired);
	rmSync(retired, { recursive: true, force: true });
}

export function reserveImplementerLease(
	commonGitDir: string,
	root: string,
	baselineHead: string,
	scope: string[],
	deadlineMilliseconds?: number,
	onReserved?: (record: ImplementerLeaseRecord) => void,
	onStaged?: (record: ImplementerLeaseRecord) => void,
): ImplementerLeaseRecord {
	return withImplementerRegistryLock(commonGitDir, () => {
		const active = readImplementerLeaseRecords(commonGitDir);
		const mismatched = active.find((record) => record.baselineHead !== baselineHead);
		if (mismatched) {
			throw new Error(`Live implementer ${mismatched.token.slice(0, 12)} uses baseline ${mismatched.baselineHead}; finish or recover it before changing the root baseline.`);
		}
		const overlapping = active.find((record) => scopesOverlap(scope, record.scope));
		if (overlapping) {
			throw new Error(`Requested implementer scope [${scope.join(", ")}] overlaps live implementer ${overlapping.token.slice(0, 12)} scope [${overlapping.scope.join(", ")}]. Wait for it to finish or choose a disjoint slice.`);
		}
		if (active.length >= MAX_PARALLEL_IMPLEMENTERS) {
			throw new Error(`Implementer concurrency cap ${MAX_PARALLEL_IMPLEMENTERS} is already in use. Wait for a live slice to finish before admitting another.`);
		}
		const token = randomBytes(16).toString("hex");
		const record: ImplementerLeaseRecord = {
			schemaVersion: 1,
			token,
			ownerPid: process.pid,
			createdAtEpochSeconds: Math.floor(Date.now() / 1000),
			root,
			commonGitDir,
			baselineHead,
			scope,
			state: "reserved",
			attemptRef: `refs/ypi/attempt-${token}`,
		};
		createImplementerLeaseRecord(record, onStaged);
		onReserved?.(record);
		return record;
	}, deadlineMilliseconds);
}

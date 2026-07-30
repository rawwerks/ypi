import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	renameSync,
} from "node:fs";
import path from "node:path";
import { normalizeImplementScope, scopesOverlap } from "./implement-scope.ts";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	implementerLeaseRecordDigest,
	implementerAttemptRef,
	type ImplementerLeaseRecord,
} from "./implementer-lease.ts";
import {
	initializeImplementerLeaseFile,
	readImplementerLeaseFile,
	writeImplementerLeaseFile,
} from "./implementer-lease-file.ts";
import {
	implementerRegistryPaths,
	type ImplementerRegistryPaths,
} from "./implementer-registry-layout.ts";
import {
	createImplementerMutex,
	retireImplementerMutex,
	type ImplementerMutexOwner,
} from "./implementer-mutex.ts";
import {
	assertPrivateDirectory,
	capturePrivateDirectoryIdentity,
	createOwnedPrivateFile,
	createPrivateDirectory,
	ensurePrivateDirectory,
} from "./private-path.ts";
import { retireImplementerLeaseOwnedTree } from "./implementer-lease-resources.ts";

export const MAX_PARALLEL_IMPLEMENTERS = 3;

interface RegistryLock {
	token: string;
	path: string;
	owner: ImplementerMutexOwner;
	release(): void;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function assertRegistryDirectory(directory: string): void {
	const metadata = lstatSync(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`Implementer registry path ${directory} is not an owned directory. Inspect it before admitting writers.`);
	}
	assertPrivateDirectory(directory);
}

function ensureRegistryDirectory(directory: string): void {
	ensurePrivateDirectory(directory);
	assertRegistryDirectory(directory);
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
	let owner: ImplementerMutexOwner | undefined;
	while (true) {
		try {
			owner = createImplementerMutex(
				paths.lock,
				token,
				Math.floor(Date.now() / 1000),
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
		owner: owner!,
		release() {
			retireImplementerMutex(paths.lock, this.owner);
		},
	};
}

export function withImplementerRegistryLock<T>(
	commonGitDir: string,
	action: (paths: ImplementerRegistryPaths) => T,
	deadlineMilliseconds?: number,
): T {
	const lock = acquireRegistryLock(commonGitDir, deadlineMilliseconds);
	let actionFailed = false;
	let actionError: unknown;
	let result!: T;
	try {
		result = action(implementerRegistryPaths(commonGitDir));
	} catch (error) {
		actionFailed = true;
		actionError = error;
	}
	try {
		lock.release();
	} catch (releaseError) {
		if (actionFailed) {
			throw new AggregateError(
				[actionError, releaseError],
				"Implementer registry action failed and lock release also failed",
			);
		}
		throw releaseError;
	}
	if (actionFailed) throw actionError;
	return result;
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
				return readImplementerLeaseFile(
					path.join(paths.leases, entry.name),
					entry.name,
					commonGitDir,
				);
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
	writeImplementerLeaseFile(directory, record);
}

function createImplementerLeaseRecord(
	record: Omit<
		ImplementerLeaseRecord,
		"leaseDirectoryIdentity" | "leaseFileIdentity" | "revision" | "recordDigest"
	>,
	onStaged?: (record: ImplementerLeaseRecord) => void,
): ImplementerLeaseRecord {
	const paths = implementerRegistryPaths(record.commonGitDir);
	const finalDirectory = implementerLeaseDirectory(record.commonGitDir, record.token);
	createPrivateDirectory(finalDirectory);
	try {
		const recordPath = path.join(finalDirectory, "lease.json");
		const leaseFileIdentity = createOwnedPrivateFile(recordPath, "");
		const complete: ImplementerLeaseRecord = {
			...record,
			leaseDirectoryIdentity: capturePrivateDirectoryIdentity(finalDirectory),
			leaseFileIdentity,
			revision: 0,
			recordDigest: "",
		};
		complete.recordDigest = implementerLeaseRecordDigest(complete);
		initializeImplementerLeaseFile(finalDirectory, complete);
		onStaged?.(complete);
		return complete;
	} catch (error) {
		// An incomplete no-clobber lease is recovery evidence. Preserve it.
		throw error;
	}
}

export function removeImplementerLeaseRecord(commonGitDir: string, token: string): void {
	const paths = implementerRegistryPaths(commonGitDir);
	const active = implementerLeaseDirectory(commonGitDir, token);
	if (!existsSync(active)) return;
	assertRegistryDirectory(active);
	const record = readImplementerLeaseFile(
		active,
		token,
		commonGitDir,
	);
	ensureRegistryDirectory(paths.retired);
	const retired = path.join(paths.retired, `.lease-${token}-${process.pid}-${randomBytes(4).toString("hex")}.done`);
	renameSync(active, retired);
	retireImplementerLeaseOwnedTree(record, retired);
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
		const pending: Omit<
			ImplementerLeaseRecord,
			"leaseDirectoryIdentity" | "leaseFileIdentity" | "revision" | "recordDigest"
		> = {
			schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
			token,
			ownerPid: process.pid,
			createdAtEpochSeconds: Math.floor(Date.now() / 1000),
			root,
			commonGitDir,
			baselineHead,
				scope,
				state: "reserved",
				attemptRef: implementerAttemptRef(token),
				worktreeIndexOwnedByYpi: false,
				leaseResources: {},
			};
		const record = createImplementerLeaseRecord(pending, onStaged);
		onReserved?.(record);
		return record;
	}, deadlineMilliseconds);
}

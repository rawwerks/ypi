import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-file.ts";
import { normalizeImplementScope, scopesOverlap } from "./implement-scope.ts";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	implementerAttemptRef,
	parseImplementerLeaseRecord,
	type ImplementerLeaseRecord,
} from "./implementer-lease.ts";

export const MAX_PARALLEL_IMPLEMENTERS = 3;

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
		let created = false;
		try {
			mkdirSync(paths.lock, { mode: 0o700 });
			created = true;
			atomicWriteJson(
				path.join(paths.lock, "owner.json"),
				{
					schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
					token,
					pid: process.pid,
					createdAtEpochSeconds: Math.floor(Date.now() / 1000),
				},
			);
			break;
		} catch (error) {
			if (created) {
				rmSync(paths.lock, { recursive: true, force: true });
				throw error;
			}
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
				return parseImplementerLeaseRecord(JSON.parse(readFileSync(recordPath, "utf8")), entry.name, commonGitDir);
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
	atomicWriteJson(target, record);
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
		atomicWriteJson(path.join(stagingDirectory, "lease.json"), record);
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
		};
		createImplementerLeaseRecord(record, onStaged);
		onReserved?.(record);
		return record;
	}, deadlineMilliseconds);
}

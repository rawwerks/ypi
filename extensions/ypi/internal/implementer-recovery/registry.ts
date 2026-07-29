import { randomBytes } from "node:crypto";
import {
	lstatSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
} from "node:fs";
import path from "node:path";
import {
	readImplementerLeaseFile,
	writeImplementerLeaseFile,
} from "../implementer-lease-file.ts";
import { retireImplementerLeaseOwnedTree } from "../implementer-lease-resources.ts";
import {
	createImplementerMutex,
	parseImplementerMutexOwner,
	retireImplementerMutex,
	type ImplementerMutexOwner,
} from "../implementer-mutex.ts";
import {
	assertPrivateDirectory,
	assertPrivatePathIdentity,
	ensurePrivateDirectory,
	readOwnedPrivateFile,
} from "../private-path.ts";
import {
	isImplementerToken,
	type ImplementerLeaseRecord,
} from "../implementer-lease.ts";

const STAGED_LEASE = /^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.tmp$/;
const RETIRED_LEASE = /^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.done$/;

export interface InvalidRegistryEntry {
	path: string;
	reason: string;
}

export interface RetiredLeaseArtifact {
	directory: string;
	record: ImplementerLeaseRecord;
}

export interface RetiredLeaseArtifactScan {
	stale: RetiredLeaseArtifact[];
	activeCount: number;
	invalid: InvalidRegistryEntry[];
}

export interface RecoveryLease {
	directory: string;
	record: ImplementerLeaseRecord;
	childPid?: number;
}

export type MutexOwner = ImplementerMutexOwner;

export function pathExistsWithoutFollowing(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function validateRegistryDirectory(candidate: string): void {
	if (!pathExistsWithoutFollowing(candidate)) return;
	const metadata = lstatSync(candidate);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`preserved invalid registry path ${candidate}`);
	}
	assertPrivateDirectory(candidate);
}

export function scanLegacyStagedArtifacts(
	root: string,
): InvalidRegistryEntry[] {
	const preserved: InvalidRegistryEntry[] = [];
	if (!pathExistsWithoutFollowing(root)) return preserved;
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		return [{ path: root, reason: "staged registry root is not a directory" }];
	}
	for (const name of readdirSync(root).sort()) {
		const candidate = path.join(root, name);
		const metadata = lstatSync(candidate);
		const recognized = STAGED_LEASE.test(name)
			&& metadata.isDirectory()
			&& !metadata.isSymbolicLink();
		preserved.push({
			path: candidate,
			reason: recognized
				? "pre-schema staged lease has no authoritative resource inventory"
				: "unexpected staged artifact has no authoritative resource inventory",
		});
	}
	return preserved;
}

export function scanRetiredLeaseArtifacts(
	root: string,
	commonGitDir: string,
	cutoffEpochSeconds: number,
	processAlive: (pid: number) => boolean,
): RetiredLeaseArtifactScan {
	const result: RetiredLeaseArtifactScan = { stale: [], activeCount: 0, invalid: [] };
	if (!pathExistsWithoutFollowing(root)) return result;
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		result.invalid.push({ path: root, reason: "retired registry root is not a directory" });
		return result;
	}
	for (const name of readdirSync(root).sort()) {
		const candidate = path.join(root, name);
		try {
			const match = RETIRED_LEASE.exec(name);
			const metadata = lstatSync(candidate);
			if (!match || !metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new Error("unexpected retired registry artifact");
			}
			const ownerPid = Number(match[2]);
			if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
				throw new Error("retired registry artifact owner PID is invalid");
			}
			const record = readImplementerLeaseFile(
				candidate,
				match[1],
				commonGitDir,
			);
			const eligible = Math.floor(metadata.mtimeMs / 1000) <= cutoffEpochSeconds;
			if (eligible && !processAlive(ownerPid)) {
				result.stale.push({ directory: candidate, record });
			} else {
				result.activeCount++;
			}
		} catch (error) {
			result.invalid.push({
				path: candidate,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

export function retireInterruptedLeaseArtifact(
	artifact: RetiredLeaseArtifact,
	commonGitDir: string,
	options: { afterEligibilityInventory?: () => void } = {},
): void {
	const current = readImplementerLeaseFile(
		artifact.directory,
		artifact.record.token,
		commonGitDir,
	);
	if (
		current.revision !== artifact.record.revision
		|| current.recordDigest !== artifact.record.recordDigest
	) {
		throw new Error("retired implementer lease record changed after recovery scan");
	}
	retireImplementerLeaseOwnedTree(current, artifact.directory, options);
}

export function loadRecoveryLease(
	leaseDirectory: string,
	commonGitDir: string,
): RecoveryLease {
	const token = path.basename(leaseDirectory);
	const record = readImplementerLeaseFile(
		leaseDirectory,
		token,
		commonGitDir,
	);
	return {
		directory: leaseDirectory,
		record,
		childPid: readRegisteredChildPid(leaseDirectory, record),
	};
}

export function readRegisteredChildPid(
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): number | undefined {
	const pidPath = path.join(leaseDirectory, "child-pid");
	if (!pathExistsWithoutFollowing(pidPath)) return record.childPid;
	const identity = record.leaseResources["child-pid"];
	if (!identity) {
		throw new Error("child PID metadata exists outside the lease resource inventory");
	}
	const value = readOwnedPrivateFile(pidPath, identity);
	if (!/^[1-9][0-9]*\n?$/.test(value)) {
		throw new Error("child PID metadata is invalid");
	}
	const observed = Number(value.trim());
	if (!Number.isSafeInteger(observed) || observed <= 0) {
		throw new Error("child PID metadata is invalid");
	}
	if (record.childPid !== undefined && record.childPid !== observed) {
		throw new Error("child PID metadata disagrees with the lease record");
	}
	return observed;
}

export function writeRecoveryLease(
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): void {
	writeImplementerLeaseFile(leaseDirectory, record);
}

export function retireRecoveryLease(leaseDirectory: string, token: string): void {
	const leasesRoot = path.dirname(leaseDirectory);
	if (
		path.basename(leaseDirectory) !== token
		|| path.basename(leasesRoot) !== "leases"
		|| !isImplementerToken(token)
		|| lstatSync(leaseDirectory).isSymbolicLink()
	) {
		throw new Error("lease directory cannot be retired safely");
	}
	const record = readImplementerLeaseFile(
		leaseDirectory,
		token,
		path.dirname(path.dirname(path.dirname(leaseDirectory))),
	);
	const retiredRoot = path.join(path.dirname(leasesRoot), "retired");
	ensurePrivateDirectory(retiredRoot);
	validateRegistryDirectory(retiredRoot);
	const destination = path.join(
		retiredRoot,
		`.lease-${token}-${process.pid}-${randomBytes(4).toString("hex")}.done`,
	);
	renameSync(leaseDirectory, destination);
	retireImplementerLeaseOwnedTree(record, destination);
}

export function readMutexOwner(lockPath: string): MutexOwner | undefined {
	try {
		const ownerPath = path.join(lockPath, "owner.json");
		const metadata = lstatSync(ownerPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
		const owner = parseImplementerMutexOwner(
			JSON.parse(readFileSync(ownerPath, "utf8")),
		);
		assertPrivatePathIdentity(lockPath, owner.directoryIdentity);
		assertPrivatePathIdentity(ownerPath, owner.ownerFileIdentity);
		return owner;
	} catch {
		return undefined;
	}
}

export function acquireRecoveryMutex(
	lockPath: string,
	createdAtEpochSeconds = Math.floor(Date.now() / 1000),
): string {
	const token = randomBytes(16).toString("hex");
	createImplementerMutex(lockPath, token, createdAtEpochSeconds);
	return token;
}

export function releaseRecoveryMutex(lockPath: string, token: string): void {
	const owner = readMutexOwner(lockPath);
	if (!owner && pathExistsWithoutFollowing(lockPath)) {
		throw new Error("implementer mutex identity changed or its owner record is malformed");
	}
	if (owner && owner.token !== token) {
		throw new Error("implementer mutex token changed");
	}
	if (owner) retireImplementerMutex(lockPath, owner);
}

export function pathModifiedAtEpochSeconds(candidate: string): number {
	return Math.floor(statSync(candidate).mtimeMs / 1000);
}

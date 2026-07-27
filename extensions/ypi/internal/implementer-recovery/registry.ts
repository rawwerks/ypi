import { randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "../atomic-file.ts";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	isImplementerToken,
	parseImplementerLeaseRecord,
	type ImplementerLeaseRecord,
} from "../implementer-lease.ts";

const STAGED_LEASE = /^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.tmp$/;
const RETIRED_LEASE = /^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.done$/;

export interface InvalidRegistryEntry {
	path: string;
	reason: string;
}

export interface RegistryArtifactScan {
	stale: string[];
	activeCount: number;
	invalid: InvalidRegistryEntry[];
}

export interface RecoveryLease {
	directory: string;
	record: ImplementerLeaseRecord;
	childPid?: number;
}

export interface MutexOwner {
	token?: unknown;
	pid?: unknown;
	createdAtEpochSeconds?: unknown;
}

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
}

function artifactPattern(kind: "staged" | "retired"): RegExp {
	return kind === "staged" ? STAGED_LEASE : RETIRED_LEASE;
}

export function scanRegistryArtifacts(
	root: string,
	kind: "staged" | "retired",
	cutoffEpochSeconds: number,
	processAlive: (pid: number) => boolean,
): RegistryArtifactScan {
	const result: RegistryArtifactScan = { stale: [], activeCount: 0, invalid: [] };
	if (!pathExistsWithoutFollowing(root)) return result;
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		result.invalid.push({ path: root, reason: "registry artifact root is not a directory" });
		return result;
	}
	const pattern = artifactPattern(kind);
	for (const name of readdirSync(root).sort()) {
		const candidate = path.join(root, name);
		const match = pattern.exec(name);
		const metadata = lstatSync(candidate);
		if (!match || !metadata.isDirectory() || metadata.isSymbolicLink()) {
			result.invalid.push({ path: candidate, reason: "unexpected registry artifact" });
			continue;
		}
		if (kind === "staged") {
			const contents = readdirSync(candidate);
			if (contents.length > 1) {
				result.invalid.push({ path: candidate, reason: "staged lease contains unexpected content" });
				continue;
			}
			if (contents.length === 1) {
				const metadataPath = path.join(candidate, contents[0]);
				const entryMetadata = lstatSync(metadataPath);
				if (
					contents[0] !== "lease.json"
					|| !entryMetadata.isFile()
					|| entryMetadata.isSymbolicLink()
				) {
					result.invalid.push({ path: candidate, reason: "staged lease contains unexpected content" });
					continue;
				}
			}
		}
		const ownerPid = Number(match[2]);
		if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
			result.invalid.push({ path: candidate, reason: "registry artifact owner PID is invalid" });
			continue;
		}
		const eligible = Math.floor(metadata.mtimeMs / 1000) <= cutoffEpochSeconds;
		if (eligible && !processAlive(ownerPid)) result.stale.push(candidate);
		else result.activeCount++;
	}
	return result;
}

export function loadRecoveryLease(
	leaseDirectory: string,
	commonGitDir: string,
): RecoveryLease {
	const token = path.basename(leaseDirectory);
	const recordPath = path.join(leaseDirectory, "lease.json");
	const metadata = lstatSync(recordPath);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("record metadata is not a regular file");
	}
	const record = parseImplementerLeaseRecord(
		JSON.parse(readFileSync(recordPath, "utf8")),
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
	const metadata = lstatSync(pidPath);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new Error("child PID metadata is not a regular file");
	}
	const value = readFileSync(pidPath, "utf8");
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
	atomicWriteJson(path.join(leaseDirectory, "lease.json"), record);
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
	const retiredRoot = path.join(path.dirname(leasesRoot), "retired");
	if (!existsSync(retiredRoot)) mkdirSync(retiredRoot, { mode: 0o700 });
	validateRegistryDirectory(retiredRoot);
	const destination = path.join(
		retiredRoot,
		`.lease-${token}-${process.pid}-${randomBytes(4).toString("hex")}.done`,
	);
	renameSync(leaseDirectory, destination);
	rmSync(destination, { recursive: true });
}

export function readMutexOwner(lockPath: string): MutexOwner | undefined {
	try {
		const ownerPath = path.join(lockPath, "owner.json");
		const metadata = lstatSync(ownerPath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
		const value = JSON.parse(readFileSync(ownerPath, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? value as MutexOwner
			: undefined;
	} catch {
		return undefined;
	}
}

export function acquireRecoveryMutex(
	lockPath: string,
	createdAtEpochSeconds = Math.floor(Date.now() / 1000),
): string {
	const token = randomBytes(16).toString("hex");
	mkdirSync(lockPath, { mode: 0o700 });
	try {
		atomicWriteJson(path.join(lockPath, "owner.json"), {
			schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
			token,
			pid: process.pid,
			createdAtEpochSeconds,
		});
	} catch (error) {
		rmSync(lockPath, { recursive: true, force: true });
		throw error;
	}
	return token;
}

export function releaseRecoveryMutex(lockPath: string, token: string): void {
	if (readMutexOwner(lockPath)?.token === token) {
		rmSync(lockPath, { recursive: true });
	}
}

export function removeValidatedArtifact(candidate: string): void {
	const metadata = lstatSync(candidate);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`registry artifact is no longer a safe directory: ${candidate}`);
	}
	rmSync(candidate, { recursive: true });
}

export function pathModifiedAtEpochSeconds(candidate: string): number {
	return Math.floor(statSync(candidate).mtimeMs / 1000);
}

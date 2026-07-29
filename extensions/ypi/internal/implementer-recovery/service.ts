import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { implementerRegistryPaths } from "../implementer-registry-layout.ts";
import { processIsAlive } from "../process-liveness.ts";
import { createRecoveryGit, type RecoveryGit } from "./git.ts";
import {
	acquireRecoveryMutex,
	loadRecoveryLease,
	pathExistsWithoutFollowing,
	readMutexOwner,
	releaseRecoveryMutex,
	retireInterruptedLeaseArtifact,
	scanLegacyStagedArtifacts,
	scanRetiredLeaseArtifacts,
	validateRegistryDirectory,
	type InvalidRegistryEntry,
	type RecoveryLease,
} from "./registry.ts";
import { recoverLeaseWorkspace } from "./workspace.ts";

const LAUNCH_REGISTRATION_GRACE_SECONDS = 5;

export interface ImplementerRecoveryOptions {
	repo: string;
	ageMinutes: number;
	force: boolean;
}

export interface ImplementerRecoveryReport {
	exitCode: number;
	stdout: string[];
	stderr: string[];
}

export interface ImplementerRecoveryDependencies {
	git: RecoveryGit;
	nowEpochSeconds(): number;
	processAlive(pid: number | undefined): boolean;
}

function defaultDependencies(): ImplementerRecoveryDependencies {
	return {
		git: createRecoveryGit(),
		nowEpochSeconds: () => Math.floor(Date.now() / 1000),
		processAlive: processIsAlive,
	};
}

export function leaseNeedsRecovery(
	lease: RecoveryLease,
	cutoffEpochSeconds: number,
	nowEpochSeconds: number,
	alive: (pid: number | undefined) => boolean,
): boolean {
	const eligible = lease.record.createdAtEpochSeconds <= cutoffEpochSeconds;
	const launchStarted = lease.record.childLaunchStartedAtEpochSeconds;
	const launchRegistrationPending = lease.childPid === undefined
		&& launchStarted !== undefined
		&& nowEpochSeconds - launchStarted < LAUNCH_REGISTRATION_GRACE_SECONDS;
	return eligible
		&& !alive(lease.record.ownerPid)
		&& !alive(lease.childPid)
		&& !launchRegistrationPending;
}

function invalidEntry(candidate: string, error: unknown): InvalidRegistryEntry {
	return {
		path: candidate,
		reason: error instanceof Error ? error.message : String(error),
	};
}

function readRecoveryLeases(
	leasesRoot: string,
	commonGitDir: string,
): { leases: RecoveryLease[]; invalid: InvalidRegistryEntry[] } {
	const leases: RecoveryLease[] = [];
	const invalid: InvalidRegistryEntry[] = [];
	if (!pathExistsWithoutFollowing(leasesRoot)) return { leases, invalid };
	for (const name of readdirSync(leasesRoot).sort()) {
		const candidate = path.join(leasesRoot, name);
		try {
			const metadata = lstatSync(candidate);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new Error("unexpected non-directory registry entry");
			}
			leases.push(loadRecoveryLease(candidate, commonGitDir));
		} catch (error) {
			invalid.push(invalidEntry(candidate, error));
		}
	}
	return { leases, invalid };
}

function lockIsStale(
	lockPath: string,
	cutoffEpochSeconds: number,
	nowEpochSeconds: number,
	alive: (pid: number | undefined) => boolean,
): boolean {
	if (!pathExistsWithoutFollowing(lockPath)) return false;
	const owner = readMutexOwner(lockPath);
	if (!owner) return false;
	const pid = Number.isSafeInteger(owner?.pid) ? Number(owner?.pid) : undefined;
	const created = Number.isSafeInteger(owner?.createdAtEpochSeconds)
		? Number(owner?.createdAtEpochSeconds)
		: undefined;
	return !alive(pid)
		&& created !== undefined
		&& created <= cutoffEpochSeconds;
}

export function recoverImplementerWorkspaces(
	options: ImplementerRecoveryOptions,
	dependencies: ImplementerRecoveryDependencies = defaultDependencies(),
): ImplementerRecoveryReport {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const label = `Implementer leases older than ${options.ageMinutes}m`;
	const repoRoot = dependencies.git.optionalText(options.repo, ["rev-parse", "--show-toplevel"]);
	if (!repoRoot) {
		stdout.push(`${label}: no Git checkout`);
		return { exitCode: 0, stdout, stderr };
	}
	const commonGitDir = dependencies.git.optionalText(
		repoRoot,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
	);
	if (!commonGitDir) {
		stdout.push(`${label}: Git common directory unavailable`);
		return { exitCode: 1, stdout, stderr };
	}
	const paths = implementerRegistryPaths(commonGitDir);
	for (const registryPath of [paths.root, paths.leases, paths.staging, paths.retired]) {
		try {
			validateRegistryDirectory(registryPath);
		} catch {
			stdout.push(`${label}: preserved invalid registry path ${registryPath}`);
			return { exitCode: 1, stdout, stderr };
		}
	}
	if (pathExistsWithoutFollowing(paths.lock)) {
		const metadata = lstatSync(paths.lock);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			stdout.push(`${label}: preserved invalid registry lock ${paths.lock}`);
			return { exitCode: 1, stdout, stderr };
		}
		if (!readMutexOwner(paths.lock)) {
			stdout.push(`${label}: skipped (preserved incomplete or replaced registry lock: ${paths.lock})`);
			return { exitCode: 0, stdout, stderr };
		}
	}

	const now = dependencies.nowEpochSeconds();
	const cutoff = now - options.ageMinutes * 60;
	const staleLock = lockIsStale(
		paths.lock,
		cutoff,
		now,
		dependencies.processAlive,
	);
	if (pathExistsWithoutFollowing(paths.lock) && !staleLock) {
		stdout.push(`${label}: skipped (live or recent registry lock: ${paths.lock})`);
		return { exitCode: 0, stdout, stderr };
	}
	if (staleLock && !options.force) {
		stdout.push(`Stale implementer registry lock: ${paths.lock} (use --force to recover)`);
	}
	if (staleLock && options.force) {
		const owner = readMutexOwner(paths.lock);
		if (!owner) {
			stdout.push(`${label}: skipped (preserved incomplete or replaced registry lock: ${paths.lock})`);
			return { exitCode: 0, stdout, stderr };
		}
		releaseRecoveryMutex(paths.lock, owner.token);
	}

	const loaded = readRecoveryLeases(paths.leases, commonGitDir);
	const staged = scanLegacyStagedArtifacts(paths.staging);
	const retired = scanRetiredLeaseArtifacts(
		paths.retired,
		commonGitDir,
		cutoff,
		dependencies.processAlive,
	);
	const invalid = [
		...loaded.invalid,
		...retired.invalid,
	];
	const stale: RecoveryLease[] = [];
	let active = 0;
	for (const lease of loaded.leases) {
		if (leaseNeedsRecovery(lease, cutoff, now, dependencies.processAlive)) stale.push(lease);
		else active++;
	}
	stdout.push(
		`${label}: ${stale.length} `
		+ `(active/recent: ${active}, staged-preserved: ${staged.length}, `
		+ `retired: ${retired.stale.length}/${retired.activeCount}, invalid: ${invalid.length})`,
	);
	for (const entry of invalid) {
		stdout.push(`  preserved invalid lease ${entry.path}: ${entry.reason}`);
	}
	for (const entry of staged) {
		stdout.push(`  preserved staged artifact ${entry.path}: ${entry.reason}`);
	}
	if (!options.force) {
		for (const lease of stale) {
			stdout.push(
				`  would recover ${lease.record.token.slice(0, 12)} `
				+ `scope=[${lease.record.scope.join(", ")}] from ${lease.directory}`,
			);
		}
		for (const artifact of retired.stale) {
			stdout.push(`  would finish removing retired lease ${artifact.directory}`);
		}
		if (stale.length || retired.stale.length) {
			stdout.push("  (use --force to salvage refs and remove recovered worktrees)");
		}
		if (staged.length) {
			stdout.push("  staged artifacts require manual inspection because no complete resource inventory exists");
		}
		return { exitCode: 0, stdout, stderr };
	}

	let lockToken = "";
	let failures = invalid.length + staged.length;
	let recovered = 0;
	try {
		lockToken = acquireRecoveryMutex(paths.lock, now);
		for (const artifact of retired.stale) {
			try {
				retireInterruptedLeaseArtifact(artifact, commonGitDir);
				stdout.push(`  removed retired lease ${path.basename(artifact.directory)}`);
			} catch (error) {
				failures++;
				stderr.push(
					`  preserved retired lease ${path.basename(artifact.directory)}: `
					+ `${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const lease of stale) {
			try {
				const result = recoverLeaseWorkspace(
					dependencies.git,
					repoRoot,
					commonGitDir,
					lease.directory,
					lease.record,
				);
				recovered++;
				stdout.push(
					`  recovered ${lease.record.token.slice(0, 12)} at ${result.destination}`,
				);
			} catch (error) {
				failures++;
				stderr.push(
					`  preserved ${lease.record.token.slice(0, 12)}: `
					+ `${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		stdout.push(`  recovered leases: ${recovered}`);
	} finally {
		if (lockToken) releaseRecoveryMutex(paths.lock, lockToken);
	}
	return { exitCode: failures > 0 ? 1 : 0, stdout, stderr };
}

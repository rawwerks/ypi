import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import { pathIsWithinImplementScope } from "../implement-scope.ts";
import {
	isGitObjectId,
	type ImplementerLeaseRecord,
} from "../implementer-lease.ts";
import {
	pathExistsWithoutFollowing,
	retireRecoveryLease,
	writeRecoveryLease,
} from "./registry.ts";
import {
	decodeGitPath,
	decodeNulPaths,
	type RecoveryGit,
} from "./git.ts";

export interface RecoveredLease {
	attemptCommit?: string;
	destination: string;
}

function splitNulRecords(value: Uint8Array): Buffer[] {
	const buffer = Buffer.from(value);
	const records: Buffer[] = [];
	let start = 0;
	for (let index = 0; index <= buffer.length; index++) {
		if (index !== buffer.length && buffer[index] !== 0) continue;
		if (index > start) records.push(buffer.subarray(start, index));
		start = index + 1;
	}
	return records;
}

function uniquePaths(...groups: string[][]): string[] {
	return [...new Set(groups.flat())].sort();
}

function changedPaths(git: RecoveryGit, worktree: string, baseline: string): string[] {
	return uniquePaths(
		decodeNulPaths(git.run(worktree, ["diff", "--name-only", "-z", "--no-renames", baseline, "--"])),
		decodeNulPaths(git.run(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])),
	);
}

function assertNoUnsnapshottedPaths(git: RecoveryGit, worktree: string): void {
	const ignored = decodeNulPaths(
		git.run(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
	);
	if (ignored.length > 0) {
		throw new Error(`worktree contains ignored paths that cannot be snapshotted: ${ignored.join(", ")}`);
	}
	const index = git.run(worktree, ["ls-files", "--stage", "-z"]);
	for (const record of splitNulRecords(index)) {
		const separator = record.indexOf(0x09);
		if (separator < 0 || !record.subarray(0, separator).toString("ascii").startsWith("160000 ")) continue;
		const relativePath = decodeGitPath(record.subarray(separator + 1));
		const submodule = path.join(worktree, ...relativePath.split("/"));
		if (pathExistsWithoutFollowing(submodule)) {
			const metadata = lstatSync(submodule);
			if (
				!metadata.isDirectory()
				|| metadata.isSymbolicLink()
				|| readdirSync(submodule).length > 0
			) {
				throw new Error(`worktree contains content inside an uninitialized submodule: ${relativePath}`);
			}
		}
	}
}

function captureWorktreeTree(
	git: RecoveryGit,
	worktree: string,
	baseline: string,
	indexPath: string,
): string {
	assertNoUnsnapshottedPaths(git, worktree);
	rmSync(indexPath, { force: true });
	const environment = { GIT_INDEX_FILE: indexPath };
	git.text(worktree, ["read-tree", baseline], environment);
	git.text(worktree, ["add", "-A", "--", "."], environment);
	return git.text(worktree, ["write-tree"], environment);
}

function validateWorkspaceLocation(record: ImplementerLeaseRecord): {
	container: string;
	worktree: string;
} {
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

function readRegularFileNoFollow(candidate: string): Buffer {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) throw new Error("path is not a regular file");
		return Buffer.from(readFileSync(descriptor));
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function verifyOwnedContainer(record: ImplementerLeaseRecord): {
	container: string;
	worktree: string;
} {
	const location = validateWorkspaceLocation(record);
	const metadata = lstatSync(location.container);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("recorded worktree path is not an owned ypi workspace");
	}
	let owner: string;
	try {
		owner = readRegularFileNoFollow(path.join(location.container, "owner")).toString("utf8").trim();
	} catch (error) {
		throw new Error(`workspace ownership marker is unavailable: ${(error as Error).message}`);
	}
	if (owner !== record.token) {
		throw new Error("workspace ownership marker does not match the lease");
	}
	if (pathExistsWithoutFollowing(location.worktree)) {
		const worktreeMetadata = lstatSync(location.worktree);
		if (!worktreeMetadata.isDirectory() || worktreeMetadata.isSymbolicLink()) {
			throw new Error("recorded checkout is not an owned worktree directory");
		}
	}
	return location;
}

function verifyWorktree(
	git: RecoveryGit,
	record: ImplementerLeaseRecord,
	commonGitDir: string,
): string {
	const { worktree } = verifyOwnedContainer(record);
	const discovered = git.optionalText(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (
		!discovered
		|| realpathSync(discovered) !== realpathSync(commonGitDir)
	) {
		throw new Error("worktree does not belong to the requested repository");
	}
	return worktree;
}

function removePartialContainer(
	container: string,
	record: ImplementerLeaseRecord,
): void {
	const metadata = lstatSync(container);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("partial workspace container is not an owned directory");
	}
	const entries = readdirSync(container);
	if (entries.length === 0) {
		rmdirSync(container);
		return;
	}
	const markerPath = path.join(container, "owner");
	if (entries.length !== 1 || entries[0] !== "owner") {
		throw new Error("partial workspace container has unexpected content");
	}
	const marker = lstatSync(markerPath);
	if (!marker.isFile() || marker.isSymbolicLink()) {
		throw new Error("partial workspace ownership marker is invalid");
	}
	const actual = readRegularFileNoFollow(markerPath);
	const expected = Buffer.from(`${record.token}\n`);
	if (actual.length > expected.length || !expected.subarray(0, actual.length).equals(actual)) {
		throw new Error("partial workspace ownership marker is invalid");
	}
	unlinkSync(markerPath);
	rmdirSync(container);
}

function removeContainerWithoutWorktree(record: ImplementerLeaseRecord): void {
	const { container, worktree } = validateWorkspaceLocation(record);
	if (pathExistsWithoutFollowing(worktree)) {
		throw new Error("worktree still exists");
	}
	if (!pathExistsWithoutFollowing(container)) return;
	try {
		verifyOwnedContainer(record);
		rmSync(container, { recursive: true });
	} catch {
		removePartialContainer(container, record);
	}
}

function verifyAttemptRef(
	git: RecoveryGit,
	repoRoot: string,
	record: ImplementerLeaseRecord,
): string | undefined {
	const refLines = git.text(
		repoRoot,
		["for-each-ref", "--format=%(refname) %(objectname)", "--", record.attemptRef],
	).split("\n").filter(Boolean);
	if (refLines.length === 0) return undefined;
	const separator = refLines[0].indexOf(" ");
	const exactRef = separator < 0 ? "" : refLines[0].slice(0, separator);
	const objectId = separator < 0 ? "" : refLines[0].slice(separator + 1);
	if (
		refLines.length !== 1
		|| exactRef !== record.attemptRef
		|| !isGitObjectId(objectId)
	) {
		throw new Error("attempt ref lookup returned unexpected data");
	}
	const commit = git.text(
		repoRoot,
		["rev-parse", "--verify", `${record.attemptRef}^{commit}`],
	);
	if (record.attemptCommit !== undefined && record.attemptCommit !== commit) {
		throw new Error("attempt ref no longer resolves to the recorded commit");
	}
	const ancestry = git.text(repoRoot, ["rev-list", "--parents", "-n", "1", commit])
		.split(/\s+/);
	if (ancestry.length !== 2 || ancestry[1] !== record.baselineHead) {
		throw new Error("attempt ref is not a single-parent child of the recorded baseline");
	}
	const outside = decodeNulPaths(git.run(
		repoRoot,
		["diff", "--name-only", "-z", "--no-renames", record.baselineHead, commit, "--"],
	)).filter((candidate) => !pathIsWithinImplementScope(candidate, record.scope));
	if (outside.length > 0) {
		throw new Error(`attempt ref contains paths outside scope: ${outside.join(", ")}`);
	}
	return commit;
}

function snapshotWorktree(
	git: RecoveryGit,
	worktree: string,
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): string {
	const outside = changedPaths(git, worktree, record.baselineHead)
		.filter((candidate) => !pathIsWithinImplementScope(candidate, record.scope));
	if (outside.length > 0) {
		throw new Error(`worktree contains paths outside scope: ${outside.join(", ")}`);
	}
	const indexPath = path.join(leaseDirectory, "cleanup-index");
	const environment = { GIT_INDEX_FILE: indexPath };
	try {
		const tree = captureWorktreeTree(git, worktree, record.baselineHead, indexPath);
		const commit = git.text(
			worktree,
			[
				"commit-tree",
				tree,
				"-p",
				record.baselineHead,
				"-m",
				`ypi cleanup salvage ${record.token.slice(0, 12)}`,
			],
			{
				...environment,
				GIT_AUTHOR_NAME: "ypi",
				GIT_AUTHOR_EMAIL: "ypi@localhost",
				GIT_COMMITTER_NAME: "ypi",
				GIT_COMMITTER_EMAIL: "ypi@localhost",
			},
		);
		git.text(
			worktree,
			["update-ref", record.attemptRef, commit, "0".repeat(record.baselineHead.length)],
		);
		const verified = git.text(
			worktree,
			["rev-parse", "--verify", `${record.attemptRef}^{commit}`],
		);
		const verifiedTree = git.text(worktree, ["rev-parse", `${verified}^{tree}`]);
		if (verified !== commit || verifiedTree !== tree) {
			throw new Error("salvage ref verification did not resolve to the captured tree");
		}
		record.attemptCommit = commit;
		record.state = "ref-verified";
		writeRecoveryLease(leaseDirectory, record);
		return commit;
	} finally {
		rmSync(indexPath, { force: true });
	}
}

function removeRecoveredWorktree(
	git: RecoveryGit,
	repoRoot: string,
	worktree: string,
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): void {
	git.text(repoRoot, ["worktree", "remove", "--force", worktree]);
	record.state = "worktree-removed";
	writeRecoveryLease(leaseDirectory, record);
	const { container } = verifyOwnedContainer(record);
	if (pathExistsWithoutFollowing(container)) rmSync(container, { recursive: true });
	retireRecoveryLease(leaseDirectory, record.token);
}

function discardReservedWorkspace(
	git: RecoveryGit,
	repoRoot: string,
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): void {
	if (!record.worktreeContainer || !record.worktreeRoot) {
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	const { container, worktree } = validateWorkspaceLocation(record);
	if (!pathExistsWithoutFollowing(container)) {
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	if (!pathExistsWithoutFollowing(worktree)) {
		removeContainerWithoutWorktree(record);
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	try {
		verifyOwnedContainer(record);
	} catch {
		if (pathExistsWithoutFollowing(worktree)) {
			throw new Error("unmarked reserved workspace unexpectedly contains a checkout");
		}
		removePartialContainer(container, record);
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	try {
		git.text(repoRoot, ["worktree", "remove", "--force", worktree]);
	} catch {
		rmSync(container, { recursive: true });
		git.text(repoRoot, ["worktree", "prune", "--expire", "now"]);
	}
	if (pathExistsWithoutFollowing(container)) rmSync(container, { recursive: true });
	retireRecoveryLease(leaseDirectory, record.token);
}

export function recoverLeaseWorkspace(
	git: RecoveryGit,
	repoRoot: string,
	commonGitDir: string,
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): RecoveredLease {
	let commit = verifyAttemptRef(git, repoRoot, record);
	if (record.state === "reserved") {
		if (commit !== undefined) {
			throw new Error("reserved lease unexpectedly owns an attempt ref");
		}
		discardReservedWorkspace(git, repoRoot, leaseDirectory, record);
		return { destination: "reserved workspace before child admission" };
	}
	const worktreeExists = record.worktreeRoot !== undefined
		&& pathExistsWithoutFollowing(record.worktreeRoot);
	if (worktreeExists) {
		const worktree = verifyWorktree(git, record, commonGitDir);
		if (!commit) commit = snapshotWorktree(git, worktree, leaseDirectory, record);
		const refTree = git.text(repoRoot, ["rev-parse", `${commit}^{tree}`]);
		const verificationIndex = path.join(leaseDirectory, "cleanup-verify-index");
		let currentTree: string;
		try {
			currentTree = captureWorktreeTree(
				git,
				worktree,
				record.baselineHead,
				verificationIndex,
			);
		} finally {
			rmSync(verificationIndex, { force: true });
		}
		if (currentTree !== refTree) {
			throw new Error("worktree changed after its verified attempt ref was captured");
		}
		removeRecoveredWorktree(git, repoRoot, worktree, leaseDirectory, record);
		return {
			attemptCommit: commit,
			destination: `${record.attemptRef} (${commit})`,
		};
	}
	if (commit) {
		removeContainerWithoutWorktree(record);
		retireRecoveryLease(leaseDirectory, record.token);
		return {
			attemptCommit: commit,
			destination: `${record.attemptRef} (${commit})`,
		};
	}
	throw new Error("worktree is missing and no verified attempt ref proves recoverability");
}

import {
	lstatSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { pathIsWithinImplementScope } from "../implement-scope.ts";
import {
	isGitObjectId,
	type ImplementerLeaseRecord,
} from "../implementer-lease.ts";
import {
	retireEmptyWorkspaceContainer,
	verifyWorkspaceContainer,
	workspaceLocation,
} from "../workspace-container.ts";
import {
	assertWorktreeUnregistered as assertUnregisteredInInventory,
	WORKTREE_INVENTORY_ARGUMENTS,
} from "../worktree-inventory.ts";
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

function assertWorktreeUnregistered(
	git: RecoveryGit,
	repoRoot: string,
	worktree: string,
): void {
	assertUnregisteredInInventory(
		git.run(repoRoot, [...WORKTREE_INVENTORY_ARGUMENTS]),
		worktree,
	);
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
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): string {
	assertNoUnsnapshottedPaths(git, worktree);
	if (!record.worktreeIndexOwnedByYpi) {
		const baselineTree = git.text(worktree, ["rev-parse", `${baseline}^{tree}`]);
		const currentIndexTree = git.text(worktree, ["write-tree"]);
		if (currentIndexTree !== baselineTree) {
			throw new Error(
				"worktree index differs from the baseline and is not recorded as ypi-owned; preserve it for explicit inspection",
			);
		}
		record.worktreeIndexOwnedByYpi = true;
		writeRecoveryLease(leaseDirectory, record);
	}
	git.text(worktree, ["read-tree", baseline]);
	git.text(worktree, ["add", "-A", "--", "."]);
	return git.text(worktree, ["write-tree"]);
}

function verifyWorktree(
	git: RecoveryGit,
	record: ImplementerLeaseRecord,
	commonGitDir: string,
): string {
	const { worktree } = verifyWorkspaceContainer(record, "present");
	const discovered = git.optionalText(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (
		!discovered
		|| realpathSync(discovered) !== realpathSync(commonGitDir)
	) {
		throw new Error("worktree does not belong to the requested repository");
	}
	return worktree;
}

function removeContainerWithoutWorktree(record: ImplementerLeaseRecord): void {
	const { container, worktree } = workspaceLocation(record);
	if (pathExistsWithoutFollowing(worktree)) {
		throw new Error("worktree still exists");
	}
	if (!pathExistsWithoutFollowing(container)) return;
	if (!record.workspaceIdentity) {
		throw new Error(
			"workspace filesystem identity is unavailable; preserve it for explicit inspection",
		);
	}
	retireEmptyWorkspaceContainer(record);
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
	const tree = captureWorktreeTree(
		git,
		worktree,
		record.baselineHead,
		leaseDirectory,
		record,
	);
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
}

function removeRecoveredWorktree(
	git: RecoveryGit,
	repoRoot: string,
	worktree: string,
	leaseDirectory: string,
	record: ImplementerLeaseRecord,
): void {
	verifyWorkspaceContainer(record, "present");
	git.text(repoRoot, ["worktree", "remove", "--force", worktree]);
	if (pathExistsWithoutFollowing(worktree)) {
		throw new Error("Git reported worktree removal but the checkout still exists");
	}
	assertWorktreeUnregistered(git, repoRoot, worktree);
	verifyWorkspaceContainer(record, "absent");
	record.state = "worktree-removed";
	writeRecoveryLease(leaseDirectory, record);
	retireEmptyWorkspaceContainer(record);
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
	const { container, worktree } = workspaceLocation(record);
	if (!pathExistsWithoutFollowing(container)) {
		assertWorktreeUnregistered(git, repoRoot, worktree);
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	if (!pathExistsWithoutFollowing(worktree)) {
		assertWorktreeUnregistered(git, repoRoot, worktree);
		removeContainerWithoutWorktree(record);
		retireRecoveryLease(leaseDirectory, record.token);
		return;
	}
	try {
		verifyWorkspaceContainer(record, "present");
	} catch {
		if (pathExistsWithoutFollowing(worktree)) {
			throw new Error("unmarked reserved workspace unexpectedly contains a checkout");
		}
		throw new Error(
			"workspace identity became unavailable during reserved-workspace cleanup; preserve it for explicit inspection",
		);
	}
	git.text(repoRoot, ["worktree", "remove", "--force", worktree]);
	if (pathExistsWithoutFollowing(worktree)) {
		throw new Error("Git reported worktree removal but the checkout still exists");
	}
	assertWorktreeUnregistered(git, repoRoot, worktree);
	verifyWorkspaceContainer(record, "absent");
	retireEmptyWorkspaceContainer(record);
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
			const currentTree = captureWorktreeTree(
				git,
				worktree,
				record.baselineHead,
				leaseDirectory,
				record,
			);
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
		if (record.worktreeRoot) {
			assertWorktreeUnregistered(git, repoRoot, record.worktreeRoot);
		}
		removeContainerWithoutWorktree(record);
		retireRecoveryLease(leaseDirectory, record.token);
		return {
			attemptCommit: commit,
			destination: `${record.attemptRef} (${commit})`,
		};
	}
	throw new Error("worktree is missing and no verified attempt ref proves recoverability");
}

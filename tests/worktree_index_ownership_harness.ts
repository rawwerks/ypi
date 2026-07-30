import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	implementerAttemptRef,
	implementerLeaseRecordDigest,
	type ImplementerLeaseRecord,
} from "../extensions/ypi/internal/implementer-lease.ts";
import {
	initializeImplementerLeaseFile,
	readImplementerLeaseFile,
} from "../extensions/ypi/internal/implementer-lease-file.ts";
import type { RecoveryGit } from "../extensions/ypi/internal/implementer-recovery/git.ts";
import { recoverLeaseWorkspace } from "../extensions/ypi/internal/implementer-recovery/workspace.ts";
import {
	captureWorkspaceContainerIdentity,
	captureWorkspaceDirectoryIdentity,
	captureWorkspaceTreeIdentity,
} from "../extensions/ypi/internal/workspace-container.ts";
import {
	capturePrivateDirectoryIdentity,
	createOwnedPrivateFile,
} from "../extensions/ypi/internal/private-path.ts";

interface Fixture {
	parent: string;
	root: string;
	commonGitDir: string;
	leaseDirectory: string;
	worktree: string;
	record: ImplementerLeaseRecord;
}

const baselineTree = "d".repeat(40);
const capturedTree = "c".repeat(40);
let passed = 0;
let failed = 0;

function recordResult(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function fixture(sequence: number): Fixture {
	const parent = mkdtempSync(path.join(tmpdir(), "ypi_worktree_index."));
	chmodSync(parent, 0o700);
	const root = path.join(parent, "root");
	const commonGitDir = path.join(parent, "common");
	const leaseDirectory = path.join(parent, "lease");
	const token = sequence.toString(16).padStart(32, "0");
	const container = path.join(parent, `ypi_ws_${token}`);
	const worktree = path.join(container, "checkout");
	for (const directory of [root, commonGitDir, leaseDirectory, container, worktree]) {
		mkdirSync(directory, { mode: 0o700 });
		chmodSync(directory, 0o700);
	}
	const leaseFileIdentity = createOwnedPrivateFile(
		path.join(leaseDirectory, "lease.json"),
		"",
	);
	const record: ImplementerLeaseRecord = {
		schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
		token,
		ownerPid: process.pid,
		createdAtEpochSeconds: 1,
		root,
		commonGitDir,
		baselineHead: "b".repeat(40),
		scope: ["slice.txt"],
		state: "worktree-ready",
		worktreeContainer: container,
		worktreeRoot: worktree,
		attemptRef: implementerAttemptRef(token),
		worktreeIndexOwnedByYpi: false,
		leaseResources: {},
		leaseDirectoryIdentity: capturePrivateDirectoryIdentity(leaseDirectory),
		leaseFileIdentity,
		revision: 0,
		recordDigest: "",
	};
	record.workspaceIdentity = captureWorkspaceDirectoryIdentity(record);
	writeFileSync(path.join(container, "owner"), `${token}\n`, { mode: 0o600 });
	chmodSync(path.join(container, "owner"), 0o600);
	record.workspaceIdentity = captureWorkspaceContainerIdentity(record);
	writeFileSync(
		path.join(worktree, ".git"),
		`gitdir: ${path.join(commonGitDir, "worktrees", token)}\n`,
		{ mode: 0o600 },
	);
	record.workspaceIdentity = captureWorkspaceTreeIdentity(record);
	record.recordDigest = implementerLeaseRecordDigest(record);
	initializeImplementerLeaseFile(leaseDirectory, record);
	writeFileSync(path.join(worktree, "slice.txt"), "candidate\n");
	return { parent, root, commonGitDir, leaseDirectory, worktree, record };
}

function baseGit(
	value: Fixture,
	currentIndexTree: string,
	onCall: (args: string[], environment: NodeJS.ProcessEnv) => void,
): RecoveryGit {
	let writeTreeCalls = 0;
	return {
		run(_cwd, args, environment = {}) {
			onCall(args, environment);
			if (args[0] === "for-each-ref") return Buffer.alloc(0);
			if (args[0] === "diff") return Buffer.from("slice.txt\0");
			if (args[0] === "ls-files") return Buffer.alloc(0);
			if (args[0] === "rev-parse" && args[1]?.endsWith("^{tree}")) {
				return Buffer.from(`${baselineTree}\n`);
			}
			if (args[0] === "read-tree" || args[0] === "add") return Buffer.alloc(0);
			if (args[0] === "write-tree") {
				writeTreeCalls++;
				return Buffer.from(
					`${writeTreeCalls === 1 ? currentIndexTree : capturedTree}\n`,
				);
			}
			if (args[0] === "commit-tree") {
				throw new Error("synthetic stop after worktree-index capture");
			}
			throw new Error(`unexpected controlled Git call: ${args.join(" ")}`);
		},
		text(cwd, args, environment) {
			return this.run(cwd, args, environment).toString("utf8").trim();
		},
		optionalText(_cwd, args) {
			if (args[0] === "rev-parse" && args.at(-1) === "--git-common-dir") {
				return value.commonGitDir;
			}
			return undefined;
		},
	};
}

console.log("\n=== Worktree index ownership harness ===");

{
	const value = fixture(1);
	const oldCleanupPath = path.join(value.leaseDirectory, "cleanup-index");
	writeFileSync(oldCleanupPath, "SUCCESSOR ONLY COPY\n", { mode: 0o600 });
	let externalIndexUses = 0;
	let failure = "";
	const git = baseGit(value, baselineTree, (_args, environment) => {
		if (environment.GIT_INDEX_FILE) externalIndexUses++;
	});
	try {
		recoverLeaseWorkspace(
			git,
			value.root,
			value.commonGitDir,
			value.leaseDirectory,
			value.record,
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const persisted = readImplementerLeaseFile(
		value.leaseDirectory,
		value.record.token,
		value.commonGitDir,
	);
	recordResult(
		failure.includes("synthetic stop after worktree-index capture")
			&& externalIndexUses === 0
			&& persisted.worktreeIndexOwnedByYpi === true
			&& readFileSync(oldCleanupPath, "utf8") === "SUCCESSOR ONLY COPY\n",
		"recovery durably takes over the isolated index without touching old index pathnames",
		failure,
	);
	rmSync(value.parent, { recursive: true, force: true });
}

{
	const value = fixture(2);
	let mutatingCalls = 0;
	let failure = "";
	const git = baseGit(value, "e".repeat(40), (args) => {
		if (args[0] === "read-tree" || args[0] === "add") mutatingCalls++;
	});
	try {
		recoverLeaseWorkspace(
			git,
			value.root,
			value.commonGitDir,
			value.leaseDirectory,
			value.record,
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const persisted = readImplementerLeaseFile(
		value.leaseDirectory,
		value.record.token,
		value.commonGitDir,
	);
	recordResult(
		failure.includes("differs from the baseline")
			&& mutatingCalls === 0
			&& persisted.worktreeIndexOwnedByYpi === false
			&& existsSync(path.join(value.worktree, "slice.txt")),
		"recovery preserves an unowned divergent worktree index before mutation",
		failure,
	);
	rmSync(value.parent, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

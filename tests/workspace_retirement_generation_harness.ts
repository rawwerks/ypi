import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	implementerAttemptRef,
	type ImplementerLeaseRecord,
} from "../extensions/ypi/internal/implementer-lease.ts";
import {
	captureWorkspaceContainerIdentity,
	captureWorkspaceDirectoryIdentity,
	captureWorkspaceTreeIdentity,
	retireEmptyWorkspaceContainer,
	verifyWorkspaceContainer,
} from "../extensions/ypi/internal/workspace-container.ts";
import { capturePrivateDirectoryIdentity } from "../extensions/ypi/internal/private-path.ts";

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

const root = mkdtempSync(path.join(tmpdir(), "ypi_workspace_retirement."));
chmodSync(root, 0o700);
let sequence = 0;

function fixture(withOwner: boolean): ImplementerLeaseRecord {
	sequence++;
	const token = sequence.toString(16).padStart(32, "0");
	const container = path.join(root, `ypi_ws_${token}`);
	mkdirSync(container, { mode: 0o700 });
	chmodSync(container, 0o700);
	const value: ImplementerLeaseRecord = {
		schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
		token,
		ownerPid: process.pid,
		createdAtEpochSeconds: 1,
		root,
		commonGitDir: root,
		baselineHead: "b".repeat(40),
		scope: ["src"],
		state: withOwner ? "worktree-removed" : "reserved",
			worktreeContainer: container,
			worktreeRoot: path.join(container, "checkout"),
			attemptRef: implementerAttemptRef(token),
			worktreeIndexOwnedByYpi: false,
			leaseResources: {},
			leaseDirectoryIdentity: capturePrivateDirectoryIdentity(root),
	};
	value.workspaceIdentity = captureWorkspaceDirectoryIdentity(value);
	if (withOwner) {
		const owner = path.join(container, "owner");
		writeFileSync(owner, `${token}\n`, { mode: 0o600 });
		chmodSync(owner, 0o600);
		value.workspaceIdentity = captureWorkspaceContainerIdentity(value);
	}
	return value;
}

console.log("\n=== Workspace retirement generation harness ===");

{
	const value = fixture(true);
	const ownerPath = path.join(value.worktreeContainer!, "owner");
	const movedOwner = path.join(root, "postproof-owned-owner");
	let failure = "";
	try {
		retireEmptyWorkspaceContainer(value, {
			afterFinalVerification() {
				renameSync(ownerPath, movedOwner);
				writeFileSync(ownerPath, "SUCCESSOR ONLY COPY\n", { mode: 0o600 });
				chmodSync(ownerPath, 0o600);
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const quarantined = readdirSync(value.worktreeContainer!)
		.filter((entry) => entry.startsWith(".owner-retired-"));
	record(
		failure.includes("changed during retirement")
			&& quarantined.length === 1
			&& readFileSync(
				path.join(value.worktreeContainer!, quarantined[0]),
				"utf8",
			) === "SUCCESSOR ONLY COPY\n"
			&& existsSync(movedOwner),
		"post-proof marker replacement is quarantined and reported",
		failure,
	);
}

{
	const value = fixture(true);
	let failure = "";
	try {
		retireEmptyWorkspaceContainer(value, {
			afterQuarantine() {
				throw new Error("synthetic crash after quarantine");
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const interrupted = readdirSync(value.worktreeContainer!);
	retireEmptyWorkspaceContainer(value);
	record(
		failure.includes("synthetic crash")
			&& interrupted.length === 1
			&& interrupted[0].startsWith(".owner-retired-")
			&& !existsSync(value.worktreeContainer!),
		"retirement resumes after quarantine",
		failure,
	);
}

{
	const value = fixture(true);
	let failure = "";
	try {
		retireEmptyWorkspaceContainer(value, {
			afterQuarantineUnlink() {
				throw new Error("synthetic crash after quarantine unlink");
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const interrupted = readdirSync(value.worktreeContainer!);
	retireEmptyWorkspaceContainer(value);
	record(
		failure.includes("synthetic crash")
			&& interrupted.length === 0
			&& !existsSync(value.worktreeContainer!),
		"retirement resumes after quarantine unlink",
		failure,
	);
}

{
	const value = fixture(true);
	retireEmptyWorkspaceContainer(value);
	record(
		!existsSync(value.worktreeContainer!),
		"normal exact marker retirement completes",
	);
}

{
	const value = fixture(false);
	retireEmptyWorkspaceContainer(value);
	record(
		!existsSync(value.worktreeContainer!),
		"exact empty partial container retires",
	);
}

{
	const value = fixture(false);
	const movedOwned = path.join(root, "partial-owned-container");
	renameSync(value.worktreeContainer!, movedOwned);
	mkdirSync(value.worktreeContainer!, { mode: 0o700 });
	chmodSync(value.worktreeContainer!, 0o700);
	const canary = path.join(value.worktreeContainer!, "only-copy");
	writeFileSync(canary, "PRESERVE PARTIAL REPLACEMENT\n", { mode: 0o600 });
	let failure = "";
	try {
		retireEmptyWorkspaceContainer(value);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("container identity changed")
			&& existsSync(movedOwned)
			&& readFileSync(canary, "utf8") === "PRESERVE PARTIAL REPLACEMENT\n",
		"partial container replacement preserves both generations",
		failure,
	);
}

{
	const value = fixture(false);
	const owner = path.join(value.worktreeContainer!, "owner");
	writeFileSync(owner, `${value.token}\n`, { mode: 0o600 });
	chmodSync(owner, 0o600);
	let failure = "";
	try {
		retireEmptyWorkspaceContainer(value);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("marker identity is unavailable")
			&& existsSync(owner),
		"unrecorded marker generation is preserved",
		failure,
	);
}

{
	const value = fixture(true);
	const worktree = value.worktreeRoot!;
	mkdirSync(worktree, { mode: 0o700 });
	writeFileSync(
		path.join(worktree, ".git"),
		`gitdir: ${path.join(root, "worktrees", value.token)}\n`,
		{ mode: 0o600 },
	);
	value.workspaceIdentity = captureWorkspaceTreeIdentity(value);
	rmSync(worktree, { recursive: true });
	mkdirSync(worktree, { mode: 0o700 });
	const onlyCopy = path.join(worktree, "only-copy");
	writeFileSync(onlyCopy, "PRESERVE CHECKOUT REPLACEMENT\n", { mode: 0o600 });
	writeFileSync(
		path.join(worktree, ".git"),
		"gitdir: synthetic replacement\n",
		{ mode: 0o600 },
	);
	const replacement = lstatSync(worktree, { bigint: true });
	const replacementGitFile = lstatSync(path.join(worktree, ".git"), { bigint: true });
	value.workspaceIdentity.worktreeDevice = replacement.dev.toString();
	value.workspaceIdentity.worktreeInode = replacement.ino.toString();
	value.workspaceIdentity.worktreeGitFileDevice = replacementGitFile.dev.toString();
	value.workspaceIdentity.worktreeGitFileInode = replacementGitFile.ino.toString();
	let failure = "";
	try {
		verifyWorkspaceContainer(value, "present");
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("checkout Git indirection identity changed")
			&& readFileSync(onlyCopy, "utf8") === "PRESERVE CHECKOUT REPLACEMENT\n",
		"Git indirection digest catches checkout replacement despite simulated inode reuse",
		failure,
	);
}

{
	const value = fixture(true);
	const worktree = value.worktreeRoot!;
	mkdirSync(worktree, { mode: 0o700 });
	const gitFile = path.join(worktree, ".git");
	writeFileSync(
		gitFile,
		`gitdir: ${path.join(root, "worktrees", value.token)}\n`,
		{ mode: 0o600 },
	);
	value.workspaceIdentity = captureWorkspaceTreeIdentity(value);
	delete value.workspaceIdentity.worktreeGitFileDevice;
	delete value.workspaceIdentity.worktreeGitFileInode;
	delete value.workspaceIdentity.worktreeGitFileDigest;
	let failure = "";
	try {
		verifyWorkspaceContainer(value, "present");
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("checkout Git indirection identity is unavailable")
			&& existsSync(gitFile),
		"legacy lease without Git indirection proof fails closed before deletion",
		failure,
	);
}

rmSync(root, { recursive: true, force: true });
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import {
	existsSync,
	mkdtempSync,
	rmSync,
	rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicCreateFile } from "../extensions/ypi/internal/atomic-file.ts";
import {
	IMPLEMENTER_LEASE_SCHEMA_VERSION,
	implementerAttemptRef,
	implementerLeaseRecordDigest,
	type ImplementerLeaseRecord,
} from "../extensions/ypi/internal/implementer-lease.ts";
import {
	initializeImplementerLeaseFile,
} from "../extensions/ypi/internal/implementer-lease-file.ts";
import type { RecoveryGit } from "../extensions/ypi/internal/implementer-recovery/git.ts";
import { recoverImplementerWorkspaces } from "../extensions/ypi/internal/implementer-recovery/service.ts";
import { recoverLeaseWorkspace } from "../extensions/ypi/internal/implementer-recovery/workspace.ts";
import { implementerRegistryPaths } from "../extensions/ypi/internal/implementer-registry-layout.ts";
import {
	capturePrivateDirectoryIdentity,
	createOwnedPrivateFile,
	createPrivateDirectory,
	createPrivateTempDirectory,
} from "../extensions/ypi/internal/private-path.ts";
import {
	captureWorkspaceContainerIdentity,
	captureWorkspaceTreeIdentity,
} from "../extensions/ypi/internal/workspace-container.ts";

let passed = 0;
let failed = 0;
function record(ok: boolean, label: string, details = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${details ? `: ${details}` : ""}`);
	}
}

function worktreeInventory(...worktrees: string[]): Buffer {
	return Buffer.from(
		worktrees
			.map((worktree) => `worktree ${worktree}\0HEAD ${"1".repeat(40)}\0detached\0\0`)
			.join(""),
	);
}

function fixture(token: string): {
	parent: string;
	root: string;
	common: string;
	leaseDirectory: string;
	record: ImplementerLeaseRecord;
	container: string;
	worktree: string;
} {
	const parent = createPrivateTempDirectory(path.join(tmpdir(), "ypi_exact_recovery."));
	const root = path.join(parent, "repo");
	const common = path.join(parent, "common");
	createPrivateDirectory(root);
	createPrivateDirectory(common);
	const paths = implementerRegistryPaths(common);
	createPrivateDirectory(paths.root);
	createPrivateDirectory(paths.leases);
	const leaseDirectory = path.join(paths.leases, token);
	createPrivateDirectory(leaseDirectory);
	const leaseFileIdentity = createOwnedPrivateFile(
		path.join(leaseDirectory, "lease.json"),
		"",
	);
	const container = path.join(parent, `ypi_ws_${token}`);
	const worktree = path.join(container, "checkout");
	const record: ImplementerLeaseRecord = {
		schemaVersion: IMPLEMENTER_LEASE_SCHEMA_VERSION,
		token,
		ownerPid: process.pid,
		createdAtEpochSeconds: 1,
		root,
		commonGitDir: common,
		baselineHead: "1".repeat(40),
		scope: ["fixture.txt"],
		state: "reserved",
		attemptRef: implementerAttemptRef(token),
		worktreeContainer: container,
		worktreeRoot: worktree,
		worktreeIndexOwnedByYpi: false,
		leaseResources: {},
		leaseDirectoryIdentity: capturePrivateDirectoryIdentity(leaseDirectory),
		leaseFileIdentity,
		revision: 0,
		recordDigest: "",
	};
	return { parent, root, common, leaseDirectory, record, container, worktree };
}

function persistLease(
	state: ReturnType<typeof fixture>,
): void {
	state.record.recordDigest = implementerLeaseRecordDigest(state.record);
	initializeImplementerLeaseFile(state.leaseDirectory, state.record);
}

console.log("\n=== Exact worktree recovery harness ===");

{
	const parent = createPrivateTempDirectory(path.join(tmpdir(), "ypi_no_global_prune."));
	const root = path.join(parent, "repo");
	const common = path.join(parent, "common");
	createPrivateDirectory(root);
	createPrivateDirectory(common);
	createPrivateDirectory(implementerRegistryPaths(common).root);
	const calls: string[] = [];
	const git: RecoveryGit = {
		run() { return Buffer.alloc(0); },
		text(_cwd, args) {
			calls.push(args.join(" "));
			return "";
		},
		optionalText(_cwd, args) {
			if (args.includes("--show-toplevel")) return root;
			if (args.includes("--git-common-dir")) return common;
			return undefined;
		},
	};
	const report = recoverImplementerWorkspaces(
		{ repo: root, ageMinutes: 0, force: true },
		{ git, nowEpochSeconds: () => 100, processAlive: () => false },
	);
	record(
		report.exitCode === 0 && !calls.some((call) => call.startsWith("worktree prune")),
		"recovery never invokes repository-wide worktree prune",
		calls.join("; "),
	);
	rmSync(parent, { recursive: true, force: true });
}

{
	const state = fixture("c".repeat(32));
	createPrivateDirectory(state.container);
	atomicCreateFile(path.join(state.container, "owner"), `${state.record.token}\n`);
	createPrivateDirectory(state.worktree);
	state.record.workspaceIdentity = captureWorkspaceContainerIdentity(state.record);
	state.record.workspaceIdentity = captureWorkspaceTreeIdentity(state.record);
	persistLease(state);
	const calls: string[] = [];
	const git: RecoveryGit = {
		run() { throw new Error("worktree inventory must not run after failed removal"); },
		text(_cwd, args) {
			calls.push(args.join(" "));
			if (args[0] === "for-each-ref") return "";
			if (args[0] === "worktree" && args[1] === "remove") {
				throw new Error("simulated exact worktree removal failure");
			}
			throw new Error(`unexpected Git call: ${args.join(" ")}`);
		},
		optionalText() { return undefined; },
	};
	let error = "";
	try {
		recoverLeaseWorkspace(
			git,
			state.root,
			state.common,
			state.leaseDirectory,
			state.record,
		);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	record(
		error.includes("simulated exact worktree removal failure")
			&& existsSync(state.worktree)
			&& existsSync(state.leaseDirectory)
			&& !calls.some((call) => call.startsWith("worktree prune")),
		"failed exact removal preserves the owned checkout and lease",
		error,
	);
	rmSync(state.parent, { recursive: true, force: true });
}

{
	const state = fixture("d".repeat(32));
	createPrivateDirectory(state.container);
	atomicCreateFile(path.join(state.container, "owner"), `${state.record.token}\n`);
	state.record.workspaceIdentity = captureWorkspaceContainerIdentity(state.record);
	persistLease(state);
	const git: RecoveryGit = {
		run(_cwd, args) {
			if (args.join(" ") === "worktree list --porcelain -z --expire=never") {
				return worktreeInventory(state.worktree);
			}
			throw new Error(`unexpected Git run: ${args.join(" ")}`);
		},
		text(_cwd, args) {
			if (args[0] === "for-each-ref") return "";
			throw new Error(`unexpected Git text: ${args.join(" ")}`);
		},
		optionalText() { return undefined; },
	};
	let error = "";
	try {
		recoverLeaseWorkspace(
			git,
			state.root,
			state.common,
			state.leaseDirectory,
			state.record,
		);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	record(
		error.includes("recorded worktree remains registered")
			&& existsSync(state.container)
			&& existsSync(state.leaseDirectory),
		"missing checkout is preserved while its exact registration survives",
		error,
	);
	rmSync(state.parent, { recursive: true, force: true });
}

{
	const state = fixture("e".repeat(32));
	const unrelated = path.join(state.parent, "unrelated");
	createPrivateDirectory(state.container);
	atomicCreateFile(path.join(state.container, "owner"), `${state.record.token}\n`);
	createPrivateDirectory(state.worktree);
	createPrivateDirectory(unrelated);
	state.record.workspaceIdentity = captureWorkspaceContainerIdentity(state.record);
	state.record.workspaceIdentity = captureWorkspaceTreeIdentity(state.record);
	persistLease(state);
	const calls: string[] = [];
	const git: RecoveryGit = {
		run(_cwd, args) {
			if (args.join(" ") === "worktree list --porcelain -z --expire=never") {
				return worktreeInventory(unrelated);
			}
			throw new Error(`unexpected Git run: ${args.join(" ")}`);
		},
		text(_cwd, args) {
			calls.push(args.join(" "));
			if (args[0] === "for-each-ref") return "";
			if (args[0] === "worktree" && args[1] === "remove") {
				rmdirSync(state.worktree);
				return "";
			}
			throw new Error(`unexpected Git text: ${args.join(" ")}`);
		},
		optionalText() { return undefined; },
	};
	const result = recoverLeaseWorkspace(
		git,
		state.root,
		state.common,
		state.leaseDirectory,
		state.record,
	);
	record(
		result.destination === "reserved workspace before child admission"
			&& !existsSync(state.container)
			&& !existsSync(state.leaseDirectory)
			&& existsSync(unrelated)
			&& calls.filter((call) => call.startsWith("worktree remove")).length === 1
			&& !calls.some((call) => call.startsWith("worktree prune")),
		"successful recovery retires only the exact registered checkout",
		JSON.stringify({ result, calls }),
	);
	rmSync(state.parent, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

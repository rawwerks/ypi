import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../extensions/ypi/internal/atomic-file.ts";
import {
	implementerRegistryHasState,
	implementerRegistryPaths,
} from "../extensions/ypi/internal/implementer-registry-layout.ts";
import {
	parseImplementerLeaseRecord,
	type ImplementerLeaseRecord,
} from "../extensions/ypi/internal/implementer-lease.ts";
import { parseImplementerRecoveryArguments } from "../extensions/ypi/internal/implementer-recovery/cli.ts";
import { createRecoveryGit } from "../extensions/ypi/internal/implementer-recovery/git.ts";
import { leaseNeedsRecovery } from "../extensions/ypi/internal/implementer-recovery/service.ts";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const recoveryScript = path.join(projectRoot, "scripts", "cleanup-implementer-workspaces.ts");
const cleanupScript = path.join(projectRoot, "rlm_cleanup");
let pass = 0;
let fail = 0;

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) environment[key] = value;
	}
	return {
		...environment,
		GIT_AUTHOR_NAME: "ypi-recovery-test",
		GIT_AUTHOR_EMAIL: "ypi-recovery-test@example.invalid",
		GIT_COMMITTER_NAME: "ypi-recovery-test",
		GIT_COMMITTER_EMAIL: "ypi-recovery-test@example.invalid",
		...extra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: cleanEnvironment(),
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

function fixture(): { parent: string; root: string } {
	const parent = mkdtempSync(path.join(tmpdir(), "ypi_recovery_harness."));
	const root = path.join(parent, "repo");
	mkdirSync(root);
	git(root, "init", "-q");
	writeFileSync(path.join(root, "slice.txt"), "base\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return { parent, root };
}

function record(ok: boolean, label: string, detail = "") {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function expectThrow(label: string, expected: string, action: () => unknown): void {
	try {
		action();
		record(false, label, "did not throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(message.includes(expected), label, message);
	}
}

console.log("\n=== Implementer recovery module and CLI harness ===");

{
	const layoutOwner = path.join(
		projectRoot,
		"extensions",
		"ypi",
		"internal",
		"implementer-registry-layout.ts",
	);
	const consumers = [
		path.join(projectRoot, "extensions", "ypi", "internal", "workspace-registry.ts"),
		path.join(projectRoot, "extensions", "ypi", "internal", "implementer-recovery", "registry.ts"),
		cleanupScript,
	];
	record(
		existsSync(layoutOwner)
			&& consumers.every((candidate) => !readFileSync(candidate, "utf8").includes("ypi-implementers")),
		"one TypeScript module owns every implementer registry path",
	);
}

{
	const common = mkdtempSync(path.join(tmpdir(), "ypi_registry_layout."));
	const paths = implementerRegistryPaths(common);
	mkdirSync(paths.root);
	mkdirSync(paths.leases);
	mkdirSync(paths.staging);
	mkdirSync(paths.retired);
	record(
		!implementerRegistryHasState(paths),
		"empty canonical registry directories do not block attempt-ref expiry",
	);
	const staged = path.join(paths.staging, "interrupted");
	mkdirSync(staged);
	record(
		implementerRegistryHasState(paths),
		"staged state blocks attempt-ref expiry",
	);
	rmSync(staged, { recursive: true });
	const retired = path.join(paths.retired, "interrupted");
	mkdirSync(retired);
	record(
		implementerRegistryHasState(paths),
		"retired state blocks attempt-ref expiry",
	);
	rmSync(retired, { recursive: true });
	const unknown = path.join(paths.root, "unknown");
	writeFileSync(unknown, "preserve\n");
	record(
		implementerRegistryHasState(paths),
		"unknown registry state blocks attempt-ref expiry",
	);
	rmSync(common, { recursive: true, force: true });
}

{
	const root = mkdtempSync(path.join(tmpdir(), "ypi_recovery_git_output."));
	const bin = path.join(root, "bin");
	mkdirSync(bin);
	const fakeGit = path.join(bin, "git");
	writeFileSync(
		fakeGit,
		`#!${process.execPath}\nprocess.stdout.write("x".repeat(2 * 1024 * 1024));\n`,
	);
	chmodSync(fakeGit, 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${originalPath || ""}`;
	try {
		try {
			const output = createRecoveryGit(5_000).run(root, ["large-output"]);
			record(
				output.length === 2 * 1024 * 1024,
				"recovery Git captures inventories above Node's default one-MiB buffer",
				`captured ${output.length} bytes`,
			);
		} catch (error) {
			record(
				false,
				"recovery Git captures inventories above Node's default one-MiB buffer",
				error instanceof Error ? error.message : String(error),
			);
		}
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(root, { recursive: true, force: true });
	}
}

{
	const root = mkdtempSync(path.join(tmpdir(), "ypi_atomic_file."));
	const target = path.join(root, "state");
	atomicWriteFile(target, "first\n");
	atomicWriteFile(target, "second\n");
	record(
		readFileSync(target, "utf8") === "second\n"
			&& (statSync(target).mode & 0o777) === 0o600
			&& readdirSync(root).join("\0") === "state",
		"durable atomic writer replaces state without exposing temp artifacts",
	);
	rmSync(root, { recursive: true, force: true });
}

const token = "a".repeat(32);
const commonGitDir = "/tmp/ypi-common";
const validRecord: ImplementerLeaseRecord = {
	schemaVersion: 1,
	token,
	ownerPid: 42,
	createdAtEpochSeconds: 10,
	root: "/tmp/repo",
	commonGitDir,
	baselineHead: "b".repeat(40),
	scope: ["src"],
	state: "worktree-ready",
	attemptRef: `refs/ypi/attempt-${token}`,
};
record(
	parseImplementerLeaseRecord(validRecord, token, commonGitDir).scope[0] === "src",
	"runtime and recovery share one accepted lease schema",
);
expectThrow(
	"shared lease schema rejects non-canonical scope",
	"non-canonical scope",
	() => parseImplementerLeaseRecord(
		{ ...validRecord, scope: ["src/file.ts", "src"] },
		token,
		commonGitDir,
	),
);

{
	const parsed = parseImplementerRecoveryArguments([
		"--repo", "/tmp/repo",
		"--age", "7",
		"--force",
	]);
	record(
		parsed.repo === "/tmp/repo" && parsed.ageMinutes === 7 && parsed.force,
		"recovery CLI parser returns a bounded typed request",
	);
	expectThrow(
		"recovery CLI parser rejects negative age",
		"non-negative",
		() => parseImplementerRecoveryArguments(["--repo", "/tmp/repo", "--age", "-1"]),
	);
	expectThrow(
		"recovery CLI parser rejects fractional age",
		"decimal integer",
		() => parseImplementerRecoveryArguments(["--repo", "/tmp/repo", "--age", "1.5"]),
	);
}

{
	const lease = { directory: "/tmp/lease", record: validRecord };
	record(
		leaseNeedsRecovery(lease, 10, 20, () => false),
		"dead eligible lease is recoverable",
	);
	record(
		!leaseNeedsRecovery(lease, 10, 20, (pid) => pid === validRecord.ownerPid),
		"live owner keeps its lease",
	);
	record(
		!leaseNeedsRecovery(
			{
				...lease,
				record: { ...validRecord, childLaunchStartedAtEpochSeconds: 18 },
			},
			10,
			20,
			() => false,
		),
		"fresh launch-registration window is preserved",
	);
}

{
	const { parent, root } = fixture();
	try {
		const lease = acquireWorkspace({
			cwd: root,
			childDepth: 1,
			mode: "implement",
			scope: ["slice.txt"],
		});
		writeFileSync(path.join(lease.cwd, "slice.txt"), "typescript recovery\n");
		const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const leasesRoot = path.join(common, "ypi-implementers", "leases");
		const leaseDirectory = path.join(leasesRoot, readdirSync(leasesRoot)[0]);
		const recordPath = path.join(leaseDirectory, "lease.json");
		const recordValue = JSON.parse(readFileSync(recordPath, "utf8"));
		recordValue.ownerPid = 2_000_000_000;
		writeFileSync(recordPath, `${JSON.stringify(recordValue, null, 2)}\n`, { mode: 0o600 });

		const result = spawnSync("node", [
			recoveryScript,
			"--repo", root,
			"--age", "0",
			"--force",
		], {
			encoding: "utf8",
			env: cleanEnvironment(),
		});
		const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/ypi/attempt-*")
			.split("\n")
			.filter(Boolean);
		record(
			result.status === 0
				&& refs.length === 1
				&& git(root, "show", `${refs[0]}:slice.txt`) === "typescript recovery"
				&& !existsSync(lease.cwd)
				&& git(root, "status", "--porcelain=v2", "--untracked-files=all") === "",
			"TypeScript recovery CLI salvages and removes a dead implementer directly",
			String(result.stderr || result.stdout || ""),
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

{
	const { parent, root } = fixture();
	try {
		const lease = acquireWorkspace({
			cwd: root,
			childDepth: 1,
			mode: "implement",
			scope: ["slice.txt"],
		});
		writeFileSync(path.join(lease.cwd, "slice.txt"), "must survive git failure\n");
		const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const leaseDirectory = path.join(
			common,
			"ypi-implementers",
			"leases",
			readdirSync(path.join(common, "ypi-implementers", "leases"))[0],
		);
		const recordPath = path.join(leaseDirectory, "lease.json");
		const recordValue = JSON.parse(readFileSync(recordPath, "utf8"));
		recordValue.ownerPid = 2_000_000_000;
		writeFileSync(recordPath, `${JSON.stringify(recordValue, null, 2)}\n`, { mode: 0o600 });

		const resolvedGit = spawnSync("/bin/sh", ["-c", "command -v git"], {
			encoding: "utf8",
			env: cleanEnvironment(),
		});
		if (resolvedGit.status !== 0 || !String(resolvedGit.stdout).trim()) {
			throw new Error(`cannot resolve git for recovery test: ${resolvedGit.stderr}`);
		}
		const bin = path.join(parent, "bin");
		const failingGit = path.join(bin, "git");
		mkdirSync(bin);
		writeFileSync(
			failingGit,
			"#!/bin/sh\n"
			+ "for argument in \"$@\"; do\n"
			+ "  if [ \"$argument\" = for-each-ref ]; then exit 55; fi\n"
			+ "done\n"
			+ "exec \"$YPI_REAL_GIT\" \"$@\"\n",
		);
		chmodSync(failingGit, 0o755);

		const result = spawnSync("node", [
			recoveryScript,
			"--repo", root,
			"--age", "0",
			"--force",
		], {
			encoding: "utf8",
			env: cleanEnvironment({
				PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
				YPI_REAL_GIT: String(resolvedGit.stdout).trim(),
			}),
		});
		record(
			result.status === 1
				&& String(result.stderr).includes("git for-each-ref")
				&& existsSync(lease.cwd)
				&& readFileSync(path.join(lease.cwd, "slice.txt"), "utf8")
					=== "must survive git failure\n",
			"recovery preserves a workspace when attempt-ref inspection fails",
			String(result.stderr || result.stdout || ""),
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

{
	const { parent, root } = fixture();
	try {
		const lease = acquireWorkspace({
			cwd: root,
			childDepth: 1,
			mode: "implement",
			scope: ["slice.txt"],
		});
		writeFileSync(path.join(lease.cwd, "slice.txt"), "must remain\n");
		const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const leaseDirectory = path.join(
			common,
			"ypi-implementers",
			"leases",
			readdirSync(path.join(common, "ypi-implementers", "leases"))[0],
		);
		const recordPath = path.join(leaseDirectory, "lease.json");
		const recordValue = JSON.parse(readFileSync(recordPath, "utf8"));
		const tree = git(root, "rev-parse", "HEAD^{tree}");
		const rogue = git(root, "commit-tree", tree, "-m", "wrong ancestry");
		git(root, "update-ref", recordValue.attemptRef, rogue);
		recordValue.ownerPid = 2_000_000_000;
		recordValue.attemptCommit = rogue;
		recordValue.state = "ref-verified";
		writeFileSync(recordPath, `${JSON.stringify(recordValue, null, 2)}\n`, { mode: 0o600 });

		const result = spawnSync("node", [
			recoveryScript,
			"--repo", root,
			"--age", "0",
			"--force",
		], {
			encoding: "utf8",
			env: cleanEnvironment(),
		});
		record(
			result.status === 1
				&& String(result.stderr).includes("single-parent child")
				&& existsSync(lease.cwd)
				&& readFileSync(path.join(lease.cwd, "slice.txt"), "utf8") === "must remain\n",
			"recovery preserves a workspace when an existing attempt ref has wrong ancestry",
			String(result.stderr || result.stdout || ""),
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

{
	const { parent, root } = fixture();
	try {
		const baseline = git(root, "rev-parse", "HEAD");
		git(root, "update-index", "--add", "--cacheinfo", `160000,${baseline},nested`);
		git(root, "commit", "-qm", "add gitlink");
		mkdirSync(path.join(root, "nested"));
		const lease = acquireWorkspace({
			cwd: root,
			childDepth: 1,
			mode: "implement",
			scope: ["nested", "slice.txt"],
		});
		writeFileSync(path.join(lease.cwd, "slice.txt"), "must remain\n");
		const nested = path.join(lease.cwd, "nested");
		rmSync(nested, { recursive: true, force: true });
		const external = path.join(parent, "external");
		mkdirSync(external);
		writeFileSync(path.join(external, "keep"), "keep\n");
		symlinkSync(external, nested, "dir");
		const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
		const leaseDirectory = path.join(
			common,
			"ypi-implementers",
			"leases",
			readdirSync(path.join(common, "ypi-implementers", "leases"))[0],
		);
		const recordPath = path.join(leaseDirectory, "lease.json");
		const recordValue = JSON.parse(readFileSync(recordPath, "utf8"));
		recordValue.ownerPid = 2_000_000_000;
		writeFileSync(recordPath, `${JSON.stringify(recordValue, null, 2)}\n`, { mode: 0o600 });

		const result = spawnSync("node", [
			recoveryScript,
			"--repo", root,
			"--age", "0",
			"--force",
		], {
			encoding: "utf8",
			env: cleanEnvironment(),
		});
		record(
			result.status === 1
				&& String(result.stderr).includes("uninitialized submodule")
				&& existsSync(lease.cwd)
				&& readFileSync(path.join(external, "keep"), "utf8") === "keep\n",
			"recovery rejects a symlink at a gitlink boundary and preserves its target",
			String(result.stderr || result.stdout || ""),
		);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

{
	const { parent, root } = fixture();
	const bin = path.join(parent, "bin");
	const marker = path.join(parent, "python-called");
	mkdirSync(bin);
	const fakePython = path.join(bin, "python3");
	writeFileSync(fakePython, "#!/bin/sh\nprintf called > \"$YPI_PYTHON_MARKER\"\nexit 99\n");
	chmodSync(fakePython, 0o755);
	const result = spawnSync(cleanupScript, ["--repo", root, "--age", "0"], {
		encoding: "utf8",
		env: cleanEnvironment({
			PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
			TMPDIR: parent,
			YPI_NODE_BIN: "node",
			YPI_PYTHON_MARKER: marker,
		}),
	});
	record(
		result.status === 0 && !existsSync(marker),
		"user-facing rlm_cleanup recovery path does not invoke Python",
		String(result.stderr || result.stdout || ""),
	);
	rmSync(parent, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

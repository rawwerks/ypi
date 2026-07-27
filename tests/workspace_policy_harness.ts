import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireWorkspace, WorkspaceFinalizationError } from "../extensions/ypi/internal/workspace-policy.ts";

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}
function git(cwd: string, ...args: string[]) {
	// Drop inherited GIT_* (a git hook exports GIT_DIR/GIT_WORK_TREE, which
	// would point fixture commands at the parent repository), then set the
	// deterministic identity this harness needs.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.GIT_AUTHOR_NAME = "ypi-test";
	env.GIT_AUTHOR_EMAIL = "ypi@example.invalid";
	env.GIT_COMMITTER_NAME = "ypi-test";
	env.GIT_COMMITTER_EMAIL = "ypi@example.invalid";
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}
function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "ypi_workspace_policy."));
	git(root, "init", "-q");
	writeFileSync(path.join(root, "tracked.txt"), "base\n");
	git(root, "add", "tracked.txt");
	git(root, "commit", "-qm", "base");
	return root;
}
function expectThrow(label: string, expected: string, fn: () => unknown) {
	try { fn(); record(false, label, "expected throw"); }
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(message.includes(expected), label, message);
	}
}

console.log("\n=== Workspace policy harness ===");
const reviewRoot = fixture();
const review = acquireWorkspace({ cwd: reviewRoot, childDepth: 1, mode: "review" });
record(review.readOnly && review.mode === "read-only" && review.cwd === reviewRoot, "review stays read-only");
record(review.finalize().changedPaths.length === 0, "review emits an empty complete change report");
review.cleanup();

const cleanRoot = fixture();
const baselineHead = git(cleanRoot, "rev-parse", "HEAD");
const writer = acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement" });
record(!writer.readOnly && writer.mode === "git-snapshot" && writer.quiesceProcessGroup, "clean Git implementer acquires one snapshot writer lease");
const lockPath = git(cleanRoot, "rev-parse", "--path-format=absolute", "--git-path", "ypi-implementer.lock");
record(existsSync(lockPath), "writer lease is materialized inside existing Git metadata");
expectThrow("second implementer is rejected while lease is held", "Another ypi implementer", () => acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement" }));
writeFileSync(path.join(cleanRoot, "tracked.txt"), "changed\n");
writeFileSync(path.join(cleanRoot, "space name.txt"), "new\n");
const report = writer.finalize();
record(
	report.reportComplete
		&& report.treeRestored === true
		&& report.changedPaths.includes("tracked.txt")
		&& report.changedPaths.includes("space name.txt")
		&& Boolean(report.attemptRef)
		&& Boolean(report.attemptCommit),
	"implementer reports a verified salvage ref and changed paths",
	JSON.stringify(report),
);
writer.cleanup();
record(!existsSync(lockPath), "owned writer lease is released after final report");
record(
	readFileSync(path.join(cleanRoot, "tracked.txt"), "utf8") === "base\n"
		&& !existsSync(path.join(cleanRoot, "space name.txt"))
		&& git(cleanRoot, "status", "--porcelain=v2", "--untracked-files=all") === "",
	"snapshot finalization restores a clean baseline checkout",
);
record(git(cleanRoot, "rev-parse", report.attemptRef!) === report.attemptCommit, "salvage ref resolves to the reported commit");
record(
	git(cleanRoot, "show", `${report.attemptRef}:tracked.txt`) === "changed"
		&& git(cleanRoot, "show", `${report.attemptRef}:space name.txt`) === "new",
	"salvage ref contains the exact tracked and untracked edits",
);
git(cleanRoot, "cherry-pick", "-n", report.attemptCommit!);
record(
	readFileSync(path.join(cleanRoot, "tracked.txt"), "utf8") === "changed\n"
		&& readFileSync(path.join(cleanRoot, "space name.txt"), "utf8") === "new\n",
	"ordinary Git applies the complete implementer attempt",
);
git(cleanRoot, "reset", "--hard", baselineHead);
git(cleanRoot, "clean", "-fd");
const cleanupTmp = mkdtempSync(path.join(tmpdir(), "ypi_ref_cleanup."));
const cleanupScript = path.resolve(import.meta.dir, "..", "rlm_cleanup");
const cleanupDry = spawnSync(cleanupScript, ["--repo", cleanRoot, "--attempt-age", "0"], {
	encoding: "utf8",
	env: { ...process.env, TMPDIR: cleanupTmp },
});
record(
	cleanupDry.status === 0
		&& cleanupDry.stdout.includes("Attempt refs older than 0m: 1")
		&& git(cleanRoot, "rev-parse", report.attemptRef!) === report.attemptCommit,
	"attempt-ref cleanup is dry-run by default",
	cleanupDry.stderr,
);
const cleanupForced = spawnSync(cleanupScript, ["--repo", cleanRoot, "--attempt-age", "0", "--force"], {
	encoding: "utf8",
	env: { ...process.env, TMPDIR: cleanupTmp },
});
const removedAttempt = spawnSync("git", ["rev-parse", "--verify", report.attemptRef!], {
	cwd: cleanRoot,
	encoding: "utf8",
	env: (() => {
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("GIT_")) env[key] = value;
		}
		return env;
	})(),
});
record(cleanupForced.status === 0 && removedAttempt.status !== 0, "forced cleanup expires only the selected aged attempt ref", cleanupForced.stderr);

const dirtyRoot = fixture();
writeFileSync(path.join(dirtyRoot, "tracked.txt"), "dirty\n");
expectThrow("dirty checkout declines implement mode", "requires a clean Git checkout", () => acquireWorkspace({ cwd: dirtyRoot, childDepth: 1, mode: "implement" }));
const dirtyLock = git(dirtyRoot, "rev-parse", "--path-format=absolute", "--git-path", "ypi-implementer.lock");
record(!existsSync(dirtyLock), "dirty-check rejection leaves no writer lease");

const ignoredRoot = fixture();
const ignoredWriter = acquireWorkspace({ cwd: ignoredRoot, childDepth: 1, mode: "implement" });
const ignoredLock = git(ignoredRoot, "rev-parse", "--path-format=absolute", "--git-path", "ypi-implementer.lock");
const auditFile = ignoredWriter.childEnvironment.YPI_IMPLEMENT_AUDIT_FILE!;
appendFileSync(auditFile, "leak.txt\0");
writeFileSync(path.join(ignoredRoot, ".gitignore"), "leak.txt\n");
writeFileSync(path.join(ignoredRoot, "leak.txt"), "must not disappear\n");
let ignoredFailure: WorkspaceFinalizationError | undefined;
try { ignoredWriter.finalize(); }
catch (error) {
	if (error instanceof WorkspaceFinalizationError) ignoredFailure = error;
}
ignoredWriter.cleanup();
record(
	Boolean(ignoredFailure)
		&& ignoredFailure?.report.reportComplete === false
		&& ignoredFailure.report.treeRestored === false
		&& ignoredFailure.message.includes("final checkout"),
	"unsnapshotable ignored write fails finalization loudly",
	ignoredFailure?.message,
);
record(
	existsSync(path.join(ignoredRoot, "leak.txt"))
		&& readFileSync(path.join(ignoredRoot, "leak.txt"), "utf8") === "must not disappear\n"
		&& existsSync(ignoredLock),
	"snapshot failure preserves the dirty tree and writer lock",
);
rmSync(ignoredLock, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

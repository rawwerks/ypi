import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_AUTHOR_NAME = "ypi-test";
	env.GIT_AUTHOR_EMAIL = "ypi@example.invalid";
	env.GIT_COMMITTER_NAME = "ypi-test";
	env.GIT_COMMITTER_EMAIL = "ypi@example.invalid";
	return env;
}

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "ypi_workspace_policy."));
	git(root, "init", "-q");
	writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
	writeFileSync(path.join(root, "tracked.txt"), "base\n");
	git(root, "add", ".gitignore", "tracked.txt");
	git(root, "commit", "-qm", "base");
	return root;
}

function expectThrow(label: string, expected: string, fn: () => unknown) {
	try {
		fn();
		record(false, label, "expected throw");
	} catch (error) {
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
rmSync(reviewRoot, { recursive: true, force: true });

const cleanRoot = fixture();
const baselineHead = git(cleanRoot, "rev-parse", "HEAD");
const hookSentinel = `${cleanRoot}.internal-git-hook-ran`;
const hooks = path.join(git(cleanRoot, "rev-parse", "--absolute-git-dir"), "hooks");
for (const name of ["post-checkout", "reference-transaction"]) {
	const hook = path.join(hooks, name);
	writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' ran >> '${hookSentinel}'\n`);
	chmodSync(hook, 0o755);
}
const writer = acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement", scope: ["tracked.txt", "space name.txt"] });
record(
	!writer.readOnly
		&& writer.mode === "git-worktree"
		&& writer.quiesceProcessGroup
		&& writer.cwd !== cleanRoot
		&& existsSync(writer.cwd),
	"clean Git implementer acquires an isolated worktree lease",
);
record(!existsSync(hookSentinel), "internal worktree creation does not execute repository hooks");
const commonDir = git(cleanRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
const registryRoot = path.join(commonDir, "ypi-implementers", "leases");
record(existsSync(registryRoot), "implementer lease is persisted in common Git metadata");
expectThrow(
	"overlapping implementer is rejected while lease is held",
	"overlaps live implementer",
	() => acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement", scope: ["tracked.txt"] }),
);
writeFileSync(path.join(writer.cwd, "tracked.txt"), "changed\n");
writeFileSync(path.join(writer.cwd, "space name.txt"), "new\n");
record(
	readFileSync(path.join(cleanRoot, "tracked.txt"), "utf8") === "base\n"
		&& !existsSync(path.join(cleanRoot, "space name.txt"))
		&& git(cleanRoot, "status", "--porcelain=v2", "--untracked-files=all") === "",
	"implementer edits never reach the real checkout",
);
const report = writer.finalize();
writer.cleanup();
record(
	report.reportComplete
		&& report.workspaceMode === "git-worktree"
		&& report.treeRestored === true
		&& report.changedPaths.includes("tracked.txt")
		&& report.changedPaths.includes("space name.txt")
		&& Boolean(report.attemptRef)
		&& Boolean(report.attemptCommit),
	"implementer reports a verified attempt ref and changed paths",
	JSON.stringify(report),
);
record(!existsSync(writer.cwd), "ephemeral implementer worktree is removed after verified snapshot");
record(!existsSync(hookSentinel), "internal attempt-ref finalization does not execute repository hooks");
record(
	readFileSync(path.join(cleanRoot, "tracked.txt"), "utf8") === "base\n"
		&& !existsSync(path.join(cleanRoot, "space name.txt"))
		&& git(cleanRoot, "status", "--porcelain=v2", "--untracked-files=all") === "",
	"real checkout remains at its clean baseline after finalization",
);
record(git(cleanRoot, "rev-parse", report.attemptRef!) === report.attemptCommit, "attempt ref resolves to the reported commit");
record(
	git(cleanRoot, "show", `${report.attemptRef}:tracked.txt`) === "changed"
		&& git(cleanRoot, "show", `${report.attemptRef}:space name.txt`) === "new",
	"attempt ref contains the exact tracked and untracked edits",
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
	env: { ...gitEnvironment(), TMPDIR: cleanupTmp },
});
record(
	cleanupDry.status === 0
		&& cleanupDry.stdout.includes("Attempt refs older than 0m: 1")
		&& git(cleanRoot, "rev-parse", report.attemptRef!) === report.attemptCommit,
	"attempt-ref cleanup remains dry-run by default",
	cleanupDry.stderr,
);
const cleanupForced = spawnSync(cleanupScript, ["--repo", cleanRoot, "--attempt-age", "0", "--force"], {
	encoding: "utf8",
	env: { ...gitEnvironment(), TMPDIR: cleanupTmp },
});
const removedAttempt = spawnSync("git", ["rev-parse", "--verify", report.attemptRef!], {
	cwd: cleanRoot,
	encoding: "utf8",
	env: gitEnvironment(),
});
record(cleanupForced.status === 0 && removedAttempt.status !== 0, "forced cleanup expires only the selected aged attempt ref", cleanupForced.stderr);
rmSync(cleanupTmp, { recursive: true, force: true });

const dirtyRoot = fixture();
writeFileSync(path.join(dirtyRoot, "tracked.txt"), "dirty\n");
expectThrow(
	"dirty checkout declines implement mode",
	"requires a clean Git checkout",
	() => acquireWorkspace({ cwd: dirtyRoot, childDepth: 1, mode: "implement", scope: ["tracked.txt"] }),
);
const dirtyCommon = git(dirtyRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
record(!existsSync(path.join(dirtyCommon, "ypi-implementers", "leases")), "dirty-check rejection leaves no implementer registry");
rmSync(dirtyRoot, { recursive: true, force: true });

const ignoredRoot = fixture();
const ignoredWriter = acquireWorkspace({ cwd: ignoredRoot, childDepth: 1, mode: "implement", scope: [".gitignore", "ignored"] });
writeFileSync(path.join(ignoredWriter.cwd, ".gitignore"), "");
mkdirSync(path.join(ignoredWriter.cwd, "ignored"));
writeFileSync(path.join(ignoredWriter.cwd, "ignored", "leak.txt"), "must not disappear\n", { flag: "w" });
let ignoredFailure: WorkspaceFinalizationError | undefined;
try {
	ignoredWriter.finalize();
} catch (error) {
	if (error instanceof WorkspaceFinalizationError) ignoredFailure = error;
}
ignoredWriter.cleanup();
record(
	Boolean(ignoredFailure)
		&& ignoredFailure?.report.reportComplete === false
		&& ignoredFailure.report.treeRestored === false
		&& ignoredFailure.message.includes("baseline checkout"),
	"unsnapshotable ignored write fails finalization loudly",
	ignoredFailure?.message,
);
record(
	existsSync(path.join(ignoredWriter.cwd, "ignored", "leak.txt"))
		&& readFileSync(path.join(ignoredWriter.cwd, "ignored", "leak.txt"), "utf8") === "must not disappear\n"
		&& git(ignoredRoot, "status", "--porcelain=v2", "--untracked-files=all") === "",
	"snapshot failure preserves the isolated primary copy and real checkout",
);
git(ignoredRoot, "worktree", "remove", "--force", ignoredWriter.cwd);
rmSync(path.dirname(ignoredWriter.cwd), { recursive: true, force: true });
const ignoredCommon = git(ignoredRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
rmSync(path.join(ignoredCommon, "ypi-implementers"), { recursive: true, force: true });
rmSync(path.join(ignoredCommon, "ypi-implementers.lock"), { recursive: true, force: true });
rmSync(ignoredRoot, { recursive: true, force: true });
rmSync(cleanRoot, { recursive: true, force: true });
rmSync(hookSentinel, { force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

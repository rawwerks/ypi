import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";

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
const writer = acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement" });
record(!writer.readOnly && writer.mode === "git-shared" && writer.quiesceProcessGroup, "clean Git implementer acquires one shared writer lease");
const lockPath = git(cleanRoot, "rev-parse", "--path-format=absolute", "--git-path", "ypi-shared-writer.lock");
record(existsSync(lockPath), "writer lease is materialized inside existing Git metadata");
expectThrow("second implementer is rejected while lease is held", "Another ypi implementer", () => acquireWorkspace({ cwd: cleanRoot, childDepth: 1, mode: "implement" }));
writeFileSync(path.join(cleanRoot, "tracked.txt"), "changed\n");
writeFileSync(path.join(cleanRoot, "space name.txt"), "new\n");
const report = writer.finalize();
record(report.reportComplete && report.changedPaths.includes("tracked.txt") && report.changedPaths.includes("space name.txt"), "implementer reports tracked and untracked changed paths", JSON.stringify(report));
writer.cleanup();
record(!existsSync(lockPath), "owned writer lease is released after final report");
record(readFileSync(path.join(cleanRoot, "tracked.txt"), "utf8") === "changed\n", "shared implementer work remains in the parent checkout for review");

const dirtyRoot = fixture();
writeFileSync(path.join(dirtyRoot, "tracked.txt"), "dirty\n");
expectThrow("dirty checkout declines implement mode", "requires a clean Git checkout", () => acquireWorkspace({ cwd: dirtyRoot, childDepth: 1, mode: "implement" }));
const dirtyLock = git(dirtyRoot, "rev-parse", "--path-format=absolute", "--git-path", "ypi-shared-writer.lock");
record(!existsSync(dirtyLock), "dirty-check rejection leaves no writer lease");

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

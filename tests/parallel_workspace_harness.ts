import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireWorkspace, WorkspaceFinalizationError } from "../extensions/ypi/internal/workspace-policy.ts";
import {
	normalizeImplementScope,
	pathIsWithinImplementScope,
	scopesOverlap,
} from "../extensions/ypi/internal/implement-scope.ts";

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_AUTHOR_NAME = "ypi-parallel-test";
	env.GIT_AUTHOR_EMAIL = "ypi-parallel@example.invalid";
	env.GIT_COMMITTER_NAME = "ypi-parallel-test";
	env.GIT_COMMITTER_EMAIL = "ypi-parallel@example.invalid";
	return env;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "ypi_parallel_workspace."));
	git(root, "init", "-q");
	for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
		writeFileSync(path.join(root, name), `base ${name}\n`);
	}
	git(root, "add", ".");
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

console.log("\n=== Parallel implementer workspace harness ===");

const normalized = normalizeImplementScope(["./src/a.ts", "src/a.ts", "docs"]);
record(normalized.join(",") === "docs,src/a.ts", "scope normalization is deterministic and deduplicated", normalized.join(","));
record(pathIsWithinImplementScope("src/a.ts", ["src"]), "directory scope includes descendants");
record(!pathIsWithinImplementScope("src2/a.ts", ["src"]), "scope matching uses path-component boundaries");
record(scopesOverlap(["src"], ["src/a.ts"]), "ancestor and descendant scopes overlap");
record(!scopesOverlap(["src/a.ts"], ["src/b.ts"]), "sibling file scopes are disjoint");
record(scopesOverlap(["SRC"], ["src/a.ts"]), "admission conservatively rejects case-folded overlap");
record(scopesOverlap(["caf\u00e9"], ["cafe\u0301/menu"]), "admission rejects normalization-equivalent overlap");
record(scopesOverlap(["stra\u00dfe"], ["STRASSE/menu"]), "admission rejects compatibility case-folded overlap");
expectThrow("absolute scope is rejected", "repository-relative", () => normalizeImplementScope(["/tmp/outside"]));
expectThrow("parent-traversal scope is rejected", "repository-relative", () => normalizeImplementScope(["../outside"]));

const root = fixture();
const baseline = git(root, "rev-parse", "HEAD");
expectThrow(
	"implement mode requires an explicit scope",
	"non-empty scope",
	() => acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement" }),
);

const a = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
const b = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["b.txt"] });
const c = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["c.txt"] });
record(
	a.mode === "git-worktree"
		&& b.mode === "git-worktree"
		&& c.mode === "git-worktree"
		&& new Set([a.cwd, b.cwd, c.cwd]).size === 3
		&& [a.cwd, b.cwd, c.cwd].every((candidate) => candidate !== root && existsSync(candidate)),
	"three disjoint implementers receive distinct detached worktrees",
);
record(git(root, "status", "--porcelain=v2", "--untracked-files=all") === "", "real checkout stays clean while three implementers are live");
expectThrow(
	"overlapping scope admission is refused",
	"overlaps live implementer",
	() => acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] }),
);
expectThrow(
	"repository-wide scope overlaps every live slice",
	"overlaps live implementer",
	() => acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["."] }),
);
expectThrow(
	"fourth disjoint implementer exceeds the concurrency cap",
	"concurrency cap",
	() => acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["d.txt"] }),
);

writeFileSync(path.join(a.cwd, "a.txt"), "attempt a\n");
writeFileSync(path.join(b.cwd, "b.txt"), "attempt b\n");
writeFileSync(path.join(c.cwd, "c.txt"), "attempt c\n");
const reports = [a, b, c].map((lease) => {
	const report = lease.finalize();
	lease.cleanup();
	record(git(root, "status", "--porcelain=v2", "--untracked-files=all") === "", `real checkout stays clean after ${report.leaseId} finalizes`);
	return report;
});
record(
	reports.every((report) => report.reportComplete
		&& report.workspaceMode === "git-worktree"
		&& report.treeRestored === true
		&& Boolean(report.attemptRef)
		&& Boolean(report.attemptCommit)
		&& !existsSync(report.workspaceRoot)),
	"each implementer returns a verified ref and removes its ephemeral worktree",
	JSON.stringify(reports),
);

for (const report of reports) git(root, "cherry-pick", "-n", report.attemptCommit!);
const forwardTree = git(root, "write-tree");
record(
	readFileSync(path.join(root, "a.txt"), "utf8") === "attempt a\n"
		&& readFileSync(path.join(root, "b.txt"), "utf8") === "attempt b\n"
		&& readFileSync(path.join(root, "c.txt"), "utf8") === "attempt c\n",
	"applying all refs yields the exact union of slice edits",
);
git(root, "reset", "--hard", baseline);
for (const report of [...reports].reverse()) git(root, "cherry-pick", "-n", report.attemptCommit!);
const reverseTree = git(root, "write-tree");
record(forwardTree === reverseTree, "disjoint attempt refs are apply-order invariant", `${forwardTree} != ${reverseTree}`);
git(root, "reset", "--hard", baseline);

const violator = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
writeFileSync(path.join(violator.cwd, "b.txt"), "escaped slice\n");
let violation: WorkspaceFinalizationError | undefined;
try {
	violator.finalize();
} catch (error) {
	if (error instanceof WorkspaceFinalizationError) violation = error;
}
violator.cleanup();
record(
	Boolean(violation)
		&& violation?.message.includes("outside declared scope") === true
		&& violation.report.reportComplete === false
		&& violation.report.attemptRef === undefined,
	"finalization independently rejects writes that bypass the tool-call scope filter",
	violation?.message,
);
record(
	existsSync(violator.cwd)
		&& readFileSync(path.join(violator.cwd, "b.txt"), "utf8") === "escaped slice\n"
		&& git(root, "status", "--porcelain=v2", "--untracked-files=all") === "",
	"scope failure preserves the isolated worktree and leaves the real checkout untouched",
);

git(root, "worktree", "remove", "--force", violator.cwd);
rmSync(path.dirname(violator.cwd), { recursive: true, force: true });
const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
rmSync(path.join(commonDir, "ypi-implementers"), { recursive: true, force: true });
rmSync(path.join(commonDir, "ypi-implementers.lock"), { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });

const hostileRoot = fixture();
const hostileCommonDir = git(hostileRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
const externalRegistry = mkdtempSync(path.join(tmpdir(), "ypi_external_registry."));
writeFileSync(path.join(externalRegistry, "keep.txt"), "keep\n");
symlinkSync(externalRegistry, path.join(hostileCommonDir, "ypi-implementers"), "dir");
expectThrow(
	"symlinked registry root blocks implementer admission",
	"not an owned directory",
	() => acquireWorkspace({ cwd: hostileRoot, childDepth: 1, mode: "implement", scope: ["a.txt"] }),
);
const hostileCleanup = spawnSync(
	path.resolve(import.meta.dir, "..", "rlm_cleanup"),
	["--repo", hostileRoot, "--age", "0", "--force"],
	{ encoding: "utf8", env: cleanGitEnvironment() },
);
record(
	hostileCleanup.status !== 0
		&& readFileSync(path.join(externalRegistry, "keep.txt"), "utf8") === "keep\n"
		&& existsSync(path.join(hostileCommonDir, "ypi-implementers")),
	"cleanup preserves a symlinked registry and its external target",
	String(hostileCleanup.stderr || hostileCleanup.stdout || ""),
);
rmSync(hostileRoot, { recursive: true, force: true });
rmSync(externalRegistry, { recursive: true, force: true });

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

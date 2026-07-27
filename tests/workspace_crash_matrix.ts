import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWorkspace, type WorkspaceLifecycleStage } from "../extensions/ypi/internal/workspace-policy.ts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_AUTHOR_NAME: "ypi-crash-test",
		GIT_AUTHOR_EMAIL: "ypi-crash@example.invalid",
		GIT_COMMITTER_NAME: "ypi-crash-test",
		GIT_COMMITTER_EMAIL: "ypi-crash@example.invalid",
		...extra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

function pauseAt(stage: WorkspaceLifecycleStage, selected: string, sentinel: string): void {
	if (stage !== selected) return;
	writeFileSync(sentinel, `${stage}\n`);
	process.kill(process.pid, "SIGSTOP");
}

async function childMain(): Promise<void> {
	const [stage, root, sentinel] = process.argv.slice(3);
	const lease = acquireWorkspace({
		cwd: root,
		childDepth: 1,
		mode: "implement",
		lifecycleHook(current) {
			pauseAt(current, stage, sentinel);
		},
	});
	writeFileSync(path.join(root, "CHILD_CONTEXT"), "attempt\n");
	writeFileSync(path.join(root, "attempt.txt"), "untracked attempt\n");
	lease.finalize();
	lease.cleanup();
}

function waitForSentinel(sentinel: string, timeoutMilliseconds = 15_000): Promise<void> {
	if (existsSync(sentinel)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const directory = path.dirname(sentinel);
		const basename = path.basename(sentinel);
		const watcher = watch(directory, (_event, filename) => {
			if (filename === basename && existsSync(sentinel)) {
				clearTimeout(timer);
				watcher.close();
				resolve();
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${sentinel}`));
		}, timeoutMilliseconds);
	});
}

function writeGitWrapper(directory: string, realGit: string): void {
	const wrapper = path.join(directory, "git");
	writeFileSync(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${YPI_CRASH_STAGE:-}" = "mid-add" ] && [ "\${1:-}" = "add" ] && [ "\${2:-}" = "-A" ]; then
  "$YPI_REAL_GIT" add -- CHILD_CONTEXT
  printf 'mid-add\\n' > "$YPI_CRASH_SENTINEL"
  kill -STOP $$
fi
if [ "\${YPI_CRASH_STAGE:-}" = "mid-reset" ] && [ "\${1:-}" = "reset" ] && [ "\${2:-}" = "--hard" ]; then
  "$YPI_REAL_GIT" restore --source "\${3:?baseline required}" --worktree -- CHILD_CONTEXT
  printf 'mid-reset\\n' > "$YPI_CRASH_SENTINEL"
  kill -STOP $$
fi
exec "$YPI_REAL_GIT" "$@"
`);
	chmodSync(wrapper, 0o755);
}

function manualSnapshot(root: string, baseline: string, ref: string): void {
	const index = path.join(git(root, "rev-parse", "--absolute-git-dir"), `recovery-index-${process.pid}`);
	const env = cleanGitEnvironment({ GIT_INDEX_FILE: index });
	const run = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
		if (result.status !== 0) throw new Error(`manual git ${args.join(" ")} failed: ${result.stderr}`);
		return String(result.stdout || "").trim();
	};
	run("read-tree", baseline);
	run("add", "-A", "--", ".");
	const tree = run("write-tree");
	const commit = run("commit-tree", tree, "-p", baseline, "-m", "crash-test manual salvage");
	run("update-ref", ref, commit);
	rmSync(index, { force: true });
}

if (process.argv[2] === "--child") {
	await childMain();
	process.exit(0);
}

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}

console.log("\n=== Workspace snapshot/reset crash matrix ===");
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
const cases = [
	{ name: "before-snapshot", hook: "before-snapshot" },
	{ name: "mid-add", hook: "none" },
	{ name: "before-ref-update", hook: "before-ref-update" },
	{ name: "after-snapshot", hook: "after-snapshot" },
	{ name: "mid-reset", hook: "none" },
] as const;

for (const crashCase of cases) {
	const parent = mkdtempSync(path.join(tmpdir(), `ypi_crash_${crashCase.name}.`));
	const root = path.join(parent, "repo");
	git(parent, "clone", "-q", "--no-hardlinks", projectRoot, root);
	const baseline = git(root, "rev-parse", "HEAD");
	const baselineContent = readFileSync(path.join(root, "CHILD_CONTEXT"), "utf8");
	const sentinel = path.join(parent, "reached");
	const wrapperDir = path.join(parent, "bin");
	mkdirSync(wrapperDir);
	writeGitWrapper(wrapperDir, realGit);
	const env = cleanGitEnvironment({
		PATH: `${wrapperDir}${path.delimiter}${process.env.PATH || ""}`,
		YPI_CRASH_STAGE: crashCase.name,
		YPI_CRASH_SENTINEL: sentinel,
		YPI_REAL_GIT: realGit,
	});
	const child = spawn(process.execPath, [scriptPath, "--child", crashCase.hook, root, sentinel], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	let childDiagnostics = "";
	child.stdout?.on("data", (chunk) => { childDiagnostics += String(chunk); });
	child.stderr?.on("data", (chunk) => { childDiagnostics += String(chunk); });
	try {
		await waitForSentinel(sentinel);
		if (!child.pid) throw new Error("child PID unavailable");
		process.kill(-child.pid, "SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));

		const lockPath = git(root, "rev-parse", "--path-format=absolute", "--git-path", "ypi-implementer.lock");
		record(existsSync(lockPath), `${crashCase.name}: crash retains the writer lock`);
		let leaseError = "";
		try { acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement" }); }
		catch (error) { leaseError = error instanceof Error ? error.message : String(error); }
		record(leaseError.includes("Another ypi implementer"), `${crashCase.name}: next lease fails with actionable ownership error`, leaseError);

		const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/ypi/attempt-*").split("\n").filter(Boolean);
		const attemptRef = refs[0];
		const treeHasTracked = readFileSync(path.join(root, "CHILD_CONTEXT"), "utf8") === "attempt\n";
		const treeHasUntracked = existsSync(path.join(root, "attempt.txt"))
			&& readFileSync(path.join(root, "attempt.txt"), "utf8") === "untracked attempt\n";
		const refHasTracked = Boolean(attemptRef) && git(root, "show", `${attemptRef}:CHILD_CONTEXT`) === "attempt";
		const refHasUntracked = Boolean(attemptRef) && git(root, "show", `${attemptRef}:attempt.txt`) === "untracked attempt";
		record(treeHasTracked || refHasTracked, `${crashCase.name}: tracked work exists in tree or salvage ref`);
		record(treeHasUntracked || refHasUntracked, `${crashCase.name}: untracked work exists in tree or salvage ref`);

		if (!attemptRef) manualSnapshot(root, baseline, `refs/ypi/test-recovery-${crashCase.name}`);
		git(root, "reset", "--hard", baseline);
		git(root, "clean", "-fd");
		record(
			readFileSync(path.join(root, "CHILD_CONTEXT"), "utf8") === baselineContent
				&& !existsSync(path.join(root, "attempt.txt"))
				&& git(root, "status", "--porcelain=v2", "--untracked-files=all") === "",
			`${crashCase.name}: checkout is mechanically recoverable to baseline`,
		);
	} catch (error) {
		const cause = error instanceof Error ? error.stack || error.message : String(error);
		record(false, `${crashCase.name}: crash scenario completed`, `${cause}${childDiagnostics ? ` child=${childDiagnostics.trim()}` : ""}`);
		try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
	}
	rmSync(parent, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

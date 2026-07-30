import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
		scope: ["attempt.txt"],
		lifecycleHook(current) {
			pauseAt(current, stage, sentinel);
		},
	});
	writeFileSync(path.join(lease.cwd, "attempt.txt"), "crash attempt\n");
	lease.finalize();
	lease.cleanup();
}

function waitForSentinel(sentinel: string, timeoutMilliseconds = 15_000): Promise<void> {
	if (existsSync(sentinel)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const watcher = watch(path.dirname(sentinel), (_event, filename) => {
			if (filename === path.basename(sentinel) && existsSync(sentinel)) {
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

console.log("\n=== Workspace worktree/ref crash matrix ===");
const cases: WorkspaceLifecycleStage[] = [
	"after-lease-staged",
	"after-lease-reserved",
	"after-container-recorded",
	"after-container-created",
	"after-owner-marker-created",
	"after-worktree-created",
	"before-snapshot",
	"after-snapshot",
	"before-worktree-remove",
	"before-container-remove",
	"after-worktree-remove",
];

for (const stage of cases) {
	const parent = mkdtempSync(path.join(tmpdir(), `ypi_crash_${stage}.`));
	const root = path.join(parent, "repo");
	mkdirSync(root);
	git(root, "init", "-q");
	writeFileSync(path.join(root, "base.txt"), "base\n");
	git(root, "add", "base.txt");
	git(root, "commit", "-qm", "base");
	const baseline = git(root, "rev-parse", "HEAD");
	const sentinel = path.join(parent, "reached");
	const child = spawn(process.execPath, [scriptPath, "--child", stage, root, sentinel], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: cleanGitEnvironment(),
	});
	let diagnostics = "";
	child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
	child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
	try {
		await waitForSentinel(sentinel);
		if (!child.pid) throw new Error("child PID unavailable");
		process.kill(-child.pid, "SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));

		record(
			git(root, "rev-parse", "HEAD") === baseline
				&& git(root, "status", "--porcelain=v2", "--untracked-files=all") === "",
			`${stage}: root checkout stays at the clean baseline`,
		);
		const cleanup = spawnSync(path.join(projectRoot, "rlm_cleanup"), ["--repo", root, "--age", "0", "--force"], {
			encoding: "utf8",
			env: cleanGitEnvironment({ TMPDIR: parent }),
		});
		record(cleanup.status === 0, `${stage}: cleanup exits successfully`, String(cleanup.stderr || cleanup.stdout || ""));
		const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/ypi/attempt-*").split("\n").filter(Boolean);
		const interruptedBeforeWorktree = [
			"after-lease-staged",
			"after-lease-reserved",
			"after-container-recorded",
			"after-container-created",
			"after-owner-marker-created",
		].includes(stage);
		const expectedRefCount = interruptedBeforeWorktree ? 0 : 1;
		record(refs.length === expectedRefCount, `${stage}: expected verified attempt refs survive recovery`, refs.join(","));
		const expectedAttempt = stage === "after-worktree-created" ? false : true;
		const refHasAttempt = refs.length === 1
			&& spawnSync("git", ["cat-file", "-e", `${refs[0]}:attempt.txt`], { cwd: root, env: cleanGitEnvironment() }).status === 0;
		record(
			interruptedBeforeWorktree ? refs.length === 0 : refHasAttempt === expectedAttempt,
			`${stage}: recovered state matches work present at interruption`,
		);
		record(
			git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length === 1,
			`${stage}: no ephemeral worktree remains`,
		);
	} catch (error) {
		const cause = error instanceof Error ? error.stack || error.message : String(error);
		record(false, `${stage}: crash scenario completed`, `${cause}${diagnostics ? ` child=${diagnostics.trim()}` : ""}`);
		try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
	}
	rmSync(parent, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

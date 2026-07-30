import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { implementerLeaseRecordDigest } from "../extensions/ypi/internal/implementer-lease.ts";
import { readImplementerLeaseFile } from "../extensions/ypi/internal/implementer-lease-file.ts";
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
		GIT_AUTHOR_NAME: "ypi-concurrent-crash",
		GIT_AUTHOR_EMAIL: "ypi-concurrent-crash@example.invalid",
		GIT_COMMITTER_NAME: "ypi-concurrent-crash",
		GIT_COMMITTER_EMAIL: "ypi-concurrent-crash@example.invalid",
		...extra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnvironment() });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

function fixture(): { parent: string; root: string } {
	const parent = mkdtempSync(path.join(tmpdir(), "ypi_concurrent_crash."));
	const root = path.join(parent, "repo");
	mkdirSync(root);
	git(root, "init", "-q");
	writeFileSync(path.join(root, "a.txt"), "base a\n");
	writeFileSync(path.join(root, "b.txt"), "base b\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return { parent, root };
}

function pause(sentinel: string, payload: Record<string, unknown>): void {
	writeFileSync(sentinel, `${JSON.stringify(payload)}\n`);
	process.kill(process.pid, "SIGSTOP");
}

async function workerMain(): Promise<void> {
	const [root, scope, content, selectedStage, sentinel] = process.argv.slice(3);
	const lease = acquireWorkspace({
		cwd: root,
		childDepth: 1,
		mode: "implement",
		scope: [`${scope}.txt`],
		lifecycleHook(stage) {
			if (stage === selectedStage) pause(sentinel, { workspaceRoot: process.env.YPI_TEST_WORKSPACE, stage });
		},
	});
	process.env.YPI_TEST_WORKSPACE = lease.cwd;
	writeFileSync(path.join(lease.cwd, `${scope}.txt`), `${content}\n`);
	if (selectedStage === "after-write") {
		pause(sentinel, { workspaceRoot: lease.cwd, stage: selectedStage });
	}
	const report = lease.finalize();
	lease.cleanup();
	writeFileSync(sentinel, `${JSON.stringify({ leaseId: report.leaseId, attemptRef: report.attemptRef, stage: "complete" })}\n`);
}

async function parentMain(): Promise<void> {
	const [root, sentinel] = process.argv.slice(3);
	const a = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
	const b = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["b.txt"] });
	writeFileSync(path.join(a.cwd, "a.txt"), "parent crash a\n");
	writeFileSync(path.join(b.cwd, "b.txt"), "parent crash b\n");
	pause(sentinel, { workspaces: [a.cwd, b.cwd] });
}

if (process.argv[2] === "--worker") {
	await workerMain();
	process.exit(0);
}
if (process.argv[2] === "--parent") {
	await parentMain();
	process.exit(0);
}

function waitForSentinel(sentinel: string, timeoutMilliseconds = 20_000): Promise<Record<string, any>> {
	const read = () => JSON.parse(readFileSync(sentinel, "utf8"));
	if (existsSync(sentinel)) return Promise.resolve(read());
	return new Promise((resolve, reject) => {
		const watcher = watch(path.dirname(sentinel), (_event, filename) => {
			if (filename === path.basename(sentinel) && existsSync(sentinel)) {
				clearTimeout(timer);
				watcher.close();
				resolve(read());
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${sentinel}`));
		}, timeoutMilliseconds);
	});
}

function spawnWorker(root: string, scope: string, content: string, stage: string, sentinel: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
	return spawn(process.execPath, [scriptPath, "--worker", root, scope, content, stage, sentinel], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: cleanGitEnvironment(env),
	});
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; diagnostics: string }> {
	let diagnostics = "";
	child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
	child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
	return new Promise((resolve) => child.once("close", (code) => resolve({ code, diagnostics })));
}

function killGroup(child: ChildProcess): void {
	if (!child.pid) throw new Error("child PID unavailable");
	process.kill(-child.pid, "SIGKILL");
}

function cleanup(root: string, tempRoot: string, attemptAge?: number): ReturnType<typeof spawnSync> {
	const args = ["--repo", root, "--age", "0", "--force"];
	if (attemptAge !== undefined) args.push("--attempt-age", String(attemptAge));
	return spawnSync(path.join(projectRoot, "rlm_cleanup"), args, {
		encoding: "utf8",
		env: cleanGitEnvironment({ TMPDIR: tempRoot }),
	});
}

function attemptRefs(root: string): string[] {
	return git(root, "for-each-ref", "--format=%(refname)", "refs/ypi/attempt-*").split("\n").filter(Boolean);
}

function assertRefContent(root: string, expected: string, file: string): boolean {
	return attemptRefs(root).some((ref) => {
		const result = spawnSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", env: cleanGitEnvironment() });
		return result.status === 0 && result.stdout === `${expected}\n`;
	});
}

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}

console.log("\n=== Concurrent implementer crash matrix ===");
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git";
const cases: Array<{ name: string; stage: WorkspaceLifecycleStage | "mid-add" }> = [
	{ name: "before-snapshot", stage: "before-snapshot" },
	{ name: "mid-add", stage: "mid-add" },
	{ name: "before-ref-update", stage: "before-ref-update" },
	{ name: "after-snapshot", stage: "after-snapshot" },
	{ name: "before-worktree-remove", stage: "before-worktree-remove" },
	{ name: "after-worktree-remove", stage: "after-worktree-remove" },
];

for (const crashCase of cases) {
	const { parent, root } = fixture();
	const survivorSentinel = path.join(parent, "survivor");
	const victimSentinel = path.join(parent, "victim");
	const survivor = spawnWorker(root, "b", `survivor ${crashCase.name}`, "after-write", survivorSentinel);
	const survivorExit = waitForExit(survivor);
	let victim: ChildProcess | undefined;
	let victimExit: Promise<{ code: number | null; diagnostics: string }> | undefined;
	try {
		await waitForSentinel(survivorSentinel);
		const wrapperDir = path.join(parent, "bin");
		mkdirSync(wrapperDir);
		const wrapper = path.join(wrapperDir, "git");
		writeFileSync(wrapper, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${YPI_CRASH_STAGE:-}" = "mid-add" ] && [[ " $* " == *" add -A "* ]]; then
  printf '%s\\n' '{"stage":"mid-add"}' > "$YPI_CRASH_SENTINEL"
  kill -STOP $$
fi
exec "$YPI_REAL_GIT" "$@"
`);
		chmodSync(wrapper, 0o755);
		victim = spawnWorker(
			root,
			"a",
			`victim ${crashCase.name}`,
			crashCase.stage === "mid-add" ? "none" : crashCase.stage,
			victimSentinel,
			{
				PATH: `${wrapperDir}${path.delimiter}${process.env.PATH || ""}`,
				YPI_CRASH_STAGE: crashCase.stage,
				YPI_CRASH_SENTINEL: victimSentinel,
				YPI_REAL_GIT: realGit,
			},
		);
		victimExit = waitForExit(victim);
		await waitForSentinel(victimSentinel);
		killGroup(victim);
		await victimExit;

		record(git(root, "status", "--porcelain=v2", "--untracked-files=all") === "", `${crashCase.name}: real checkout remains untouched`);
		let overlapError = "";
		try {
			acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
		} catch (error) {
			overlapError = error instanceof Error ? error.message : String(error);
		}
		record(
			overlapError.includes("overlaps live implementer")
				|| (overlapError.includes("registry is busy or interrupted") && overlapError.includes("rlm_cleanup")),
			`${crashCase.name}: crashed lifecycle blocks admission with actionable recovery`,
			overlapError,
		);

		const cleanupResult = cleanup(root, parent);
		record(cleanupResult.status === 0, `${crashCase.name}: cleanup completes`, String(cleanupResult.stderr || cleanupResult.stdout || ""));
		record(assertRefContent(root, `victim ${crashCase.name}`, "a.txt"), `${crashCase.name}: cleanup preserves victim work in a verified ref`);
		record(!assertRefContent(root, `survivor ${crashCase.name}`, "b.txt"), `${crashCase.name}: cleanup does not snapshot a live survivor`);

		if (!survivor.pid) throw new Error("survivor PID unavailable");
		rmSync(survivorSentinel, { force: true });
		process.kill(-survivor.pid, "SIGCONT");
		const survivorResult = await survivorExit;
		record(survivorResult.code === 0, `${crashCase.name}: live disjoint implementer still finalizes`, survivorResult.diagnostics);
		record(assertRefContent(root, `survivor ${crashCase.name}`, "b.txt"), `${crashCase.name}: survivor returns its own verified ref`);
		record(
			git(root, "status", "--porcelain=v2", "--untracked-files=all") === ""
				&& git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length === 1,
			`${crashCase.name}: no worktree remains and real checkout is clean`,
		);
	} catch (error) {
		record(false, `${crashCase.name}: scenario completes`, error instanceof Error ? error.stack || error.message : String(error));
		try { if (victim?.pid) killGroup(victim); } catch {}
		try { if (survivor.pid) killGroup(survivor); } catch {}
	}
	rmSync(parent, { recursive: true, force: true });
}

{
	const { parent, root } = fixture();
	const sentinel = path.join(parent, "drift");
	const victim = spawnWorker(root, "a", "captured before drift", "after-snapshot", sentinel);
	const victimExit = waitForExit(victim);
	let worktreeRoot = "";
	try {
		const payload = await waitForSentinel(sentinel);
		worktreeRoot = String(payload.workspaceRoot || "");
		writeFileSync(path.join(worktreeRoot, "a.txt"), "late unsnapshotted drift\n");
		killGroup(victim);
		await victimExit;
		const cleanupResult = cleanup(root, parent);
		record(cleanupResult.status !== 0, "post-ref drift: forced cleanup fails loudly instead of removing divergent work", String(cleanupResult.stdout || cleanupResult.stderr || ""));
		record(
			existsSync(worktreeRoot)
				&& readFileSync(path.join(worktreeRoot, "a.txt"), "utf8") === "late unsnapshotted drift\n"
				&& git(root, "status", "--porcelain=v2", "--untracked-files=all") === "",
			"post-ref drift: divergent worktree remains the preserved primary copy and root stays clean",
		);
		let admissionError = "";
		try {
			acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
		} catch (error) {
			admissionError = error instanceof Error ? error.message : String(error);
		}
		record(admissionError.includes("overlaps live implementer"), "post-ref drift: retained lease continues blocking overlapping admission", admissionError);
	} catch (error) {
		record(false, "post-ref drift: scenario completes", error instanceof Error ? error.stack || error.message : String(error));
		try { if (victim.pid) killGroup(victim); } catch {}
	}
	if (worktreeRoot && existsSync(worktreeRoot)) {
		try { git(root, "worktree", "remove", "--force", worktreeRoot); } catch {}
		rmSync(path.dirname(worktreeRoot), { recursive: true, force: true });
	}
	rmSync(parent, { recursive: true, force: true });
}

{
	const { parent, root } = fixture();
	const sentinel = path.join(parent, "parent");
	const orchestrator = spawn(process.execPath, [scriptPath, "--parent", root, sentinel], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: cleanGitEnvironment(),
	});
	const orchestratorExit = waitForExit(orchestrator);
	try {
		await waitForSentinel(sentinel);
		killGroup(orchestrator);
		await orchestratorExit;
		record(git(root, "status", "--porcelain=v2", "--untracked-files=all") === "", "parent-kill: real checkout remains untouched with two orphaned leases");
		const cleanupResult = cleanup(root, parent, 0);
		record(cleanupResult.status === 0, "parent-kill: cleanup recovers both dead leases", String(cleanupResult.stderr || cleanupResult.stdout || ""));
		record(
			assertRefContent(root, "parent crash a", "a.txt")
				&& assertRefContent(root, "parent crash b", "b.txt"),
			"parent-kill: both child slices survive as verified refs despite zero attempt age",
		);
		record(
			git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length === 1,
			"parent-kill: cleanup leaves no orphaned worktrees",
		);
	} catch (error) {
		record(false, "parent-kill: scenario completes", error instanceof Error ? error.stack || error.message : String(error));
		try { if (orchestrator.pid) killGroup(orchestrator); } catch {}
	}
	rmSync(parent, { recursive: true, force: true });
}

{
	const { parent, root } = fixture();
	const lease = acquireWorkspace({ cwd: root, childDepth: 1, mode: "implement", scope: ["a.txt"] });
	lease.prepareChildLaunch();
	writeFileSync(path.join(lease.cwd, "a.txt"), "pid-file fallback\n");
	const sleeper = spawn("/bin/sh", ["-c", "sleep 30"], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: cleanGitEnvironment(),
	});
	const sleeperExit = waitForExit(sleeper);
	if (!sleeper.pid || !lease.childLaunchGate) throw new Error("launch-gate fixture is unavailable");
	writeFileSync(lease.childLaunchGate.pidFile, `${sleeper.pid}\n`, { mode: 0o600 });
	writeFileSync(lease.childLaunchGate.readyFile, `${sleeper.pid}\n`, { mode: 0o600 });
	lease.noteChildLaunchReady();
	const commonGitDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const leasesRoot = path.join(commonGitDir, "ypi-implementers", "leases");
	const leaseDirectory = path.join(leasesRoot, readdirSync(leasesRoot)[0]);
	const recordPath = path.join(leaseDirectory, "lease.json");
	const recordValue = readImplementerLeaseFile(
		leaseDirectory,
		path.basename(leaseDirectory),
		commonGitDir,
	);
	recordValue.ownerPid = 2_000_000_000;
	delete recordValue.childPid;
	recordValue.revision = 0;
	recordValue.recordDigest = implementerLeaseRecordDigest(recordValue);
	const payload = Buffer.from(`${JSON.stringify(recordValue)}\n`, "utf8");
	const digest = createHash("sha256").update(payload).digest("hex");
	const commit = Buffer.from(
		`commit\t0\t${payload.length}\t${digest}\n`,
		"ascii",
	);
	writeFileSync(recordPath, Buffer.concat([payload, commit]), { mode: 0o600 });

	const liveCleanup = cleanup(root, parent);
	record(
		liveCleanup.status === 0
			&& existsSync(lease.cwd)
			&& !assertRefContent(root, "pid-file fallback", "a.txt"),
		"launch PID fallback: cleanup leaves a registered live child untouched",
		String(liveCleanup.stderr || liveCleanup.stdout || ""),
	);
	killGroup(sleeper);
	await sleeperExit;
	const deadCleanup = cleanup(root, parent);
	record(
		deadCleanup.status === 0 && assertRefContent(root, "pid-file fallback", "a.txt"),
		"launch PID fallback: cleanup recovers the slice after that child exits",
		String(deadCleanup.stderr || deadCleanup.stdout || ""),
	);
	rmSync(parent, { recursive: true, force: true });
}

{
	const { parent, root } = fixture();
	const commonGitDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
	const lockPath = path.join(commonGitDir, "ypi-implementers.lock");
	mkdirSync(lockPath);
	const cleanupResult = cleanup(root, parent);
	record(
		cleanupResult.status === 0 && existsSync(lockPath),
		"lock-creation race: fresh ownerless registry lock is preserved",
		String(cleanupResult.stderr || cleanupResult.stdout || ""),
	);
	rmSync(lockPath, { recursive: true, force: true });
	rmSync(parent, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

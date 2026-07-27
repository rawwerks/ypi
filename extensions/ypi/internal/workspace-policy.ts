import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ChildMode = "review" | "implement";
export type WorkspaceMode = "read-only" | "git-shared";

export interface WorkspaceReport {
	requestedMode: ChildMode;
	effectiveMode: ChildMode;
	workspaceMode: WorkspaceMode;
	workspaceRoot: string;
	baselineHead?: string;
	finalHead?: string;
	changedPaths: string[];
	reportComplete: boolean;
	reportError?: string;
	leaseId?: string;
}

export interface WorkspaceLease {
	cwd: string;
	mode: WorkspaceMode;
	readOnly: boolean;
	quiesceProcessGroup: boolean;
	finalize(): WorkspaceReport;
	cleanup(): void;
}

export interface WorkspacePolicyInput {
	cwd: string;
	childDepth: number;
	mode: ChildMode;
	setupDeadlineMilliseconds?: number;
}

const WORKSPACE_CLEANUP_TIMEOUT_MS = 2_000;
const WORKSPACE_ADMISSION_TIMEOUT_MS = 5_000;

function remainingSetupMilliseconds(input: WorkspacePolicyInput): number {
	if (input.setupDeadlineMilliseconds === undefined) return WORKSPACE_ADMISSION_TIMEOUT_MS;
	const remaining = input.setupDeadlineMilliseconds - Date.now();
	if (remaining <= 0) {
		const error = new Error("RLM_TIMEOUT expired during recursive workspace setup") as Error & { exitCode: number };
		error.exitCode = 124;
		throw error;
	}
	return Math.max(1, Math.min(WORKSPACE_ADMISSION_TIMEOUT_MS, remaining));
}

// Git hooks (pre-push and friends) export GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
// into the environment. Inherited values would silently point every VCS check
// below at a *different* repository than the checkout being leased, making a
// clean fixture look dirty or a dirty parent look clean. All VCS subprocesses
// here are read-only queries or workspace-scoped cleanup, so scrubbing GIT_*
// is always safe. The environment is always passed explicitly: under Bun,
// deletions from process.env are not reflected in implicitly inherited child
// environments.
function vcsEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	return env;
}

function run(input: WorkspacePolicyInput, command: string, args: string[], cwd = input.cwd) {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: remainingSetupMilliseconds(input),
		env: vcsEnvironment(),
	});
}

function assertWithinDeadline(input: WorkspacePolicyInput, result: ReturnType<typeof spawnSync>, operation: string): void {
	if ((result.error as NodeJS.ErrnoException | undefined)?.code !== "ETIMEDOUT") return;
	const explicitlyTimed = input.setupDeadlineMilliseconds !== undefined;
	const error = new Error(explicitlyTimed
		? `RLM_TIMEOUT expired during ${operation}`
		: `Recursive workspace admission exceeded ${WORKSPACE_ADMISSION_TIMEOUT_MS}ms during ${operation}; no child work was started`) as Error & { exitCode: number };
	error.exitCode = explicitlyTimed ? 124 : 1;
	throw error;
}

function output(result: ReturnType<typeof spawnSync>): string {
	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function readOnlyLease(cwd: string): WorkspaceLease {
	return {
		cwd,
		mode: "read-only",
		readOnly: true,
		quiesceProcessGroup: false,
		finalize: () => ({
			requestedMode: "review",
			effectiveMode: "review",
			workspaceMode: "read-only",
			workspaceRoot: cwd,
			changedPaths: [],
			reportComplete: true,
		}),
		cleanup() {},
	};
}

function parseNulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function uniquePaths(...groups: string[][]): string[] {
	return [...new Set(groups.flat())].sort((a, b) => a.localeCompare(b));
}

function acquireWriterLock(lockPath: string): { token: string; release: () => void } {
	const token = randomBytes(16).toString("hex");
	try {
		mkdirSync(lockPath, { mode: 0o700 });
		writeFileSync(path.join(lockPath, "owner"), `${token}\n`, { mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error("Another ypi implementer already owns this repository. Continue other root work and retry only after that implementer finishes.");
		}
		throw error;
	}
	return {
		token,
		release: () => {
			try {
				if (readFileSync(path.join(lockPath, "owner"), "utf8").trim() === token) rmSync(lockPath, { recursive: true, force: true });
			} catch {
				// Preserve uncertain ownership rather than deleting another process's lease.
			}
		},
	};
}

function gitPath(input: WorkspacePolicyInput, root: string, name: string): string | undefined {
	const result = run(input, "git", ["rev-parse", "--path-format=absolute", "--git-path", name], root);
	assertWithinDeadline(input, result, `git path lookup for ${name}`);
	return result.status === 0 ? output(result) : undefined;
}

function gitChangedPaths(root: string, baselineHead: string): { paths: string[]; finalHead?: string; error?: string } {
	const command = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: WORKSPACE_CLEANUP_TIMEOUT_MS, env: vcsEnvironment() });
	const head = command(["rev-parse", "HEAD"]);
	const finalHead = head.status === 0 ? String(head.stdout || "").trim() : undefined;
	const committed = finalHead ? command(["diff", "--name-only", "-z", baselineHead, finalHead]) : undefined;
	const staged = command(["diff", "--cached", "--name-only", "-z"]);
	const unstaged = command(["diff", "--name-only", "-z"]);
	const untracked = command(["ls-files", "--others", "--exclude-standard", "-z"]);
	const results = [committed, staged, unstaged, untracked].filter((item): item is NonNullable<typeof item> => Boolean(item));
	if (!finalHead || results.some((item) => item.status !== 0)) {
		return { paths: [], finalHead, error: "Could not read final Git checkout state" };
	}
	return {
		paths: uniquePaths(...results.map((item) => parseNulPaths(String(item.stdout || "")))),
		finalHead,
	};
}

function createGitSharedLease(input: WorkspacePolicyInput, root: string): WorkspaceLease {
	const lockPath = gitPath(input, root, "ypi-shared-writer.lock");
	if (!lockPath) throw new Error("Implement mode could not resolve the existing Git checkout's writer lease path. Continue implementation in the root session.");
	const writer = acquireWriterLock(lockPath);

	try {
		for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
			const markerPath = gitPath(input, root, marker);
			if (markerPath && existsSync(markerPath)) throw new Error(`Git operation in progress (${marker}); continue implementation in the root session.`);
		}
		const status = run(input, "git", ["status", "--porcelain=v2", "--untracked-files=all"], root);
		assertWithinDeadline(input, status, "Git cleanliness check");
		if (status.status !== 0 || output(status)) throw new Error("Implement mode requires a clean Git checkout. Continue implementation in the root session so existing work is not mixed or lost.");
		const head = run(input, "git", ["rev-parse", "HEAD"], root);
		assertWithinDeadline(input, head, "Git HEAD check");
		const baselineHead = head.status === 0 ? output(head) : "";
		if (!baselineHead) throw new Error("Implement mode requires an existing Git HEAD. Continue implementation in the root session.");

		let finalized: WorkspaceReport | undefined;
		return {
			cwd: root,
			mode: "git-shared",
			readOnly: false,
			quiesceProcessGroup: true,
			finalize() {
				if (finalized) return finalized;
				const final = gitChangedPaths(root, baselineHead);
				finalized = {
					requestedMode: "implement",
					effectiveMode: "implement",
					workspaceMode: "git-shared",
					workspaceRoot: root,
					baselineHead,
					finalHead: final.finalHead,
					changedPaths: final.paths,
					reportComplete: !final.error,
					reportError: final.error,
					leaseId: writer.token.slice(0, 12),
				};
				return finalized;
			},
			cleanup: writer.release,
		};
	} catch (error) {
		writer.release();
		throw error;
	}
}

export function acquireWorkspace(input: WorkspacePolicyInput): WorkspaceLease {
	if (input.mode === "review") return readOnlyLease(input.cwd);

	const gitRootResult = run(input, "git", ["rev-parse", "--show-toplevel"]);
	assertWithinDeadline(input, gitRootResult, "Git discovery");
	if (gitRootResult.status !== 0) {
		throw new Error("Implement mode requires an existing clean Git checkout. No version-control system was installed or initialized; continue implementation in the root session.");
	}
	const gitRoot = output(gitRootResult);
	return createGitSharedLease(input, gitRoot);
}

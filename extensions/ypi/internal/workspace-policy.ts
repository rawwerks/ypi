import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export type ChildMode = "review" | "implement";
export type WorkspaceMode = "read-only" | "git-snapshot";
export type WorkspaceLifecycleStage = "before-snapshot" | "before-ref-update" | "after-snapshot";

export interface WorkspaceReport {
	requestedMode: ChildMode;
	effectiveMode: ChildMode;
	workspaceMode: WorkspaceMode;
	workspaceRoot: string;
	baselineHead?: string;
	finalHead?: string;
	changedPaths: string[];
	diffStat?: string;
	attemptRef?: string;
	attemptCommit?: string;
	treeRestored?: boolean;
	reportComplete: boolean;
	reportError?: string;
	leaseId?: string;
}

export interface WorkspaceLease {
	cwd: string;
	mode: WorkspaceMode;
	readOnly: boolean;
	quiesceProcessGroup: boolean;
	childEnvironment: NodeJS.ProcessEnv;
	finalize(): WorkspaceReport;
	cleanup(): void;
}

export interface WorkspacePolicyInput {
	cwd: string;
	childDepth: number;
	mode: ChildMode;
	setupDeadlineMilliseconds?: number;
	lifecycleHook?: (stage: WorkspaceLifecycleStage) => void;
}

export class WorkspaceFinalizationError extends Error {
	readonly report: WorkspaceReport;

	constructor(message: string, report: WorkspaceReport) {
		super(message);
		this.name = "WorkspaceFinalizationError";
		this.report = report;
	}
}

interface Gitlink {
	path: string;
	oid: string;
	initialized: boolean;
}

interface WriterLock {
	token: string;
	path: string;
	release(): void;
}

interface ConfinementState {
	auditFile: string;
	baselineIgnoreRoot: string;
	baselineIndexFile: string;
	gitDir: string;
	submodulePathsFile: string;
	gitlinks: Gitlink[];
}

const WORKSPACE_ADMISSION_TIMEOUT_MS = 5_000;
const WORKSPACE_FINALIZATION_TIMEOUT_MS = 120_000;
const ZERO_OID = "0000000000000000000000000000000000000000";

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

// Git hooks export repository-routing variables into their children. Every Git
// command here must discover the leased checkout from its explicit cwd.
function vcsEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, ...overrides };
}

function output(result: ReturnType<typeof spawnSync>): string {
	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function rawOutput(result: ReturnType<typeof spawnSync>): string {
	return typeof result.stdout === "string" ? result.stdout : "";
}

function stderr(result: ReturnType<typeof spawnSync>): string {
	return typeof result.stderr === "string" ? result.stderr.trim() : "";
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

function setupGit(
	input: WorkspacePolicyInput,
	root: string,
	args: string[],
	environment: NodeJS.ProcessEnv = {},
	stdinText?: string,
): ReturnType<typeof spawnSync> {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		input: stdinText,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: remainingSetupMilliseconds(input),
		env: vcsEnvironment(environment),
	});
	assertWithinDeadline(input, result, `git ${args[0] || "operation"}`);
	return result;
}

function checkedSetupGit(
	input: WorkspacePolicyInput,
	root: string,
	args: string[],
	operation: string,
	environment: NodeJS.ProcessEnv = {},
	preserveOutput = false,
): string {
	const result = setupGit(input, root, args, environment);
	if (result.status !== 0) {
		throw new Error(`${operation} failed${stderr(result) ? `: ${stderr(result)}` : ""}`);
	}
	return preserveOutput ? rawOutput(result) : output(result);
}

function finalizationGit(
	root: string,
	args: string[],
	operation: string,
	environment: NodeJS.ProcessEnv = {},
	stdinText?: string,
	preserveOutput = false,
): string {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		input: stdinText,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: WORKSPACE_FINALIZATION_TIMEOUT_MS,
		env: vcsEnvironment(environment),
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
		throw new Error(`${operation} exceeded ${WORKSPACE_FINALIZATION_TIMEOUT_MS}ms`);
	}
	if (result.status !== 0) {
		throw new Error(`${operation} failed${stderr(result) ? `: ${stderr(result)}` : ""}`);
	}
	return preserveOutput ? rawOutput(result) : output(result);
}

function readOnlyLease(cwd: string): WorkspaceLease {
	return {
		cwd,
		mode: "read-only",
		readOnly: true,
		quiesceProcessGroup: false,
		childEnvironment: {},
		finalize: () => ({
			requestedMode: "review",
			effectiveMode: "review",
			workspaceMode: "read-only",
			workspaceRoot: cwd,
			changedPaths: [],
			treeRestored: true,
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

function acquireWriterLock(lockPath: string): WriterLock {
	const token = randomBytes(16).toString("hex");
	try {
		mkdirSync(lockPath, { mode: 0o700 });
		writeFileSync(path.join(lockPath, "owner"), `${token}\n`, { mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Another ypi implementer or interrupted snapshot lifecycle owns this repository at ${lockPath}. Recover its work and remove the lock only after inspection.`);
		}
		throw error;
	}
	return {
		token,
		path: lockPath,
		release() {
			try {
				if (readFileSync(path.join(lockPath, "owner"), "utf8").trim() === token) {
					rmSync(lockPath, { recursive: true, force: true });
				}
			} catch {
				// Uncertain ownership is preserved for manual inspection.
			}
		},
	};
}

function gitPath(input: WorkspacePolicyInput, root: string, name: string): string | undefined {
	const result = setupGit(input, root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
	return result.status === 0 ? output(result) : undefined;
}

function assertAdmissibleCheckout(input: WorkspacePolicyInput, root: string): void {
	for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
		const markerPath = gitPath(input, root, marker);
		if (markerPath && existsSync(markerPath)) {
			throw new Error(`Git operation in progress (${marker}); continue implementation in the root session.`);
		}
	}
	const sparse = setupGit(input, root, ["config", "--bool", "core.sparseCheckout"]);
	if (sparse.status === 0 && output(sparse) === "true") {
		throw new Error("Implement mode does not support sparse Git checkouts because a full-tree snapshot cannot be proven. Continue implementation in the root session.");
	}
	const status = setupGit(input, root, ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"]);
	if (status.status !== 0 || output(status)) {
		throw new Error("Implement mode requires a clean Git checkout. Continue implementation in the root session so existing work is not mixed or lost.");
	}
}

function parseGitlinks(indexEntries: string, root: string): Gitlink[] {
	const links: Gitlink[] = [];
	for (const record of indexEntries.split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const [mode, oid] = record.slice(0, tab).split(/\s+/, 3);
		if (mode !== "160000" || !oid) continue;
		const gitPath = record.slice(tab + 1);
		const submoduleRoot = path.join(root, ...gitPath.split("/"));
		links.push({
			path: gitPath,
			oid,
			initialized: existsSync(path.join(submoduleRoot, ".git")),
		});
	}
	return links;
}

function materializeBaselineIgnoreFiles(
	input: WorkspacePolicyInput,
	root: string,
	baselineHead: string,
	ignoreRoot: string,
): void {
	const listing = checkedSetupGit(
		input,
		root,
		["ls-tree", "-r", "-z", baselineHead],
		"Baseline ignore-rule inventory",
		{},
		true,
	);
	for (const record of listing.split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) continue;
		const metadata = record.slice(0, tab).split(/\s+/);
		const [mode, type, oid] = metadata;
		const gitPath = record.slice(tab + 1);
		if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !oid) continue;
		if (gitPath.split("/").at(-1) !== ".gitignore") continue;
		const destination = path.join(ignoreRoot, ...gitPath.split("/"));
		mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		const blob = setupGit(input, root, ["cat-file", "blob", oid]);
		if (blob.status !== 0) throw new Error(`Could not read baseline ignore rule ${gitPath}`);
		writeFileSync(destination, typeof blob.stdout === "string" ? blob.stdout : Buffer.from(blob.stdout || ""));
	}
}

function createConfinementState(
	input: WorkspacePolicyInput,
	root: string,
	baselineHead: string,
	writer: WriterLock,
): ConfinementState {
	const auditFile = path.join(writer.path, "writes");
	const baselineIgnoreRoot = path.join(writer.path, "baseline-ignore");
	const baselineIndexFile = path.join(writer.path, "baseline-index");
	const submodulePathsFile = path.join(writer.path, "submodules");
	mkdirSync(baselineIgnoreRoot, { mode: 0o700 });
	writeFileSync(auditFile, "", { mode: 0o600 });
	checkedSetupGit(
		input,
		root,
		["read-tree", baselineHead],
		"Baseline index creation",
		{ GIT_INDEX_FILE: baselineIndexFile },
	);
	const gitDir = checkedSetupGit(input, root, ["rev-parse", "--absolute-git-dir"], "Git directory discovery");
	const gitlinks = parseGitlinks(
		checkedSetupGit(input, root, ["ls-files", "--stage", "-z"], "Submodule inventory", {}, true),
		root,
	);
	writeFileSync(submodulePathsFile, gitlinks.map((entry) => entry.path).join("\0"), { mode: 0o600 });
	materializeBaselineIgnoreFiles(input, root, baselineHead, baselineIgnoreRoot);
	return { auditFile, baselineIgnoreRoot, baselineIndexFile, gitDir, submodulePathsFile, gitlinks };
}

function gitRelativePath(root: string, candidate: string): string {
	return path.relative(root, candidate).split(path.sep).join("/");
}

function checkIgnored(
	root: string,
	relativePath: string,
	baseline: Pick<ConfinementState, "baselineIgnoreRoot" | "baselineIndexFile" | "gitDir"> | undefined,
): boolean {
	const args = baseline
		? [
			`--git-dir=${baseline.gitDir}`,
			`--work-tree=${baseline.baselineIgnoreRoot}`,
			"check-ignore",
			"-q",
			"-z",
			"--stdin",
		]
		: ["check-ignore", "-q", "-z", "--stdin"];
	const environment = baseline ? { GIT_INDEX_FILE: baseline.baselineIndexFile } : {};
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		input: `${relativePath}\0`,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: WORKSPACE_FINALIZATION_TIMEOUT_MS,
		env: vcsEnvironment(environment),
	});
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`Could not evaluate ${baseline ? "baseline" : "final"} ignore rules for ${relativePath}${stderr(result) ? `: ${stderr(result)}` : ""}`);
}

function isWithinSubmodule(relativePath: string, gitlinks: Gitlink[]): boolean {
	return gitlinks.some((entry) => relativePath === entry.path || relativePath.startsWith(`${entry.path}/`));
}

function auditedPaths(confinement: ConfinementState, root: string): string[] {
	if (!existsSync(confinement.auditFile)) throw new Error("Implementer write audit is missing");
	const paths = parseNulPaths(readFileSync(confinement.auditFile, "utf8"));
	for (const relativePath of paths) {
		const absolutePath = path.resolve(root, ...relativePath.split("/"));
		if (!existsSync(absolutePath)) continue;
		if (isWithinSubmodule(relativePath, confinement.gitlinks)) {
			throw new Error(`Implementer write audit contains a submodule path that cannot be snapshotted: ${relativePath}`);
		}
		if (checkIgnored(root, relativePath, confinement)) {
			throw new Error(`Implementer write is ignored by the baseline checkout and cannot be snapshotted: ${relativePath}`);
		}
		if (checkIgnored(root, relativePath, undefined)) {
			throw new Error(`Implementer write is ignored by the final checkout and cannot be snapshotted: ${relativePath}`);
		}
	}
	return uniquePaths(paths);
}

function assertSubmodulesUnchanged(root: string, gitlinks: Gitlink[]): void {
	for (const entry of gitlinks) {
		const submoduleRoot = path.join(root, ...entry.path.split("/"));
		if (!entry.initialized) {
			if (existsSync(path.join(submoduleRoot, ".git"))) {
				throw new Error(`Previously uninitialized submodule was initialized during implementation: ${entry.path}`);
			}
			continue;
		}
		if (!existsSync(submoduleRoot)) throw new Error(`Initialized submodule path disappeared during implementation: ${entry.path}`);
		const head = finalizationGit(submoduleRoot, ["rev-parse", "HEAD"], `Submodule HEAD check for ${entry.path}`);
		const status = finalizationGit(
			submoduleRoot,
			["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"],
			`Submodule cleanliness check for ${entry.path}`,
		);
		if (head !== entry.oid || status) {
			throw new Error(`Submodule changed during implementation and cannot be salvaged by the superproject: ${entry.path}`);
		}
	}
}

function assertCheckoutOwnership(root: string, baselineHead: string, baselineTree: string): void {
	const currentHead = finalizationGit(root, ["rev-parse", "HEAD"], "Git HEAD ownership check");
	if (currentHead !== baselineHead) {
		throw new Error(`Git HEAD changed during implementation (expected ${baselineHead}, found ${currentHead})`);
	}
	const currentIndexTree = finalizationGit(root, ["write-tree"], "Git index ownership check");
	if (currentIndexTree !== baselineTree) {
		throw new Error("The user's Git index changed during implementation; checkout reset was refused");
	}
}

function bestEffortChangedPaths(root: string, baselineHead: string): { paths: string[]; finalHead?: string } {
	const command = (args: string[]) => spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5_000,
		env: vcsEnvironment(),
	});
	const head = command(["rev-parse", "HEAD"]);
	const diff = command(["diff", "--name-only", "-z", baselineHead, "--"]);
	const untracked = command(["ls-files", "--others", "--exclude-standard", "-z"]);
	return {
		paths: uniquePaths(
			diff.status === 0 ? parseNulPaths(String(diff.stdout || "")) : [],
			untracked.status === 0 ? parseNulPaths(String(untracked.stdout || "")) : [],
		),
		finalHead: head.status === 0 ? output(head) : undefined,
	};
}

function sanitizeLeaseId(value: string): string {
	const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64);
	return safe || randomBytes(8).toString("hex");
}

function createGitSnapshotLease(input: WorkspacePolicyInput, root: string): WorkspaceLease {
	const lockPath = gitPath(input, root, "ypi-implementer.lock");
	if (!lockPath) {
		throw new Error("Implement mode could not resolve the existing Git checkout's writer lease path. Continue implementation in the root session.");
	}
	if (existsSync(lockPath)) {
		throw new Error(`Another ypi implementer or interrupted snapshot lifecycle owns this repository at ${lockPath}. Recover its work and remove the lock only after inspection.`);
	}
	assertAdmissibleCheckout(input, root);
	const writer = acquireWriterLock(lockPath);

	try {
		// Recheck under the lease so two contenders cannot race admission.
		assertAdmissibleCheckout(input, root);
		const baselineHead = checkedSetupGit(input, root, ["rev-parse", "HEAD"], "Git HEAD check");
		if (!baselineHead) throw new Error("Implement mode requires an existing Git HEAD. Continue implementation in the root session.");
		const baselineTree = checkedSetupGit(input, root, ["rev-parse", `${baselineHead}^{tree}`], "Baseline tree lookup");
		const confinement = createConfinementState(input, root, baselineHead, writer);
		const attemptRef = `refs/ypi/attempt-${sanitizeLeaseId(writer.token)}`;
		const snapshotIndexFile = path.join(writer.path, "snapshot-index");
		let finalized: WorkspaceReport | undefined;
		let finalizationError: WorkspaceFinalizationError | undefined;
		let releaseAllowed = false;

		return {
			cwd: root,
			mode: "git-snapshot",
			readOnly: false,
			quiesceProcessGroup: true,
			childEnvironment: {
				YPI_IMPLEMENT_ROOT: root,
				YPI_IMPLEMENT_AUDIT_FILE: confinement.auditFile,
				YPI_IMPLEMENT_BASELINE_IGNORE_ROOT: confinement.baselineIgnoreRoot,
				YPI_IMPLEMENT_BASELINE_INDEX: confinement.baselineIndexFile,
				YPI_IMPLEMENT_GIT_DIR: confinement.gitDir,
				YPI_IMPLEMENT_SUBMODULES_FILE: confinement.submodulePathsFile,
			},
			finalize() {
				if (finalized) return finalized;
				if (finalizationError) throw finalizationError;

				let attemptCommit: string | undefined;
				let refVerified = false;
				let diffStat: string | undefined;
				let changedPaths = bestEffortChangedPaths(root, baselineHead).paths;
				try {
					input.lifecycleHook?.("before-snapshot");
					auditedPaths(confinement, root);
					assertSubmodulesUnchanged(root, confinement.gitlinks);
					assertCheckoutOwnership(root, baselineHead, baselineTree);

					const snapshotEnvironment = { GIT_INDEX_FILE: snapshotIndexFile };
					finalizationGit(root, ["read-tree", baselineHead], "Snapshot index initialization", snapshotEnvironment);
					finalizationGit(root, ["add", "-A", "--", "."], "Snapshot staging", snapshotEnvironment);
					const snapshotTree = finalizationGit(root, ["write-tree"], "Snapshot tree creation", snapshotEnvironment);
					attemptCommit = finalizationGit(
						root,
						["commit-tree", snapshotTree, "-p", baselineHead, "-m", `ypi implementer attempt ${writer.token.slice(0, 12)}`],
						"Snapshot commit creation",
						{
							...snapshotEnvironment,
							GIT_AUTHOR_NAME: "ypi",
							GIT_AUTHOR_EMAIL: "ypi@localhost",
							GIT_COMMITTER_NAME: "ypi",
							GIT_COMMITTER_EMAIL: "ypi@localhost",
						},
					);
					input.lifecycleHook?.("before-ref-update");
					finalizationGit(root, ["update-ref", attemptRef, attemptCommit, ZERO_OID], "Snapshot ref creation");
					const verifiedCommit = finalizationGit(root, ["rev-parse", "--verify", `${attemptRef}^{commit}`], "Snapshot ref verification");
					const verifiedTree = finalizationGit(root, ["rev-parse", `${verifiedCommit}^{tree}`], "Snapshot tree verification");
					if (verifiedCommit !== attemptCommit || verifiedTree !== snapshotTree) {
						throw new Error("Snapshot ref verification did not resolve to the captured tree");
					}
					refVerified = true;

					changedPaths = parseNulPaths(finalizationGit(
						root,
						["diff", "--name-only", "-z", "--no-renames", baselineHead, attemptCommit, "--"],
						"Snapshot changed-path report",
						{},
						undefined,
						true,
					));
					diffStat = finalizationGit(
						root,
						["diff", "--stat", "--no-ext-diff", "--no-renames", baselineHead, attemptCommit, "--"],
						"Snapshot diffstat report",
					);
					input.lifecycleHook?.("after-snapshot");

					// Capture again immediately before rollback. Any drift after the
					// verified ref makes reset unsafe and leaves the checkout untouched.
					auditedPaths(confinement, root);
					assertSubmodulesUnchanged(root, confinement.gitlinks);
					assertCheckoutOwnership(root, baselineHead, baselineTree);
					finalizationGit(root, ["add", "-A", "--", "."], "Pre-reset tree verification staging", snapshotEnvironment);
					const preResetTree = finalizationGit(root, ["write-tree"], "Pre-reset tree verification", snapshotEnvironment);
					if (preResetTree !== snapshotTree) {
						throw new Error("Checkout changed after the salvage ref was captured; reset was refused");
					}

					finalizationGit(root, ["reset", "--hard", baselineHead], "Baseline reset");
					finalizationGit(root, ["clean", "-fd"], "Non-ignored checkout cleanup");
					assertSubmodulesUnchanged(root, confinement.gitlinks);
					const finalHead = finalizationGit(root, ["rev-parse", "HEAD"], "Restored HEAD verification");
					const finalTree = finalizationGit(root, ["write-tree"], "Restored index verification");
					const finalStatus = finalizationGit(
						root,
						["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"],
						"Restored checkout verification",
					);
					if (finalHead !== baselineHead || finalTree !== baselineTree || finalStatus) {
						throw new Error("Checkout did not return to the clean baseline after snapshot");
					}

					finalized = {
						requestedMode: "implement",
						effectiveMode: "implement",
						workspaceMode: "git-snapshot",
						workspaceRoot: root,
						baselineHead,
						finalHead,
						changedPaths,
						diffStat,
						attemptRef,
						attemptCommit,
						treeRestored: true,
						reportComplete: true,
						leaseId: writer.token.slice(0, 12),
					};
					releaseAllowed = true;
					return finalized;
				} catch (error) {
					const cause = error instanceof Error ? error.message : String(error);
					const state = bestEffortChangedPaths(root, baselineHead);
					const report: WorkspaceReport = {
						requestedMode: "implement",
						effectiveMode: "implement",
						workspaceMode: "git-snapshot",
						workspaceRoot: root,
						baselineHead,
						finalHead: state.finalHead,
						changedPaths: uniquePaths(changedPaths, state.paths),
						diffStat,
						attemptRef: refVerified ? attemptRef : undefined,
						attemptCommit: refVerified ? attemptCommit : undefined,
						treeRestored: false,
						reportComplete: false,
						reportError: cause,
						leaseId: writer.token.slice(0, 12),
					};
					const preservation = refVerified
						? `The attempted work has a verified snapshot at ${attemptRef}; verify it before recovery.`
						: "No verified salvage ref was available, so no reset or clean was attempted and the worktree remains the primary copy.";
					finalizationError = new WorkspaceFinalizationError(
						`Implementer snapshot/reset failed: ${cause}. ${preservation} The writer lock remains at ${writer.path}.`,
						report,
					);
					throw finalizationError;
				}
			},
			cleanup() {
				if (releaseAllowed) writer.release();
			},
		};
	} catch (error) {
		writer.release();
		throw error;
	}
}

export function acquireWorkspace(input: WorkspacePolicyInput): WorkspaceLease {
	if (input.mode === "review") return readOnlyLease(input.cwd);

	const gitRootResult = setupGit(input, input.cwd, ["rev-parse", "--show-toplevel"]);
	if (gitRootResult.status !== 0) {
		throw new Error("Implement mode requires an existing clean Git checkout. No version-control system was installed or initialized; continue implementation in the root session.");
	}
	return createGitSnapshotLease(input, output(gitRootResult));
}

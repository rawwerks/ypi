import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeImplementScope, pathIsWithinImplementScope } from "./implement-scope.ts";
import {
	implementerLeaseDirectory,
	readImplementerLeaseRecords,
	removeImplementerLeaseRecord,
	reserveImplementerLease,
	withImplementerRegistryLock,
	writeImplementerLeaseRecord,
} from "./workspace-registry.ts";
import type { ImplementerLeaseRecord } from "./implementer-lease.ts";

export type ChildMode = "review" | "implement";
export type WorkspaceMode = "read-only" | "git-worktree";
export type WorkspaceLifecycleStage =
	| "after-lease-staged"
	| "after-lease-reserved"
	| "after-container-recorded"
	| "after-container-created"
	| "after-owner-marker-created"
	| "after-worktree-created"
	| "before-snapshot"
	| "before-ref-update"
	| "after-snapshot"
	| "before-worktree-remove"
	| "before-container-remove"
	| "after-worktree-remove";

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
	scope?: string[];
}

export interface WorkspaceLease {
	cwd: string;
	mode: WorkspaceMode;
	readOnly: boolean;
	quiesceProcessGroup: boolean;
	childEnvironment: NodeJS.ProcessEnv;
	childLaunchGate?: {
		pidFile: string;
		readyFile: string;
	};
	prepareChildLaunch(): void;
	noteChildPid(pid: number): void;
	finalize(): WorkspaceReport;
	cleanup(): void;
}

export interface WorkspacePolicyInput {
	cwd: string;
	childDepth: number;
	mode: ChildMode;
	scope?: string[];
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

interface ConfinementState {
	auditFile: string;
	baselineIgnoreRoot: string;
	baselineIndexFile: string;
	childPidFile: string;
	childReadyFile: string;
	gitDir: string;
	scopeFile: string;
	scope: string[];
	submodulePathsFile: string;
	gitlinks: Gitlink[];
}

const WORKSPACE_ADMISSION_TIMEOUT_MS = 5_000;
const WORKSPACE_FINALIZATION_TIMEOUT_MS = 120_000;
const INTERNAL_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

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
	const result = spawnSync("git", [...INTERNAL_GIT_CONFIG, ...args], {
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
	const result = spawnSync("git", [...INTERNAL_GIT_CONFIG, ...args], {
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
		prepareChildLaunch() {},
		noteChildPid() {},
		cleanup() {},
	};
}

function parseNulPaths(value: string): string[] {
	return value.split("\0").filter(Boolean);
}

function uniquePaths(...groups: string[][]): string[] {
	return [...new Set(groups.flat())].sort((a, b) => a.localeCompare(b));
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
	leaseDirectory: string,
	scope: string[],
): ConfinementState {
	const auditFile = path.join(leaseDirectory, "writes");
	const baselineIgnoreRoot = path.join(leaseDirectory, "baseline-ignore");
	const baselineIndexFile = path.join(leaseDirectory, "baseline-index");
	const childPidFile = path.join(leaseDirectory, "child-pid");
	const childReadyFile = path.join(leaseDirectory, "child-ready");
	const scopeFile = path.join(leaseDirectory, "scope");
	const submodulePathsFile = path.join(leaseDirectory, "submodules");
	mkdirSync(baselineIgnoreRoot, { mode: 0o700 });
	writeFileSync(auditFile, "", { mode: 0o600 });
	writeFileSync(scopeFile, scope.join("\0"), { mode: 0o600 });
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
	return {
		auditFile,
		baselineIgnoreRoot,
		baselineIndexFile,
		childPidFile,
		childReadyFile,
		gitDir,
		scopeFile,
		scope,
		submodulePathsFile,
		gitlinks,
	};
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
	const result = spawnSync("git", [...INTERNAL_GIT_CONFIG, ...args], {
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
		if (!pathIsWithinImplementScope(relativePath, confinement.scope)) {
			throw new Error(`Implementer write audit contains a path outside declared scope: ${relativePath}`);
		}
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
			if (existsSync(submoduleRoot) && readdirSync(submoduleRoot).length > 0) {
				throw new Error(`Implementer created content inside an uninitialized submodule path: ${entry.path}`);
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
	const command = (args: string[]) => spawnSync("git", [...INTERNAL_GIT_CONFIG, ...args], {
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

function assertPathsWithinScope(paths: string[], scope: string[]): void {
	const outside = paths.filter((candidate) => !pathIsWithinImplementScope(candidate, scope));
	if (outside.length > 0) {
		throw new Error(`Snapshot contains paths outside declared scope: ${outside.join(", ")}`);
	}
}

function assertSnapshotPathsReviewable(
	root: string,
	paths: string[],
	confinement: ConfinementState,
): void {
	for (const relativePath of paths) {
		if (isWithinSubmodule(relativePath, confinement.gitlinks)) {
			throw new Error(`Snapshot contains a submodule path that cannot be represented by the superproject: ${relativePath}`);
		}
		if (checkIgnored(root, relativePath, confinement)) {
			throw new Error(`Snapshot contains a path ignored by the baseline checkout: ${relativePath}`);
		}
		if (checkIgnored(root, relativePath, undefined)) {
			throw new Error(`Snapshot contains a path ignored by the final checkout: ${relativePath}`);
		}
	}
}

function assertNoUnsnapshottedIgnoredPaths(root: string): void {
	const ignored = parseNulPaths(finalizationGit(
		root,
		["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
		"Ignored worktree inventory",
		{},
		undefined,
		true,
	));
	if (ignored.length > 0) {
		throw new Error(`Implementer worktree contains ignored paths that cannot be snapshotted: ${ignored.join(", ")}`);
	}
}

function assertRootCheckoutUntouched(root: string, baselineHead: string, baselineTree: string): void {
	const head = finalizationGit(root, ["rev-parse", "HEAD"], "Root checkout HEAD verification");
	const indexTree = finalizationGit(root, ["write-tree"], "Root checkout index verification");
	const status = finalizationGit(
		root,
		["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=none"],
		"Root checkout cleanliness verification",
	);
	if (head !== baselineHead || indexTree !== baselineTree || status) {
		throw new Error("The root checkout changed while implementer worktrees were live; integration must wait for every slice to finish");
	}
}

function persistLeaseRecord(record: ImplementerLeaseRecord): void {
	withImplementerRegistryLock(record.commonGitDir, () => {
		const current = readImplementerLeaseRecords(record.commonGitDir)
			.find((candidate) => candidate.token === record.token);
		if (!current || current.ownerPid !== process.pid) {
			throw new Error(`Implementer lease ${record.token.slice(0, 12)} is no longer owned by this process`);
		}
		writeImplementerLeaseRecord(record);
	});
}

function removeSetupLease(record: ImplementerLeaseRecord): void {
	withImplementerRegistryLock(record.commonGitDir, () => {
		const current = readImplementerLeaseRecords(record.commonGitDir)
			.find((candidate) => candidate.token === record.token);
		if (current?.ownerPid === process.pid) removeImplementerLeaseRecord(record.commonGitDir, record.token);
	});
}

function bestEffortDiscardSetupWorktree(root: string, record: ImplementerLeaseRecord): string | undefined {
	if (record.worktreeContainer && record.worktreeRoot) {
		if (
			!path.isAbsolute(record.worktreeContainer)
			|| !path.isAbsolute(record.worktreeRoot)
			|| path.basename(record.worktreeContainer) !== `ypi_ws_${record.token}`
			|| record.worktreeRoot !== path.join(record.worktreeContainer, "checkout")
		) {
			return "recorded setup workspace paths are invalid";
		}
	}
	if (record.worktreeContainer && existsSync(record.worktreeContainer)) {
		try {
			const container = lstatSync(record.worktreeContainer);
			const markerPath = path.join(record.worktreeContainer, "owner");
			const marker = lstatSync(markerPath);
			if (
				!container.isDirectory()
				|| container.isSymbolicLink()
				|| path.basename(record.worktreeContainer) !== `ypi_ws_${record.token}`
				|| record.worktreeRoot !== path.join(record.worktreeContainer, "checkout")
				|| !marker.isFile()
				|| marker.isSymbolicLink()
				|| readFileSync(markerPath, "utf8").trim() !== record.token
			) {
				throw new Error("workspace ownership marker does not prove setup-cleanup authority");
			}
		} catch {
			if (record.worktreeRoot && existsSync(record.worktreeRoot)) {
				return "workspace ownership marker is unavailable";
			}
			try {
				const entries = readdirSync(record.worktreeContainer);
				if (entries.length === 0) {
					rmSync(record.worktreeContainer);
					return undefined;
				}
				const markerPath = path.join(record.worktreeContainer, "owner");
				if (entries.length !== 1 || entries[0] !== "owner") {
					return "unmarked workspace container has unexpected content";
				}
				const marker = lstatSync(markerPath);
				const actual = readFileSync(markerPath);
				const expected = Buffer.from(`${record.token}\n`);
				if (
					!marker.isFile()
					|| marker.isSymbolicLink()
					|| actual.length > expected.length
					|| !expected.subarray(0, actual.length).equals(actual)
				) {
					return "workspace ownership marker is invalid";
				}
				rmSync(markerPath);
				rmSync(record.worktreeContainer);
				return undefined;
			} catch {
				return "workspace ownership marker is unavailable";
			}
		}
	}
	if (record.worktreeRoot && existsSync(record.worktreeRoot)) {
		if (!record.worktreeContainer || !existsSync(record.worktreeContainer)) {
			return "workspace container is unavailable";
		}
			const result = spawnSync("git", [...INTERNAL_GIT_CONFIG, "worktree", "remove", "--force", record.worktreeRoot], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: WORKSPACE_FINALIZATION_TIMEOUT_MS,
			env: vcsEnvironment(),
		});
		if (result.status !== 0) return stderr(result) || "git worktree remove failed";
	}
	if (record.worktreeContainer && existsSync(record.worktreeContainer)) {
		rmSync(record.worktreeContainer, { recursive: true, force: true });
	}
	return undefined;
}

function createGitWorktreeLease(
	input: WorkspacePolicyInput,
	root: string,
	scope: string[],
): WorkspaceLease {
	assertAdmissibleCheckout(input, root);
	const baselineHead = checkedSetupGit(input, root, ["rev-parse", "HEAD"], "Git HEAD check");
	if (!baselineHead) {
		throw new Error("Implement mode requires an existing Git HEAD. Continue implementation in the root session.");
	}
	const baselineTree = checkedSetupGit(input, root, ["rev-parse", `${baselineHead}^{tree}`], "Baseline tree lookup");
	const commonGitDir = checkedSetupGit(
		input,
		root,
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		"Common Git directory discovery",
	);
	const record = reserveImplementerLease(
		commonGitDir,
		root,
		baselineHead,
		scope,
		input.setupDeadlineMilliseconds,
		() => input.lifecycleHook?.("after-lease-reserved"),
		() => input.lifecycleHook?.("after-lease-staged"),
	);

	let worktreeRoot = "";
	try {
		assertAdmissibleCheckout(input, root);
		record.worktreeContainer = path.join(tmpdir(), `ypi_ws_${record.token}`);
		record.worktreeRoot = path.join(record.worktreeContainer, "checkout");
		worktreeRoot = record.worktreeRoot;
		withImplementerRegistryLock(commonGitDir, () => {
			writeImplementerLeaseRecord(record);
		}, input.setupDeadlineMilliseconds);
		input.lifecycleHook?.("after-container-recorded");
		mkdirSync(record.worktreeContainer, { mode: 0o700 });
		input.lifecycleHook?.("after-container-created");
		writeFileSync(path.join(record.worktreeContainer, "owner"), `${record.token}\n`, { flag: "wx", mode: 0o600 });
		input.lifecycleHook?.("after-owner-marker-created");
		withImplementerRegistryLock(commonGitDir, () => {
			checkedSetupGit(
				input,
				root,
				["worktree", "add", "--detach", worktreeRoot, baselineHead],
				"Detached implementer worktree creation",
			);
			record.state = "worktree-ready";
			writeImplementerLeaseRecord(record);
			input.lifecycleHook?.("after-worktree-created");
		}, input.setupDeadlineMilliseconds);
		const leaseDirectory = implementerLeaseDirectory(commonGitDir, record.token);
		const confinement = createConfinementState(input, worktreeRoot, baselineHead, leaseDirectory, scope);
		const snapshotIndexFile = path.join(leaseDirectory, "snapshot-index");
		let finalized: WorkspaceReport | undefined;
		let finalizationError: WorkspaceFinalizationError | undefined;

		return {
			cwd: worktreeRoot,
			mode: "git-worktree",
			readOnly: false,
			quiesceProcessGroup: true,
			childLaunchGate: {
				pidFile: confinement.childPidFile,
				readyFile: confinement.childReadyFile,
			},
			childEnvironment: {
				YPI_IMPLEMENT_ROOT: worktreeRoot,
				YPI_IMPLEMENT_AUDIT_FILE: confinement.auditFile,
				YPI_IMPLEMENT_BASELINE_IGNORE_ROOT: confinement.baselineIgnoreRoot,
				YPI_IMPLEMENT_BASELINE_INDEX: confinement.baselineIndexFile,
				YPI_IMPLEMENT_GIT_DIR: confinement.gitDir,
				YPI_IMPLEMENT_SCOPE_FILE: confinement.scopeFile,
				YPI_IMPLEMENT_SUBMODULES_FILE: confinement.submodulePathsFile,
			},
			prepareChildLaunch() {
				if (finalized || finalizationError) {
					throw new Error("Implementer workspace is no longer available for child launch");
				}
				record.childLaunchStartedAtEpochSeconds = Math.floor(Date.now() / 1000);
				persistLeaseRecord(record);
			},
			noteChildPid(pid: number) {
				if (!Number.isSafeInteger(pid) || pid <= 0 || finalized || finalizationError) return;
				record.childPid = pid;
				persistLeaseRecord(record);
			},
			finalize() {
				if (finalized) return finalized;
				if (finalizationError) throw finalizationError;

				let attemptCommit: string | undefined;
				let refVerified = record.state === "ref-verified" || record.state === "worktree-removed";
				let diffStat: string | undefined;
				let changedPaths = bestEffortChangedPaths(worktreeRoot, baselineHead).paths;
				try {
					input.lifecycleHook?.("before-snapshot");
					auditedPaths(confinement, worktreeRoot);
					assertSubmodulesUnchanged(worktreeRoot, confinement.gitlinks);
					assertNoUnsnapshottedIgnoredPaths(worktreeRoot);
					assertCheckoutOwnership(worktreeRoot, baselineHead, baselineTree);
					assertRootCheckoutUntouched(root, baselineHead, baselineTree);

					const snapshotEnvironment = { GIT_INDEX_FILE: snapshotIndexFile };
					finalizationGit(worktreeRoot, ["read-tree", baselineHead], "Snapshot index initialization", snapshotEnvironment);
					finalizationGit(worktreeRoot, ["add", "-A", "--", "."], "Snapshot staging", snapshotEnvironment);
					const snapshotTree = finalizationGit(worktreeRoot, ["write-tree"], "Snapshot tree creation", snapshotEnvironment);
					attemptCommit = finalizationGit(
						worktreeRoot,
						["commit-tree", snapshotTree, "-p", baselineHead, "-m", `ypi implementer attempt ${record.token.slice(0, 12)}`],
						"Snapshot commit creation",
						{
							...snapshotEnvironment,
							GIT_AUTHOR_NAME: "ypi",
							GIT_AUTHOR_EMAIL: "ypi@localhost",
							GIT_COMMITTER_NAME: "ypi",
							GIT_COMMITTER_EMAIL: "ypi@localhost",
						},
					);
					changedPaths = parseNulPaths(finalizationGit(
						worktreeRoot,
						["diff", "--name-only", "-z", "--no-renames", baselineHead, attemptCommit, "--"],
						"Snapshot changed-path report",
						{},
						undefined,
						true,
					));
					assertPathsWithinScope(changedPaths, scope);
					assertSnapshotPathsReviewable(worktreeRoot, changedPaths, confinement);
					diffStat = finalizationGit(
						worktreeRoot,
						["diff", "--stat", "--no-ext-diff", "--no-renames", baselineHead, attemptCommit, "--"],
						"Snapshot diffstat report",
					);

					input.lifecycleHook?.("before-ref-update");
					finalizationGit(
						worktreeRoot,
						["update-ref", record.attemptRef, attemptCommit, "0".repeat(baselineHead.length)],
						"Snapshot ref creation",
					);
					const verifiedCommit = finalizationGit(worktreeRoot, ["rev-parse", "--verify", `${record.attemptRef}^{commit}`], "Snapshot ref verification");
					const verifiedTree = finalizationGit(worktreeRoot, ["rev-parse", `${verifiedCommit}^{tree}`], "Snapshot tree verification");
					if (verifiedCommit !== attemptCommit || verifiedTree !== snapshotTree) {
						throw new Error("Snapshot ref verification did not resolve to the captured tree");
					}
					refVerified = true;
					record.attemptCommit = attemptCommit;
					record.state = "ref-verified";
					persistLeaseRecord(record);
					input.lifecycleHook?.("after-snapshot");

					auditedPaths(confinement, worktreeRoot);
					assertSubmodulesUnchanged(worktreeRoot, confinement.gitlinks);
					assertNoUnsnapshottedIgnoredPaths(worktreeRoot);
					assertCheckoutOwnership(worktreeRoot, baselineHead, baselineTree);
					finalizationGit(worktreeRoot, ["add", "-A", "--", "."], "Pre-removal tree verification staging", snapshotEnvironment);
					const finalWorktreeTree = finalizationGit(worktreeRoot, ["write-tree"], "Pre-removal tree verification", snapshotEnvironment);
					if (finalWorktreeTree !== snapshotTree) {
						throw new Error("Implementer worktree changed after the salvage ref was captured; removal was refused");
					}
					assertRootCheckoutUntouched(root, baselineHead, baselineTree);

					withImplementerRegistryLock(commonGitDir, () => {
						input.lifecycleHook?.("before-worktree-remove");
						finalizationGit(root, ["worktree", "remove", "--force", worktreeRoot], "Ephemeral worktree removal");
						record.state = "worktree-removed";
						writeImplementerLeaseRecord(record);
						input.lifecycleHook?.("before-container-remove");
						if (record.worktreeContainer) rmSync(record.worktreeContainer, { recursive: true, force: true });
						input.lifecycleHook?.("after-worktree-remove");
						removeImplementerLeaseRecord(commonGitDir, record.token);
					});
					assertRootCheckoutUntouched(root, baselineHead, baselineTree);

					finalized = {
						requestedMode: "implement",
						effectiveMode: "implement",
						workspaceMode: "git-worktree",
						workspaceRoot: worktreeRoot,
						baselineHead,
						finalHead: baselineHead,
						changedPaths,
						diffStat,
						attemptRef: record.attemptRef,
						attemptCommit,
						treeRestored: true,
						reportComplete: true,
						leaseId: record.token.slice(0, 12),
						scope,
					};
					return finalized;
				} catch (error) {
					const cause = error instanceof Error ? error.message : String(error);
					const state = bestEffortChangedPaths(worktreeRoot, baselineHead);
					const worktreePresent = existsSync(worktreeRoot);
					const report: WorkspaceReport = {
						requestedMode: "implement",
						effectiveMode: "implement",
						workspaceMode: "git-worktree",
						workspaceRoot: worktreeRoot,
						baselineHead,
						finalHead: state.finalHead,
						changedPaths: uniquePaths(changedPaths, state.paths),
						diffStat,
						attemptRef: refVerified ? record.attemptRef : undefined,
						attemptCommit: refVerified ? attemptCommit || record.attemptCommit : undefined,
						treeRestored: !worktreePresent,
						reportComplete: false,
						reportError: cause,
						leaseId: record.token.slice(0, 12),
						scope,
					};
					const preservation = refVerified
						? `The attempted work has a verified snapshot at ${record.attemptRef}.`
						: `No verified salvage ref is available; the isolated worktree at ${worktreeRoot} remains the primary copy.`;
					finalizationError = new WorkspaceFinalizationError(
						`Implementer worktree finalization failed: ${cause}. ${preservation} The lease remains at ${leaseDirectory}; run rlm_cleanup --repo ${root} only after the owner and child processes stop.`,
						report,
					);
					throw finalizationError;
				}
			},
			cleanup() {},
		};
	} catch (error) {
		const cleanupError = bestEffortDiscardSetupWorktree(root, record);
		if (!cleanupError) {
			try {
				removeSetupLease(record);
			} catch (registryError) {
				const message = registryError instanceof Error ? registryError.message : String(registryError);
				throw new Error(`${error instanceof Error ? error.message : String(error)}. Setup worktree was removed, but lease cleanup failed: ${message}`);
			}
			throw error;
		}
		throw new Error(`${error instanceof Error ? error.message : String(error)}. Setup cleanup failed: ${cleanupError}. Recover the retained lease at ${implementerLeaseDirectory(commonGitDir, record.token)}.`);
	}
}

export function acquireWorkspace(input: WorkspacePolicyInput): WorkspaceLease {
	if (input.mode === "review") return readOnlyLease(input.cwd);
	const scope = normalizeImplementScope(input.scope);
	const gitRootResult = setupGit(input, input.cwd, ["rev-parse", "--show-toplevel"]);
	if (gitRootResult.status !== 0) {
		throw new Error("Implement mode requires an existing clean Git checkout. No version-control system was installed or initialized; continue implementation in the root session.");
	}
	return createGitWorktreeLease(input, output(gitRootResult), scope);
}

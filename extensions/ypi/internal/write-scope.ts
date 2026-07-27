import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMPLEMENT_TOOL_ALLOWLIST } from "./child-config.ts";
import { normalizeImplementScope, pathIsWithinImplementScope } from "./implement-scope.ts";

export interface WriteScopeDecision {
	allowed: boolean;
	absolutePath?: string;
	relativePath?: string;
	reason?: string;
}

interface ImplementWritePolicy {
	auditFile: string;
	baselineIgnoreRoot: string;
	baselineIndexFile: string;
	externalReadFiles: string[];
	gitDir: string;
	scope: string[];
	submodulePaths: string[];
}

const WRITE_POLICY_TIMEOUT_MS = 5_000;
const IMPLEMENT_TOOL_SET = new Set<string>(IMPLEMENT_TOOL_ALLOWLIST);

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(candidate: string): string | undefined {
	let current = candidate;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return current;
}

function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, ...overrides };
}

function checkIgnored(
	root: string,
	relativePath: string,
	baseline: Pick<ImplementWritePolicy, "baselineIgnoreRoot" | "baselineIndexFile" | "gitDir"> | undefined,
): { ignored?: boolean; error?: string } {
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
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		input: `${relativePath}\0`,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: WRITE_POLICY_TIMEOUT_MS,
		env: gitEnvironment(baseline ? { GIT_INDEX_FILE: baseline.baselineIndexFile } : {}),
	});
	if (result.status === 0) return { ignored: true };
	if (result.status === 1) return { ignored: false };
	const message = typeof result.stderr === "string" ? result.stderr.trim() : "";
	return { error: message || "git check-ignore failed" };
}

function readPolicyFromEnvironment(): ImplementWritePolicy | undefined {
	const auditFile = process.env.YPI_IMPLEMENT_AUDIT_FILE;
	const baselineIgnoreRoot = process.env.YPI_IMPLEMENT_BASELINE_IGNORE_ROOT;
	const baselineIndexFile = process.env.YPI_IMPLEMENT_BASELINE_INDEX;
	const gitDir = process.env.YPI_IMPLEMENT_GIT_DIR;
	const scopeFile = process.env.YPI_IMPLEMENT_SCOPE_FILE;
	const submodulePathsFile = process.env.YPI_IMPLEMENT_SUBMODULES_FILE;
	if (!auditFile || !baselineIgnoreRoot || !baselineIndexFile || !gitDir || !scopeFile || !submodulePathsFile) return undefined;
	try {
		const scope = normalizeImplementScope(readFileSync(scopeFile, "utf8").split("\0").filter(Boolean));
		const submodulePaths = readFileSync(submodulePathsFile, "utf8").split("\0").filter(Boolean);
		const externalReadFiles = [
			process.env.CONTEXT,
			process.env.RLM_PROMPT_FILE,
			process.env.RLM_ROOT_PROMPT_FILE,
		].filter((candidate): candidate is string => Boolean(candidate));
		return { auditFile, baselineIgnoreRoot, baselineIndexFile, externalReadFiles, gitDir, scope, submodulePaths };
	} catch {
		return undefined;
	}
}

function isSubmodulePath(relativePath: string, submodulePaths: string[]): boolean {
	return submodulePaths.some((candidate) => relativePath === candidate || relativePath.startsWith(`${candidate}/`));
}

function resolveImplementPath(
	root: string,
	cwd: string,
	requestedPath: unknown,
	operation: "read" | "write",
	externalReadFiles: readonly string[] = [],
): WriteScopeDecision {
	if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.includes("\0")) {
		return { allowed: false, reason: `Implementer ${operation} path is missing or invalid` };
	}
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(root);
	} catch {
		return { allowed: false, reason: "Implementer workspace root is unavailable" };
	}
	const absolutePath = path.resolve(cwd, requestedPath);
	const existing = nearestExistingPath(absolutePath);
	if (!existing) {
		return { allowed: false, absolutePath, reason: `Implementer ${operation} ancestry could not be verified` };
	}
	let canonicalCandidate: string;
	try {
		const realExisting = realpathSync(existing);
		canonicalCandidate = path.resolve(realExisting, path.relative(existing, absolutePath));
	} catch {
		return { allowed: false, absolutePath, reason: `Implementer ${operation} ancestry could not be resolved` };
	}
	if (!isWithin(canonicalRoot, canonicalCandidate)) {
		const isExplicitExternalRead = operation === "read" && externalReadFiles.some((candidate) => {
			try {
				return realpathSync(candidate) === canonicalCandidate;
			} catch {
				return false;
			}
		});
		if (isExplicitExternalRead) return { allowed: true, absolutePath: canonicalCandidate };
		return {
			allowed: false,
			absolutePath,
			reason: `Implementer ${operation} would escape the leased checkout or follow an external symlink`,
		};
	}
	const relative = path.relative(canonicalRoot, canonicalCandidate);
	const components = relative.split(path.sep);
	if (components.includes(".git")) {
		return {
			allowed: false,
			absolutePath,
			reason: operation === "write"
				? "Implementer cannot modify repository metadata"
				: "Implementer cannot read repository metadata",
		};
	}
	const relativePath = components.join("/");
	return { allowed: true, absolutePath, relativePath };
}

export function checkImplementReadPath(
	root: string,
	cwd: string,
	requestedPath: unknown,
	policy?: Pick<ImplementWritePolicy, "externalReadFiles" | "submodulePaths">,
): WriteScopeDecision {
	const decision = resolveImplementPath(root, cwd, requestedPath, "read", policy?.externalReadFiles);
	if (!decision.allowed || !policy || decision.relativePath === undefined) return decision;
	if (isSubmodulePath(decision.relativePath, policy.submodulePaths)) {
		return {
			allowed: false,
			absolutePath: decision.absolutePath,
			relativePath: decision.relativePath,
			reason: "Implementer cannot read a submodule path outside the superproject snapshot boundary",
		};
	}
	return decision;
}

export function checkImplementWritePath(
	root: string,
	cwd: string,
	requestedPath: unknown,
	policy?: ImplementWritePolicy,
): WriteScopeDecision {
	const decision = resolveImplementPath(root, cwd, requestedPath, "write");
	if (!decision.allowed || decision.relativePath === undefined) return decision;
	const { absolutePath, relativePath } = decision;
	if (!policy) return { allowed: true, absolutePath, relativePath };
	const canonicalRoot = realpathSync(root);
	if (!pathIsWithinImplementScope(relativePath, policy.scope)) {
		return { allowed: false, absolutePath, relativePath, reason: `Implementer write is outside its declared scope [${policy.scope.join(", ")}]` };
	}
	if (isSubmodulePath(relativePath, policy.submodulePaths)) {
		return { allowed: false, absolutePath, relativePath, reason: "Implementer cannot modify a submodule path because the superproject cannot snapshot or reset it" };
	}
	const baselineIgnore = checkIgnored(canonicalRoot, relativePath, policy);
	if (baselineIgnore.error) {
		return { allowed: false, absolutePath, relativePath, reason: `Implementer baseline ignore check failed: ${baselineIgnore.error}` };
	}
	if (baselineIgnore.ignored) {
		return { allowed: false, absolutePath, relativePath, reason: "Implementer cannot write a path ignored by the baseline checkout because it cannot be safely rolled back" };
	}
	const finalIgnore = checkIgnored(canonicalRoot, relativePath, undefined);
	if (finalIgnore.error) {
		return { allowed: false, absolutePath, relativePath, reason: `Implementer final ignore check failed: ${finalIgnore.error}` };
	}
	if (finalIgnore.ignored) {
		return { allowed: false, absolutePath, relativePath, reason: "Implementer cannot write an ignored path because it cannot be included in a reviewable snapshot" };
	}
	return { allowed: true, absolutePath, relativePath };
}

function block(reason: string, ctx: { hasUI: boolean; ui: { notify(message: string, level: "warning"): void } }) {
	if (ctx.hasUI) ctx.ui.notify(reason, "warning");
	return { block: true, reason };
}

export function registerImplementWriteScope(pi: ExtensionAPI): void {
	const root = process.env.YPI_IMPLEMENT_ROOT;
	if (!root) return;
	const policy = readPolicyFromEnvironment();
	pi.on("tool_call", (event, ctx) => {
		if (!IMPLEMENT_TOOL_SET.has(event.toolName)) {
			return block(`Implementer tool "${event.toolName}" is outside the explicit confinement allowlist`, ctx);
		}
		if (!policy) return block("Implementer confinement metadata is unavailable", ctx);
		if (event.toolName === "read" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
			const requestedPath = event.toolName === "read" ? event.input.path : event.input.path ?? ".";
			const decision = checkImplementReadPath(root, ctx.cwd, requestedPath, policy);
			if (!decision.allowed) return block(decision.reason || "Implementer read blocked", ctx);
			return undefined;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		const decision = checkImplementWritePath(root, ctx.cwd, event.input.path, policy);
		if (!decision.allowed) return block(decision.reason || "Implementer write blocked", ctx);
		try {
			appendFileSync(policy.auditFile, `${decision.relativePath}\0`, { mode: 0o600 });
		} catch {
			return block("Implementer write audit could not be recorded; the write was blocked", ctx);
		}
		return undefined;
	});
}

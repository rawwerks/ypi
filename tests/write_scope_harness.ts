import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { IMPLEMENT_TOOL_ALLOWLIST } from "../extensions/ypi/internal/child-config.ts";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";
import {
	checkImplementReadPath,
	checkImplementWritePath,
	registerImplementWriteScope,
} from "../extensions/ypi/internal/write-scope.ts";

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}

console.log("\n=== Implementer write-scope harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_write_scope."));
const outside = mkdtempSync(path.join(tmpdir(), "ypi_write_scope_outside."));
mkdirSync(path.join(root, "src"));
mkdirSync(path.join(root, ".git"));
writeFileSync(path.join(root, "src", "existing.ts"), "export {};\n");
writeFileSync(path.join(outside, "secret.txt"), "outside\n");
writeFileSync(path.join(outside, "context.txt"), "delegated context\n");
writeFileSync(path.join(outside, "prompt.txt"), "delegated charter\n");
writeFileSync(path.join(outside, "root-prompt.txt"), "root charter\n");
symlinkSync(outside, path.join(root, "escape"));

record(checkImplementWritePath(root, root, "src/existing.ts").allowed, "existing file inside lease is allowed");
record(checkImplementWritePath(root, root, "src/new.ts").allowed, "new file under verified in-repo parent is allowed");
record(!checkImplementWritePath(root, root, "../outside.ts").allowed, "parent traversal is blocked");
record(!checkImplementWritePath(root, root, path.join(outside, "secret.txt")).allowed, "absolute outside path is blocked");
record(!checkImplementWritePath(root, root, "escape/new.ts").allowed, "symlink escape is blocked");
record(!checkImplementWritePath(root, root, ".git/config").allowed, "Git metadata write is blocked");
record(!checkImplementWritePath(root, root, "").allowed, "empty write path is blocked");
record(checkImplementReadPath(root, root, "src/existing.ts").allowed, "existing file inside lease is readable");
record(!checkImplementReadPath(root, root, path.join(outside, "secret.txt")).allowed, "absolute outside read is blocked");
record(!checkImplementReadPath(root, root, "escape/secret.txt").allowed, "read through an external symlink is blocked");
record(!checkImplementReadPath(root, root, ".git/config").allowed, "Git metadata read is blocked");

function git(cwd: string, ...args: string[]): string {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_AUTHOR_NAME = "ypi-test";
	env.GIT_AUTHOR_EMAIL = "ypi@example.invalid";
	env.GIT_COMMITTER_NAME = "ypi-test";
	env.GIT_COMMITTER_EMAIL = "ypi@example.invalid";
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return String(result.stdout || "").trim();
}

const policyRoot = mkdtempSync(path.join(tmpdir(), "ypi_write_policy."));
git(policyRoot, "init", "-q");
mkdirSync(path.join(policyRoot, "src"));
writeFileSync(path.join(policyRoot, ".gitignore"), "ignored/\n");
writeFileSync(path.join(policyRoot, "src", "existing.ts"), "export {};\n");
git(policyRoot, "add", ".gitignore", "src/existing.ts");
git(policyRoot, "commit", "-qm", "base");
const gitlinkCommit = git(policyRoot, "rev-parse", "HEAD");
git(policyRoot, "update-index", "--add", "--cacheinfo", `160000,${gitlinkCommit},vendor`);
git(policyRoot, "commit", "-qm", "gitlink");
git(policyRoot, "clone", "-q", "--no-checkout", policyRoot, path.join(policyRoot, "vendor"));
git(path.join(policyRoot, "vendor"), "checkout", "-q", gitlinkCommit);

const builtinNames = new Set([
	...createCodingTools(policyRoot).map((tool) => tool.name),
	...createReadOnlyTools(policyRoot).map((tool) => tool.name),
]);
const expectedImplementTools = [...builtinNames].filter((name) => name !== "bash").concat("rlm_query").sort();
record(
	[...IMPLEMENT_TOOL_ALLOWLIST].sort().join(",") === expectedImplementTools.join(","),
	"implementer allowlist is pinned to Pi's actual built-in tool schema minus bash",
	`actual=${expectedImplementTools.join(",")} configured=${IMPLEMENT_TOOL_ALLOWLIST.join(",")}`,
);

const lease = acquireWorkspace({
	cwd: policyRoot,
	childDepth: 1,
	mode: "implement",
	scope: [".gitignore", "ignored", "src", "vendor"],
});
const previousEnvironment = new Map<string, string | undefined>();
for (const [key, value] of Object.entries(lease.childEnvironment)) {
	previousEnvironment.set(key, process.env[key]);
	if (value !== undefined) process.env[key] = value;
}
const taskFiles = new Map<string, string>([
	["CONTEXT", path.join(outside, "context.txt")],
	["RLM_PROMPT_FILE", path.join(outside, "prompt.txt")],
	["RLM_ROOT_PROMPT_FILE", path.join(outside, "root-prompt.txt")],
]);
const previousTaskFiles = new Map<string, string | undefined>();
for (const [key, value] of taskFiles) {
	previousTaskFiles.set(key, process.env[key]);
	process.env[key] = value;
}
let toolCallHandler: ((event: any, ctx: any) => unknown) | undefined;
registerImplementWriteScope({
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		if (event === "tool_call") toolCallHandler = handler;
	},
} as any);
const blocked = await toolCallHandler?.(
	{ toolName: "write", input: { path: path.join(outside, "secret.txt") } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(blocked?.block === true && blocked.reason?.includes("leased checkout") === true, "extension tool-call gate blocks an outside write before execution", JSON.stringify(blocked));
const insideRead = await toolCallHandler?.(
	{ toolName: "read", input: { path: "src/existing.ts" } },
	{ cwd: lease.cwd, hasUI: false },
);
record(insideRead === undefined, "extension gate allows a checkout-local read");
const readOutsideWriteScope = await toolCallHandler?.(
	{ toolName: "read", input: { path: ".gitignore" } },
	{ cwd: lease.cwd, hasUI: false },
);
record(readOutsideWriteScope === undefined, "read access spans the checkout rather than only the write slice");
for (const [key, file] of taskFiles) {
	const taskFileRead = await toolCallHandler?.(
		{ toolName: "read", input: { path: file } },
		{ cwd: lease.cwd, hasUI: false },
	);
	record(taskFileRead === undefined, `${key} remains readable as an explicitly delegated task file`);
}
for (const toolName of ["read", "grep", "find", "ls"]) {
	const input = toolName === "read"
		? { path: path.join(outside, "secret.txt") }
		: { path: outside, pattern: "*" };
	const result = await toolCallHandler?.(
		{ toolName, input },
		{ cwd: lease.cwd, hasUI: false },
	) as { block?: boolean; reason?: string } | undefined;
	record(
		result?.block === true && result.reason?.includes("leased checkout") === true,
		`${toolName} cannot escape the leased checkout`,
		JSON.stringify(result),
	);
}
const defaultSearchRoot = await toolCallHandler?.(
	{ toolName: "grep", input: { pattern: "export" } },
	{ cwd: lease.cwd, hasUI: false },
);
record(defaultSearchRoot === undefined, "search tools without a path default to the leased checkout");
const allowed = await toolCallHandler?.(
	{ toolName: "edit", input: { path: "src/existing.ts" } },
	{ cwd: lease.cwd, hasUI: false },
);
record(allowed === undefined, "extension tool-call gate allows an in-scope edit");
const outsideSlice = await toolCallHandler?.(
	{ toolName: "write", input: { path: "other.txt" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(
	outsideSlice?.block === true && outsideSlice.reason?.includes("declared scope") === true,
	"extension tool-call gate blocks a checkout-local path outside the declared slice",
	JSON.stringify(outsideSlice),
);
const unknown = await toolCallHandler?.(
	{ toolName: "bash", input: { command: "true" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(unknown?.block === true && unknown.reason?.includes("allowlist") === true, "extension gate fails closed on a mutating tool outside the allowlist", JSON.stringify(unknown));
const ignored = await toolCallHandler?.(
	{ toolName: "write", input: { path: "ignored/leak.txt" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(ignored?.block === true && ignored.reason?.includes("ignored") === true, "baseline-ignored path is blocked", JSON.stringify(ignored));
const ignoreEdit = await toolCallHandler?.(
	{ toolName: "edit", input: { path: ".gitignore" } },
	{ cwd: lease.cwd, hasUI: false },
);
record(ignoreEdit === undefined, "tracked ignore rules remain reviewable");
writeFileSync(path.join(lease.cwd, ".gitignore"), "");
const baselineIgnoredAfterRuleEdit = await toolCallHandler?.(
	{ toolName: "write", input: { path: "ignored/leak.txt" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(
	baselineIgnoredAfterRuleEdit?.block === true && baselineIgnoredAfterRuleEdit.reason?.includes("baseline") === true,
	"editing ignore rules cannot expose a baseline-ignored write",
	JSON.stringify(baselineIgnoredAfterRuleEdit),
);
const submoduleWrite = await toolCallHandler?.(
	{ toolName: "write", input: { path: "vendor/inside.txt" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(submoduleWrite?.block === true && submoduleWrite.reason?.includes("submodule") === true, "submodule-path write is blocked", JSON.stringify(submoduleWrite));
const submoduleRead = await toolCallHandler?.(
	{ toolName: "read", input: { path: "vendor/README.md" } },
	{ cwd: lease.cwd, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(submoduleRead?.block === true && submoduleRead.reason?.includes("submodule") === true, "submodule-path read is blocked", JSON.stringify(submoduleRead));
const confinementFile = lease.childEnvironment.YPI_IMPLEMENT_CONFINEMENT_FILE;
const auditFile = confinementFile
	? path.join(path.dirname(confinementFile), "writes")
	: undefined;
record(
	Boolean(auditFile)
		&& existsSync(auditFile!)
		&& readFileSync(auditFile!).toString("utf8").includes("src/existing.ts\0"),
	"allowed writes are recorded outside the worktree",
);
const policyReport = lease.finalize();
lease.cleanup();
record(
	policyReport.treeRestored === true
		&& !existsSync(lease.cwd)
		&& readFileSync(path.join(policyRoot, ".gitignore"), "utf8") === "ignored/\n",
	"write-policy fixture is snapshotted and its ephemeral worktree is removed",
);
for (const [key, value] of previousEnvironment) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
for (const [key, value] of previousTaskFiles) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const implementRootBeforeMissingPolicy = process.env.YPI_IMPLEMENT_ROOT;
process.env.YPI_IMPLEMENT_ROOT = root;
let missingPolicyHandler: ((event: any, ctx: any) => unknown) | undefined;
registerImplementWriteScope({
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		if (event === "tool_call") missingPolicyHandler = handler;
	},
} as any);
const missingPolicyRead = await missingPolicyHandler?.(
	{ toolName: "read", input: { path: "src/existing.ts" } },
	{ cwd: root, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(
	missingPolicyRead?.block === true && missingPolicyRead.reason?.includes("metadata") === true,
	"missing confinement metadata blocks read tools",
	JSON.stringify(missingPolicyRead),
);
if (implementRootBeforeMissingPolicy === undefined) delete process.env.YPI_IMPLEMENT_ROOT;
else process.env.YPI_IMPLEMENT_ROOT = implementRootBeforeMissingPolicy;

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

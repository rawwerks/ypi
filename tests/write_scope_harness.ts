import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { IMPLEMENT_TOOL_ALLOWLIST } from "../extensions/ypi/internal/child-config.ts";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";
import { checkImplementWritePath, registerImplementWriteScope } from "../extensions/ypi/internal/write-scope.ts";

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
symlinkSync(outside, path.join(root, "escape"));

record(checkImplementWritePath(root, root, "src/existing.ts").allowed, "existing file inside lease is allowed");
record(checkImplementWritePath(root, root, "src/new.ts").allowed, "new file under verified in-repo parent is allowed");
record(!checkImplementWritePath(root, root, "../outside.ts").allowed, "parent traversal is blocked");
record(!checkImplementWritePath(root, root, path.join(outside, "secret.txt")).allowed, "absolute outside path is blocked");
record(!checkImplementWritePath(root, root, "escape/new.ts").allowed, "symlink escape is blocked");
record(!checkImplementWritePath(root, root, ".git/config").allowed, "Git metadata write is blocked");
record(!checkImplementWritePath(root, root, "").allowed, "empty write path is blocked");

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

const lease = acquireWorkspace({ cwd: policyRoot, childDepth: 1, mode: "implement" });
const previousEnvironment = new Map<string, string | undefined>();
for (const [key, value] of Object.entries(lease.childEnvironment)) {
	previousEnvironment.set(key, process.env[key]);
	if (value !== undefined) process.env[key] = value;
}
let toolCallHandler: ((event: any, ctx: any) => unknown) | undefined;
registerImplementWriteScope({
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		if (event === "tool_call") toolCallHandler = handler;
	},
} as any);
const blocked = await toolCallHandler?.(
	{ toolName: "write", input: { path: path.join(outside, "secret.txt") } },
	{ cwd: policyRoot, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(blocked?.block === true && blocked.reason?.includes("leased checkout") === true, "extension tool-call gate blocks an outside write before execution", JSON.stringify(blocked));
const allowed = await toolCallHandler?.(
	{ toolName: "edit", input: { path: "src/existing.ts" } },
	{ cwd: policyRoot, hasUI: false },
);
record(allowed === undefined, "extension tool-call gate allows an in-scope edit");
const unknown = await toolCallHandler?.(
	{ toolName: "bash", input: { command: "true" } },
	{ cwd: policyRoot, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(unknown?.block === true && unknown.reason?.includes("allowlist") === true, "extension gate fails closed on a mutating tool outside the allowlist", JSON.stringify(unknown));
const ignored = await toolCallHandler?.(
	{ toolName: "write", input: { path: "ignored/leak.txt" } },
	{ cwd: policyRoot, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(ignored?.block === true && ignored.reason?.includes("ignored") === true, "baseline-ignored path is blocked", JSON.stringify(ignored));
const ignoreEdit = await toolCallHandler?.(
	{ toolName: "edit", input: { path: ".gitignore" } },
	{ cwd: policyRoot, hasUI: false },
);
record(ignoreEdit === undefined, "tracked ignore rules remain reviewable");
writeFileSync(path.join(policyRoot, ".gitignore"), "");
const baselineIgnoredAfterRuleEdit = await toolCallHandler?.(
	{ toolName: "write", input: { path: "ignored/leak.txt" } },
	{ cwd: policyRoot, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(
	baselineIgnoredAfterRuleEdit?.block === true && baselineIgnoredAfterRuleEdit.reason?.includes("baseline") === true,
	"editing ignore rules cannot expose a baseline-ignored write",
	JSON.stringify(baselineIgnoredAfterRuleEdit),
);
const submoduleWrite = await toolCallHandler?.(
	{ toolName: "write", input: { path: "vendor/inside.txt" } },
	{ cwd: policyRoot, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(submoduleWrite?.block === true && submoduleWrite.reason?.includes("submodule") === true, "submodule-path write is blocked", JSON.stringify(submoduleWrite));
const auditFile = lease.childEnvironment.YPI_IMPLEMENT_AUDIT_FILE;
record(
	Boolean(auditFile)
		&& existsSync(auditFile!)
		&& readFileSync(auditFile!).toString("utf8").includes("src/existing.ts\0"),
	"allowed writes are recorded outside the worktree",
);
const policyReport = lease.finalize();
lease.cleanup();
record(policyReport.treeRestored === true && readFileSync(path.join(policyRoot, ".gitignore"), "utf8") === "ignored/\n", "write-policy fixture is snapshotted and restored");
for (const [key, value] of previousEnvironment) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

let toolCallHandler: ((event: any, ctx: any) => unknown) | undefined;
process.env.YPI_IMPLEMENT_ROOT = root;
registerImplementWriteScope({
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		if (event === "tool_call") toolCallHandler = handler;
	},
} as any);
delete process.env.YPI_IMPLEMENT_ROOT;
const blocked = await toolCallHandler?.(
	{ toolName: "write", input: { path: path.join(outside, "secret.txt") } },
	{ cwd: root, hasUI: false },
) as { block?: boolean; reason?: string } | undefined;
record(blocked?.block === true && blocked.reason?.includes("leased checkout") === true, "extension tool-call gate blocks an outside write before execution", JSON.stringify(blocked));
const allowed = await toolCallHandler?.(
	{ toolName: "edit", input: { path: "src/existing.ts" } },
	{ cwd: root, hasUI: false },
);
record(allowed === undefined, "extension tool-call gate allows an in-scope edit");

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

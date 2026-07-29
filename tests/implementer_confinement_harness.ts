import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION } from "../extensions/ypi/internal/implementer-confinement.ts";
import {
	capturePrivateDirectoryIdentity,
	capturePrivateFileIdentity,
} from "../extensions/ypi/internal/private-path.ts";
import { registerImplementWriteScope } from "../extensions/ypi/internal/write-scope.ts";

type ToolHandler = (
	event: { toolName: string; input: { path: string } },
	context: {
		cwd: string;
		hasUI: boolean;
		ui: { notify(message: string, level: "warning"): void };
	},
) => unknown;

interface Fixture {
	root: string;
	audit: string;
	baselineIgnoreRoot: string;
	confinement: string;
	scope: string;
	submodules: string;
}

const repository = path.resolve(import.meta.dir, "..");
let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "ypi-confinement."));
	chmodSync(root, 0o700);
	const audit = path.join(root, "writes");
	const baselineIgnoreRoot = path.join(root, "baseline-ignore");
	const confinement = path.join(root, "confinement.json");
	const scope = path.join(root, "scope");
	const submodules = path.join(root, "submodules");
	mkdirSync(baselineIgnoreRoot, { mode: 0o700 });
	writeFileSync(audit, "", { mode: 0o600 });
	writeFileSync(scope, "README.md", { mode: 0o600 });
	writeFileSync(submodules, "", { mode: 0o600 });
	writeFileSync(
		confinement,
		`${JSON.stringify({
			schemaVersion: IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION,
			gitDir: path.join(repository, ".git"),
			leaseDirectoryIdentity: capturePrivateDirectoryIdentity(root),
			resources: {
				writes: capturePrivateFileIdentity(audit),
				scope: capturePrivateFileIdentity(scope),
				submodules: capturePrivateFileIdentity(submodules),
				"baseline-ignore": capturePrivateDirectoryIdentity(baselineIgnoreRoot),
			},
		}, null, 2)}\n`,
		{ mode: 0o600 },
	);
	return { root, audit, baselineIgnoreRoot, confinement, scope, submodules };
}

function activate(value: Fixture): void {
	process.env.YPI_IMPLEMENT_ROOT = repository;
	process.env.YPI_IMPLEMENT_CONFINEMENT_FILE = value.confinement;
	process.env.YPI_IMPLEMENT_CONFINEMENT_IDENTITY = JSON.stringify(
		capturePrivateFileIdentity(value.confinement),
	);
}

function decision(handler: ToolHandler): { block?: boolean; reason?: string } {
	return handler(
		{ toolName: "edit", input: { path: "README.md" } },
		{
			cwd: repository,
			hasUI: false,
			ui: { notify() {} },
		},
	) as { block?: boolean; reason?: string };
}

let handler: ToolHandler | undefined;
process.env.YPI_IMPLEMENT_ROOT = repository;
registerImplementWriteScope({
	on(event: string, candidate: ToolHandler) {
		if (event === "tool_call") handler = candidate;
	},
} as never);
if (!handler) throw new Error("write-scope hook was not registered");

console.log("\n=== Implementer confinement generation harness ===");

{
	const value = fixture();
	activate(value);
	const moved = `${value.audit}.owned`;
	const canary = path.join(value.root, "audit-canary");
	writeFileSync(canary, "CANARY\n", { mode: 0o600 });
	renameSync(value.audit, moved);
	symlinkSync(canary, value.audit);
	const result = decision(handler);
	record(
		result.block === true
			&& readFileSync(canary, "utf8") === "CANARY\n"
			&& readFileSync(moved, "utf8") === "",
		"a replaced audit resource blocks the write and preserves both targets",
		result.reason,
	);
	rmSync(value.root, { recursive: true, force: true });
}

for (const resource of ["scope", "submodules"] as const) {
	const value = fixture();
	activate(value);
	const target = value[resource];
	const moved = `${target}.owned`;
	const original = readFileSync(target, "utf8");
	renameSync(target, moved);
	writeFileSync(target, original, { mode: 0o600 });
	const result = decision(handler);
	record(
		result.block === true
			&& readFileSync(moved, "utf8") === original
			&& readFileSync(target, "utf8") === original,
		`a copied ${resource} replacement is not adopted`,
		result.reason,
	);
	rmSync(value.root, { recursive: true, force: true });
}

{
	const value = fixture();
	activate(value);
	const onlyCopy = path.join(value.baselineIgnoreRoot, "late-only-copy");
	writeFileSync(onlyCopy, "PRESERVE\n", { mode: 0o600 });
	const result = decision(handler);
	record(
		result.block === true && readFileSync(onlyCopy, "utf8") === "PRESERVE\n",
		"an undeclared baseline-ignore entry blocks the write and survives",
		result.reason,
	);
	rmSync(value.root, { recursive: true, force: true });
}

{
	const value = fixture();
	activate(value);
	const moved = `${value.confinement}.owned`;
	const canary = path.join(value.root, "manifest-canary");
	writeFileSync(canary, "PRESERVE\n", { mode: 0o600 });
	renameSync(value.confinement, moved);
	symlinkSync(canary, value.confinement);
	const result = decision(handler);
	record(
		result.block === true
			&& readFileSync(canary, "utf8") === "PRESERVE\n"
			&& readFileSync(moved, "utf8").includes('"schemaVersion": 1'),
		"a replaced confinement manifest blocks the write without following it",
		result.reason,
	);
	rmSync(value.root, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	capturePrivateDirectoryIdentity,
	capturePrivateFileIdentity,
	readOwnedPrivateFile,
} from "../extensions/ypi/internal/private-path.ts";
import { IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION } from "../extensions/ypi/internal/implementer-confinement.ts";
import { registerImplementWriteScope } from "../extensions/ypi/internal/write-scope.ts";

type ToolHandler = (
	event: { toolName: string; input: { path: string } },
	context: {
		cwd: string;
		hasUI: boolean;
		ui: { notify(message: string, level: "warning"): void };
	},
) => unknown;

const repository = "/home/ruslan/code/ruslanvasylev/ypi";
const root = mkdtempSync(path.join(tmpdir(), "ypi-n89-treatment."));
chmodSync(root, 0o700);
const audit = path.join(root, "writes");
const movedAudit = path.join(root, "writes.owned");
const canary = path.join(root, "canary");
const scope = path.join(root, "scope");
const submodules = path.join(root, "submodules");
const baselineIgnoreRoot = path.join(root, "baseline-ignore");
const confinement = path.join(root, "confinement.json");
mkdirSync(baselineIgnoreRoot, { mode: 0o700 });
writeFileSync(audit, "", { mode: 0o600 });
const auditIdentity = capturePrivateFileIdentity(audit);
writeFileSync(canary, "CANARY\n", { mode: 0o600 });
writeFileSync(scope, "README.md", { mode: 0o600 });
writeFileSync(submodules, "", { mode: 0o600 });
writeFileSync(
	confinement,
	`${JSON.stringify({
		schemaVersion: IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION,
		gitDir: path.join(repository, ".git"),
		leaseDirectoryIdentity: capturePrivateDirectoryIdentity(root),
		resources: {
			writes: auditIdentity,
			scope: capturePrivateFileIdentity(scope),
			submodules: capturePrivateFileIdentity(submodules),
			"baseline-ignore": capturePrivateDirectoryIdentity(baselineIgnoreRoot),
		},
	}, null, 2)}\n`,
	{ mode: 0o600 },
);

process.env.YPI_IMPLEMENT_ROOT = repository;
process.env.YPI_IMPLEMENT_CONFINEMENT_FILE = confinement;
process.env.YPI_IMPLEMENT_CONFINEMENT_IDENTITY = JSON.stringify(
	capturePrivateFileIdentity(confinement),
);

let handler: ToolHandler | undefined;
registerImplementWriteScope({
	on(event: string, candidate: ToolHandler) {
		if (event === "tool_call") handler = candidate;
	},
} as never);
if (!handler) throw new Error("write-scope hook was not registered");

renameSync(audit, movedAudit);
symlinkSync(canary, audit);
const result = handler(
	{ toolName: "edit", input: { path: "README.md" } },
	{
		cwd: repository,
		hasUI: false,
		ui: { notify() {} },
	},
);

const blocked = result as { block?: boolean; reason?: string } | undefined;
let finalReadError = "";
try {
	readOwnedPrivateFile(audit, auditIdentity);
} catch (error) {
	finalReadError = error instanceof Error ? error.message : String(error);
}
const outcome = {
	blocked: blocked?.block === true,
	reason: blocked?.reason,
	canaryBytes: readFileSync(canary, "utf8"),
	ownedAuditBytes: readFileSync(movedAudit, "utf8"),
	finalReadError,
};
console.log(JSON.stringify(outcome));
if (
	!outcome.blocked
		|| !outcome.reason?.includes("Implementer confinement metadata is unavailable")
	|| outcome.canaryBytes !== "CANARY\n"
	|| outcome.ownedAuditBytes !== ""
	|| !outcome.finalReadError.includes("not a regular file")
) {
	process.exitCode = 1;
}

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireChildResources } from "../extensions/ypi/internal/child-resources.ts";

const baselineHead = "1".repeat(40);
const baselineTree = "2".repeat(40);
const attemptCommit = "3".repeat(40);
const fixture = mkdtempSync(path.join(tmpdir(), "ypi_private_lifecycle."));
const root = path.join(fixture, "checkout");
const common = path.join(fixture, "common");
const bin = path.join(fixture, "bin");
const systemPrompt = path.join(fixture, "system.md");
mkdirSync(root);
mkdirSync(common);
mkdirSync(bin);
writeFileSync(systemPrompt, "system\n", { mode: 0o600 });

const fakeGit = path.join(bin, "git");
writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let args = process.argv.slice(2);
while (args[0] === "-c") args = args.slice(2);
const root = process.env.YPI_FAKE_GIT_ROOT;
const common = process.env.YPI_FAKE_GIT_COMMON;
const head = "${baselineHead}";
const tree = "${baselineTree}";
const attempt = "${attemptCommit}";
const command = args[0];
if (command === "config") process.exit(1);
if (command === "status" || command === "add" || command === "update-ref") process.exit(0);
if (command === "read-tree") {
  if (process.env.GIT_INDEX_FILE) fs.writeFileSync(process.env.GIT_INDEX_FILE, "index");
  process.exit(0);
}
if (command === "rev-parse") {
  if (args.includes("--show-toplevel")) process.stdout.write(root + "\\n");
  else if (args.includes("--git-common-dir") || args.includes("--absolute-git-dir")) process.stdout.write(common + "\\n");
  else if (args.includes("--git-path")) process.stdout.write(path.join(common, args.at(-1)) + "\\n");
  else if (args.includes("--verify")) process.stdout.write(attempt + "\\n");
  else if (args.at(-1).endsWith("^{tree}")) process.stdout.write(tree + "\\n");
  else process.stdout.write(head + "\\n");
  process.exit(0);
}
if (command === "worktree") {
  const checkout = args.at(-2);
  if (args[1] === "add") fs.mkdirSync(checkout, { recursive: true });
  if (args[1] === "remove") fs.rmSync(args.at(-1), { recursive: true, force: true });
  process.exit(0);
}
if (command === "ls-tree" || command === "ls-files" || command === "diff") process.exit(0);
if (command === "check-ignore") process.exit(1);
if (command === "write-tree") {
  process.stdout.write(tree + "\\n");
  process.exit(0);
}
if (command === "commit-tree") {
  process.stdout.write(attempt + "\\n");
  process.exit(0);
}
process.stderr.write("unexpected fake Git command: " + JSON.stringify(args) + "\\n");
process.exit(99);
`, { mode: 0o755 });
chmodSync(fakeGit, 0o755);

function mode(candidate: string): number {
	return statSync(candidate).mode & 0o777;
}

function assertMode(candidate: string, expected: number): void {
	const actual = mode(candidate);
	if (actual !== expected) {
		throw new Error(`${candidate} mode=${actual.toString(8)} expected=${expected.toString(8)}`);
	}
}

const previous = {
	path: process.env.PATH,
	root: process.env.YPI_FAKE_GIT_ROOT,
	common: process.env.YPI_FAKE_GIT_COMMON,
	shared: process.env.RLM_SHARED_SESSIONS,
	required: process.env.RLM_REQUIRE_TRANSCRIPTS,
};
process.env.PATH = `${bin}:${previous.path || ""}`;
process.env.YPI_FAKE_GIT_ROOT = root;
process.env.YPI_FAKE_GIT_COMMON = common;
process.env.RLM_SHARED_SESSIONS = "0";
process.env.RLM_REQUIRE_TRANSCRIPTS = "0";
const requestedUmask = Number.parseInt(process.env.PRIVATE_LIFECYCLE_UMASK || "777", 8);
const priorUmask = process.umask(requestedUmask);

let lease: ReturnType<typeof acquireChildResources> | undefined;
let workspaceRoot = "";
let workspaceContainer = "";
try {
	lease = acquireChildResources({
		prompt: "edit fixture",
		context: "private context",
		cwd: root,
		childDepth: 1,
		callCount: 1,
		systemPromptPath: systemPrompt,
		fullResourceIsolation: true,
		mode: "implement",
		scope: ["fixture.txt"],
	});
	workspaceRoot = lease.workspace.cwd;
	workspaceContainer = path.dirname(workspaceRoot);

	for (const file of [
		lease.promptFile,
		lease.contextFile!,
		lease.standaloneSystemPromptFile!,
		path.join(workspaceContainer, "owner"),
	]) {
		assertMode(file, 0o600);
		assertMode(path.dirname(file), 0o700);
	}
	assertMode(lease.isolatedPiRoot!, 0o700);
	assertMode(path.join(lease.isolatedPiRoot!, "agent"), 0o700);
	assertMode(workspaceRoot, 0o700);

	const leaseRoot = path.join(common, "ypi-implementers", "leases");
	assertMode(path.join(common, "ypi-implementers"), 0o700);
	assertMode(leaseRoot, 0o700);
	const active = readdirSync(leaseRoot);
	if (active.length !== 1) throw new Error(`expected one implementer lease, found ${active.length}`);
	const leaseDirectory = path.join(leaseRoot, active[0]);
	assertMode(leaseDirectory, 0o700);
		for (const file of ["lease.json", "writes", "scope", "submodules", "confinement.json"]) {
		assertMode(path.join(leaseDirectory, file), 0o600);
	}
	assertMode(path.join(leaseDirectory, "baseline-ignore"), 0o700);

	const report = lease.workspace.finalize();
	if (!report.reportComplete || report.attemptCommit !== attemptCommit) {
		throw new Error(`workspace report is incomplete: ${JSON.stringify(report)}`);
	}
	const cleanupFailures = lease.cleanup();
	if (cleanupFailures.length > 0) {
		throw new Error(`resource cleanup failed: ${cleanupFailures.map((item) => item.message).join("; ")}`);
	}
	if (existsSync(workspaceContainer)) throw new Error("workspace container survived successful cleanup");
	if (existsSync(path.dirname(lease.promptFile))) throw new Error("prompt resource survived cleanup");
	if (existsSync(path.dirname(lease.contextFile!))) throw new Error("context resource survived cleanup");
	if (existsSync(path.dirname(lease.standaloneSystemPromptFile!))) throw new Error("system resource survived cleanup");
	if (existsSync(lease.isolatedPiRoot!)) throw new Error("isolated Pi resource survived cleanup");
	console.log(`PASS umask ${requestedUmask.toString(8)} input-to-finalization lifecycle`);
} finally {
	process.umask(priorUmask);
	if (lease) {
		try { lease.cleanup(); } catch {}
	}
	if (previous.path === undefined) delete process.env.PATH;
	else process.env.PATH = previous.path;
	for (const [name, value] of [
		["YPI_FAKE_GIT_ROOT", previous.root],
		["YPI_FAKE_GIT_COMMON", previous.common],
		["RLM_SHARED_SESSIONS", previous.shared],
		["RLM_REQUIRE_TRANSCRIPTS", previous.required],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(fixture, { recursive: true, force: true });
}

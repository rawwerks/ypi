import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";

const baselineHead = "1".repeat(40);
const baselineTree = "2".repeat(40);
const attemptCommit = "3".repeat(40);
const fixture = mkdtempSync(path.join(tmpdir(), "ypi_workspace_git_buffer."));
const root = path.join(fixture, "checkout");
const common = path.join(fixture, "common");
const bin = path.join(fixture, "bin");
const log = path.join(fixture, "git.log");
mkdirSync(root);
mkdirSync(common);
mkdirSync(bin);

const fakeGit = path.join(bin, "git");
writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let args = process.argv.slice(2);
while (args[0] === "-c") args = args.slice(2);
fs.appendFileSync(process.env.YPI_FAKE_GIT_LOG, JSON.stringify(args) + "\\n");
const root = process.env.YPI_FAKE_GIT_ROOT;
const common = process.env.YPI_FAKE_GIT_COMMON;
const head = "${baselineHead}";
const tree = "${baselineTree}";
const attempt = "${attemptCommit}";
const command = args[0];
if (command === "config") process.exit(1);
if (command === "status" || command === "read-tree" || command === "add" || command === "update-ref") process.exit(0);
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
  if (args[1] === "add") fs.mkdirSync(args.at(-2), { recursive: true });
  if (args[1] === "remove") fs.rmSync(args.at(-1), { recursive: true, force: true });
  process.exit(0);
}
if (command === "ls-tree") {
  fs.writeSync(1, Buffer.alloc(2 * 1024 * 1024, "x"));
  process.exit(0);
}
if (command === "ls-files") process.exit(0);
if (command === "check-ignore") process.exit(1);
if (command === "write-tree") {
  process.stdout.write(tree + "\\n");
  process.exit(0);
}
if (command === "commit-tree") {
  process.stdout.write(attempt + "\\n");
  process.exit(0);
}
if (command === "diff") process.exit(0);
process.stderr.write("unexpected fake Git command: " + JSON.stringify(args) + "\\n");
process.exit(99);
`, { mode: 0o755 });
chmodSync(fakeGit, 0o755);

const previous = {
	path: process.env.PATH,
	root: process.env.YPI_FAKE_GIT_ROOT,
	common: process.env.YPI_FAKE_GIT_COMMON,
	log: process.env.YPI_FAKE_GIT_LOG,
};
process.env.PATH = `${bin}:${previous.path || ""}`;
process.env.YPI_FAKE_GIT_ROOT = root;
process.env.YPI_FAKE_GIT_COMMON = common;
process.env.YPI_FAKE_GIT_LOG = log;

let outcome: "completed" | "failed" = "failed";
let failure = "";
try {
	const lease = acquireWorkspace({
		cwd: root,
		childDepth: 1,
		mode: "implement",
		scope: ["fixture.txt"],
	});
	const report = lease.finalize();
	outcome = report.reportComplete && report.treeRestored ? "completed" : "failed";
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
} finally {
	if (previous.path === undefined) delete process.env.PATH;
	else process.env.PATH = previous.path;
	for (const [name, value] of [
		["YPI_FAKE_GIT_ROOT", previous.root],
		["YPI_FAKE_GIT_COMMON", previous.common],
		["YPI_FAKE_GIT_LOG", previous.log],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

const commands = existsSync(log)
	? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
	: [];
const reachedLargeInventory = commands.some((args) => args[0] === "ls-tree");
const expectFailure = process.env.EXPECT_BUFFER_FAILURE === "1";
const passed = reachedLargeInventory && (expectFailure
	? outcome === "failed" && failure.includes("Baseline ignore-rule inventory failed")
	: outcome === "completed");

console.log(JSON.stringify({
	outcome,
	reachedLargeInventory,
	failure,
	temporaryGitMetadataOnly: !existsSync(path.join(root, ".git")),
}));
rmSync(fixture, { recursive: true, force: true });
if (!passed) process.exit(1);

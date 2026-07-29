import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireWorkspace } from "../extensions/ypi/internal/workspace-policy.ts";

const baselineHead = "1".repeat(40);
const baselineTree = "2".repeat(40);
const attemptCommit = "3".repeat(40);
const fixture = mkdtempSync(path.join(tmpdir(), "ypi_workspace_container_replacement."));
const root = path.join(fixture, "checkout");
const common = path.join(fixture, "common");
const bin = path.join(fixture, "bin");
mkdirSync(root);
mkdirSync(common);
mkdirSync(bin);

const fakeGit = path.join(bin, "git");
writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
let args = process.argv.slice(2);
while (args[0] === "-c") args = args.slice(2);
const root = process.env.YPI_FAKE_GIT_ROOT;
const common = process.env.YPI_FAKE_GIT_COMMON;
const registration = path.join(common, "registered-worktree");
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
  if (args[1] === "add") {
    fs.mkdirSync(args.at(-2), { recursive: true });
    fs.writeFileSync(registration, args.at(-2));
  }
  if (args[1] === "remove") {
    fs.rmSync(args.at(-1), { recursive: true, force: true });
    if (process.env.YPI_FAKE_RETAIN_REGISTRATION !== "1") {
      fs.rmSync(registration, { force: true });
    }
  }
  if (args[1] === "list") {
    process.stdout.write("worktree " + root + "\\0\\0");
    if (fs.existsSync(registration)) {
      process.stdout.write("worktree " + fs.readFileSync(registration, "utf8") + "\\0\\0");
    }
  }
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

const previous = {
	path: process.env.PATH,
	root: process.env.YPI_FAKE_GIT_ROOT,
	common: process.env.YPI_FAKE_GIT_COMMON,
	retainRegistration: process.env.YPI_FAKE_RETAIN_REGISTRATION,
};
process.env.PATH = `${bin}:${previous.path || ""}`;
process.env.YPI_FAKE_GIT_ROOT = root;
process.env.YPI_FAKE_GIT_COMMON = common;

let writerRoot = "";
let replacement = "";
let reportComplete = false;
let failure = "";
const replacementTarget = process.env.REPLACE_TARGET === "checkout"
	? "checkout"
	: process.env.REPLACE_TARGET === "registration"
		? "registration"
		: process.env.REPLACE_TARGET === "setup-registration"
			? "setup-registration"
		: "container";
if (
	replacementTarget === "registration"
	|| replacementTarget === "setup-registration"
) {
	process.env.YPI_FAKE_RETAIN_REGISTRATION = "1";
}
try {
	const lease = acquireWorkspace({
		cwd: root,
		childDepth: 1,
		mode: "implement",
		scope: ["fixture.txt"],
		lifecycleHook(stage) {
			if (
				replacementTarget === "setup-registration"
				&& stage === "after-worktree-created"
			) {
				throw new Error("synthetic setup failure after worktree creation");
			}
			if (
				replacementTarget === "registration"
				|| replacementTarget === "setup-registration"
			) return;
			if (
				(replacementTarget === "container" && stage !== "before-container-remove")
				|| (replacementTarget === "checkout" && stage !== "before-worktree-remove")
			) return;
			const target = replacementTarget === "container"
				? path.dirname(writerRoot)
				: writerRoot;
			rmSync(target, { recursive: true, force: true });
			mkdirSync(target, { mode: 0o700 });
			replacement = path.join(target, "only-copy.txt");
			writeFileSync(replacement, "must survive uncertain replacement\n", { mode: 0o600 });
		},
	});
	writerRoot = lease.cwd;
	reportComplete = lease.finalize().reportComplete;
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
} finally {
	if (previous.path === undefined) delete process.env.PATH;
	else process.env.PATH = previous.path;
	for (const [name, value] of [
		["YPI_FAKE_GIT_ROOT", previous.root],
		["YPI_FAKE_GIT_COMMON", previous.common],
		["YPI_FAKE_RETAIN_REGISTRATION", previous.retainRegistration],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

const replacementSurvived = replacement !== "" && existsSync(replacement);
const registrationRetained = existsSync(path.join(common, "registered-worktree"));
console.log(JSON.stringify({
	reportComplete,
	replacementSurvived,
	replacementTarget,
	registrationRetained,
	failure,
	temporaryGitMetadataOnly: !existsSync(path.join(root, ".git")),
}));
rmSync(fixture, { recursive: true, force: true });

const expectDeletion = process.env.EXPECT_REPLACEMENT_DELETION === "1";
const passed = replacementTarget === "registration"
	? !reportComplete
		&& registrationRetained
		&& failure.includes("recorded worktree remains registered")
	: replacementTarget === "setup-registration"
		? !reportComplete
			&& registrationRetained
			&& failure.includes(
				"Setup cleanup failed: recorded worktree remains registered",
			)
	: expectDeletion
	? reportComplete && !replacementSurvived
	: !reportComplete
		&& replacementSurvived
		&& failure.includes(
			replacementTarget === "container"
				? "workspace container identity changed"
				: "recorded checkout identity changed",
		);
if (!passed) {
	process.exit(1);
}

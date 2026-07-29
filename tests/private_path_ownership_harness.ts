import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
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
import { acquireChildResources } from "../extensions/ypi/internal/child-resources.ts";
import { resolveContextSource } from "../extensions/ypi/internal/cli-input.ts";
import {
	createOwnedPrivateTempDirectory,
	retireOwnedPrivateTree,
	sealOwnedPrivateDirectory,
	writeOwnedPrivateFile,
} from "../extensions/ypi/internal/private-path.ts";
import { createRootPromptLease } from "../extensions/ypi/internal/root-prompt.ts";

if (process.argv[2] === "--cli-replacement") {
	process.env.RLM_STDIN = "1";
	const source = await resolveContextSource();
	if (!source.contextPath || !source.cleanup) throw new Error("CLI replacement probe did not spool stdin");
	const ownedDirectory = path.dirname(source.contextPath);
	const movedOwned = `${ownedDirectory}.owned`;
	renameSync(ownedDirectory, movedOwned);
	mkdirSync(ownedDirectory, { mode: 0o700 });
	const canary = path.join(ownedDirectory, "unrelated-only-copy");
	writeFileSync(canary, "must survive\n", { mode: 0o600 });
	let cleanupError = "";
	try {
		source.cleanup();
	} catch (error) {
		cleanupError = error instanceof Error ? error.message : String(error);
	}
	const result = {
		cleanupError,
		replacementDirectoryExists: existsSync(ownedDirectory),
		canaryBytes: readFileSync(canary, "utf8"),
		movedContextBytes: readFileSync(path.join(movedOwned, "context.bin"), "utf8"),
	};
	rmSync(movedOwned, { recursive: true, force: true });
	rmSync(ownedDirectory, { recursive: true, force: true });
	console.log(JSON.stringify(result));
	process.exit(0);
}

let passed = 0;
let failed = 0;

function record(condition: boolean, label: string, detail = ""): void {
	if (condition) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function thrown(action: () => void): string {
	try {
		action();
		return "";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const scratch = mkdtempSync(path.join(tmpdir(), "ypi_private_ownership."));
chmodSync(scratch, 0o700);
const previousTmp = process.env.TMPDIR;
const previousShared = process.env.RLM_SHARED_SESSIONS;
const previousRequired = process.env.RLM_REQUIRE_TRANSCRIPTS;
const previousDepth = process.env.RLM_DEPTH;
const previousStdin = process.env.RLM_STDIN;

try {
	const normal = createOwnedPrivateTempDirectory(path.join(scratch, "normal."));
	const normalFile = path.join(normal.path, "owned.txt");
	writeFileSync(normalFile, "owned\n", { mode: 0o600 });
	const normalTree = sealOwnedPrivateDirectory(normal, ["owned.txt"]);
	retireOwnedPrivateTree(normalTree);
	record(!existsSync(normal.path), "declared exact private tree retires normally");

	const nested = createOwnedPrivateTempDirectory(path.join(scratch, "nested."));
	mkdirSync(path.join(nested.path, "a"), { mode: 0o700 });
	mkdirSync(path.join(nested.path, "a", "b"), { mode: 0o700 });
	writeFileSync(path.join(nested.path, "a", "b", "owned.txt"), "owned\n", { mode: 0o600 });
	const nestedTree = sealOwnedPrivateDirectory(
		nested,
		["a", "a/b", "a/b/owned.txt"],
	);
	retireOwnedPrivateTree(nestedTree);
	record(!existsSync(nested.path), "declared nested private tree retires deepest-first");

	const late = createOwnedPrivateTempDirectory(path.join(scratch, "late."));
	const lateOwnedFile = path.join(late.path, "owned.txt");
	const lateCanary = path.join(late.path, "late-only-copy.txt");
	writeFileSync(lateOwnedFile, "owned\n", { mode: 0o600 });
	const lateTree = sealOwnedPrivateDirectory(late, ["owned.txt"]);
	const lateError = thrown(() => retireOwnedPrivateTree(lateTree, {
		afterEligibilityInventory() {
			writeFileSync(lateCanary, "must survive\n", { mode: 0o600 });
		},
	}));
	record(
		Boolean(lateError)
			&& existsSync(late.path)
			&& readFileSync(lateOwnedFile, "utf8") === "owned\n"
			&& readFileSync(lateCanary, "utf8") === "must survive\n",
		"post-eligibility injection preserves every declared and undeclared entry",
		lateError,
	);
	rmSync(late.path, { recursive: true, force: true });

	const lateReplacement = createOwnedPrivateTempDirectory(
		path.join(scratch, "late-replacement."),
	);
	const lateReplacementFile = path.join(lateReplacement.path, "owned.txt");
	const movedLateReplacementFile = `${lateReplacementFile}.owned`;
	writeFileSync(lateReplacementFile, "owned\n", { mode: 0o600 });
	const lateReplacementTree = sealOwnedPrivateDirectory(
		lateReplacement,
		["owned.txt"],
	);
	const lateReplacementError = thrown(() => retireOwnedPrivateTree(
		lateReplacementTree,
		{
			afterEligibilityInventory() {
				renameSync(lateReplacementFile, movedLateReplacementFile);
				writeFileSync(lateReplacementFile, "must survive\n", { mode: 0o600 });
			},
		},
	));
	record(
		Boolean(lateReplacementError)
			&& readFileSync(lateReplacementFile, "utf8") === "must survive\n"
			&& readFileSync(movedLateReplacementFile, "utf8") === "owned\n",
		"post-eligibility declared-path replacement preserves both generations",
		lateReplacementError,
	);
	rmSync(lateReplacement.path, { recursive: true, force: true });

	const unknown = createOwnedPrivateTempDirectory(path.join(scratch, "unknown."));
	const declared = path.join(unknown.path, "owned.txt");
	const undeclared = path.join(unknown.path, "undeclared.txt");
	writeFileSync(declared, "owned\n", { mode: 0o600 });
	writeFileSync(undeclared, "must survive\n", { mode: 0o600 });
	const unknownError = thrown(() => sealOwnedPrivateDirectory(unknown, ["owned.txt"]));
	record(
		unknownError.includes("does not match declared entries")
			&& readFileSync(undeclared, "utf8") === "must survive\n",
		"undeclared private entry blocks ownership sealing and survives",
		unknownError,
	);
	rmSync(unknown.path, { recursive: true, force: true });

	const replaced = createOwnedPrivateTempDirectory(path.join(scratch, "replaced."));
	const replacedFile = path.join(replaced.path, "owned.txt");
	writeFileSync(replacedFile, "owned\n", { mode: 0o600 });
	const replacedTree = sealOwnedPrivateDirectory(replaced, ["owned.txt"]);
	const movedReplaced = `${replaced.path}.owned`;
	renameSync(replaced.path, movedReplaced);
	mkdirSync(replaced.path, { mode: 0o700 });
	const replacedCanary = path.join(replaced.path, "unrelated-only-copy");
	writeFileSync(replacedCanary, "must survive\n", { mode: 0o600 });
	const replacementError = thrown(() => retireOwnedPrivateTree(replacedTree));
	record(
		replacementError.includes("identity changed")
			&& existsSync(replaced.path)
			&& readFileSync(replacedCanary, "utf8") === "must survive\n"
			&& readFileSync(path.join(movedReplaced, "owned.txt"), "utf8") === "owned\n",
		"root replacement blocks retirement and preserves both trees",
		replacementError,
	);
	rmSync(movedReplaced, { recursive: true, force: true });
	rmSync(replaced.path, { recursive: true, force: true });

	const preverification = createOwnedPrivateTempDirectory(
		path.join(scratch, "preverification."),
	);
	const preverificationFile = path.join(preverification.path, "owned.txt");
	const movedPreverificationFile = `${preverificationFile}.owned`;
	writeFileSync(preverificationFile, "owned generation\n", { mode: 0o600 });
	const preverificationTree = sealOwnedPrivateDirectory(
		preverification,
		["owned.txt"],
	);
	const expectedFile = preverificationTree.entries.get("owned.txt");
	if (!expectedFile) throw new Error("owned-file identity is unavailable");
	const preverificationError = thrown(() => writeOwnedPrivateFile(
		preverificationFile,
		expectedFile,
		"new contents\n",
		{
			beforeOpen() {
				renameSync(preverificationFile, movedPreverificationFile);
				writeFileSync(
					preverificationFile,
					"successor only copy\n",
					{ mode: 0o600 },
				);
			},
		},
	));
	record(
		preverificationError.includes("identity changed")
			&& readFileSync(movedPreverificationFile, "utf8") === "owned generation\n"
			&& readFileSync(preverificationFile, "utf8") === "successor only copy\n",
		"owned-file replacement is rejected before descriptor truncation",
		preverificationError,
	);
	rmSync(preverification.path, { recursive: true, force: true });

	process.env.TMPDIR = scratch;
	process.env.RLM_SHARED_SESSIONS = "0";
	process.env.RLM_REQUIRE_TRANSCRIPTS = "0";
	delete process.env.CONTEXT;
	const resources = acquireChildResources({
		prompt: "synthetic prompt",
		cwd: scratch,
		childDepth: 1,
		callCount: 1,
		mode: "review",
	});
	const promptDirectory = path.dirname(resources.promptFile);
	const movedPrompt = `${promptDirectory}.owned`;
	renameSync(promptDirectory, movedPrompt);
	mkdirSync(promptDirectory, { mode: 0o700 });
	const promptCanary = path.join(promptDirectory, "unrelated-only-copy");
	writeFileSync(promptCanary, "must survive\n", { mode: 0o600 });
	const resourceFailures = resources.cleanup();
	record(
		resourceFailures.some((error) => error.message.includes("identity changed"))
			&& readFileSync(promptCanary, "utf8") === "must survive\n"
			&& readFileSync(path.join(movedPrompt, "prompt.txt"), "utf8") === "synthetic prompt",
		"child resource cleanup preserves a replacement root and reports failure",
		resourceFailures.map((error) => error.message).join("; "),
	);
	rmSync(movedPrompt, { recursive: true, force: true });
	rmSync(promptDirectory, { recursive: true, force: true });

	process.env.RLM_DEPTH = "0";
	const rootPrompt = createRootPromptLease();
	const rootPromptPath = rootPrompt.capture("first prompt");
	if (!rootPromptPath) throw new Error("root prompt capture returned no path");
	const rootPromptDirectory = path.dirname(rootPromptPath);
	const movedRootPrompt = `${rootPromptDirectory}.owned`;
	renameSync(rootPromptDirectory, movedRootPrompt);
	mkdirSync(rootPromptDirectory, { mode: 0o700 });
	const rootPromptCanary = path.join(scratch, "root-prompt-canary");
	writeFileSync(rootPromptCanary, "must remain exact\n", { mode: 0o600 });
	symlinkSync(rootPromptCanary, path.join(rootPromptDirectory, "prompt.txt"));
	const captureError = thrown(() => rootPrompt.capture("second prompt"));
	const rootCleanupError = thrown(() => rootPrompt.cleanup());
	record(
		Boolean(captureError)
			&& rootCleanupError.includes("identity changed")
			&& readFileSync(rootPromptCanary, "utf8") === "must remain exact\n"
			&& readFileSync(path.join(movedRootPrompt, "prompt.txt"), "utf8") === "first prompt",
		"root prompt refresh and cleanup preserve pathname replacements",
		`${captureError}; ${rootCleanupError}`,
	);
	rmSync(movedRootPrompt, { recursive: true, force: true });
	rmSync(rootPromptDirectory, { recursive: true, force: true });
	rmSync(rootPromptCanary, { force: true });

	const normalRootPrompt = createRootPromptLease();
	const normalRootPromptPath = normalRootPrompt.capture("first");
	normalRootPrompt.capture("second");
	record(
		Boolean(normalRootPromptPath)
			&& readFileSync(normalRootPromptPath!, "utf8") === "second",
		"root prompt refresh updates the held exact file",
	);
	normalRootPrompt.cleanup();
	record(
		Boolean(normalRootPromptPath) && !existsSync(path.dirname(normalRootPromptPath!)),
		"normal root prompt cleanup retires the exact declared tree",
	);

	const cliProbe = spawnSync(
		process.execPath,
		[import.meta.path, "--cli-replacement"],
		{
			input: "streamed context",
			encoding: "utf8",
			env: {
				...process.env,
				TMPDIR: scratch,
				RLM_STDIN: "1",
			},
		},
	);
	let cliResult: {
		cleanupError?: string;
		replacementDirectoryExists?: boolean;
		canaryBytes?: string;
		movedContextBytes?: string;
	} = {};
	try {
		cliResult = JSON.parse(cliProbe.stdout.trim());
	} catch {
		// The assertion below reports the full process output.
	}
	record(
		cliProbe.status === 0
			&& cliResult.cleanupError?.includes("identity changed") === true
			&& cliResult.replacementDirectoryExists === true
			&& cliResult.canaryBytes === "must survive\n"
			&& cliResult.movedContextBytes === "streamed context",
		"CLI input cleanup preserves a replacement spool root",
		`${cliProbe.stderr}\n${cliProbe.stdout}`,
	);
} finally {
	if (previousTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmp;
	if (previousShared === undefined) delete process.env.RLM_SHARED_SESSIONS;
	else process.env.RLM_SHARED_SESSIONS = previousShared;
	if (previousRequired === undefined) delete process.env.RLM_REQUIRE_TRANSCRIPTS;
	else process.env.RLM_REQUIRE_TRANSCRIPTS = previousRequired;
	if (previousDepth === undefined) delete process.env.RLM_DEPTH;
	else process.env.RLM_DEPTH = previousDepth;
	if (previousStdin === undefined) delete process.env.RLM_STDIN;
	else process.env.RLM_STDIN = previousStdin;
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

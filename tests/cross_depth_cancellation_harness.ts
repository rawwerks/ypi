import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment } from "../extensions/ypi/env.ts";
import { atomicCreateFile } from "../extensions/ypi/internal/atomic-file.ts";
import {
	processGroupId,
	processMatchesStartIdentity,
	processStartIdentity,
	currentProcessStartIdentity,
} from "../extensions/ypi/internal/process-identity.ts";
import {
	terminateRootTreeCoordinator,
	treeAuthorityManifestForTests,
} from "../extensions/ypi/internal/tree-coordinator.ts";
import { readImplementerLeaseRecords } from "../extensions/ypi/internal/workspace-registry.ts";
import { registerNativeRlmQueryTool } from "../extensions/ypi/native-tool.ts";
import {
	RecursiveChildError,
	runRecursiveChild,
} from "../extensions/ypi/runtime-core.ts";
import { resolveRuntime } from "../extensions/ypi/runtime.ts";

interface ProcessReceipt {
	pid: number;
	processIdentity: string;
	processGroupId?: number;
	generation?: string;
}

interface RootReceipt {
	cancelled: boolean;
	exitCode: number;
	error: string;
	authorityFile?: string;
	callCounterFile?: string;
	traceFile?: string;
	workspace?: {
		attemptRef?: string;
		attemptCommit?: string;
		baselineHead?: string;
		changedPaths?: string[];
		reportComplete?: boolean;
		treeRestored?: boolean;
		leaseId?: string;
	};
}

const projectRoot = path.resolve(import.meta.dir, "..");
const mode = process.argv[2];

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function writeJsonReceipt(filePath: string, value: unknown): void {
	atomicCreateFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function currentProcessReceipt(): ProcessReceipt {
	return {
		pid: process.pid,
		processIdentity: currentProcessStartIdentity(),
		processGroupId: processGroupId(process.pid),
		generation: process.env.YPI_TREE_GENERATION,
	};
}

async function waitForExit(
	child: ChildProcess,
	timeoutMilliseconds: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`process ${child.pid || "unknown"} did not exit within ${timeoutMilliseconds}ms`));
		}, timeoutMilliseconds);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

async function waitForFile(filePath: string, timeoutMilliseconds = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!existsSync(filePath)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${filePath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function cleanGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) environment[key] = value;
	}
	return {
		...environment,
		GIT_AUTHOR_NAME: "ypi-cancellation-test",
		GIT_AUTHOR_EMAIL: "ypi-cancellation-test@example.invalid",
		GIT_COMMITTER_NAME: "ypi-cancellation-test",
		GIT_COMMITTER_EMAIL: "ypi-cancellation-test@example.invalid",
		...extra,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: cleanGitEnvironment(),
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
	}
	return String(result.stdout || "").trim();
}

function repositorySnapshot(root: string): string {
	return JSON.stringify({
		status: git(root, "status", "--porcelain=v2", "--untracked-files=all"),
		worktrees: git(root, "worktree", "list", "--porcelain"),
		refs: git(root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/ypi/"),
	});
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function stopRecordedProcess(receiptPath: string): void {
	if (!existsSync(receiptPath)) return;
	let receipt: ProcessReceipt;
	try {
		receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as ProcessReceipt;
	} catch {
		return;
	}
	if (!processMatchesStartIdentity(receipt.pid, receipt.processIdentity)) return;
	const target = process.platform !== "win32"
		&& receipt.processGroupId === receipt.pid
		? -receipt.pid
		: receipt.pid;
	try {
		process.kill(target, "SIGKILL");
	} catch {
		// The exact recorded process has already terminated.
	}
}

async function fakePi(): Promise<void> {
	const depth = process.env.RLM_DEPTH || "";
	const implementerReceipt = requiredEnvironment("YPI_CANCEL_IMPLEMENTER_RECEIPT");
	const descendantReceipt = requiredEnvironment("YPI_CANCEL_DESCENDANT_RECEIPT");
	const nestedReceipt = requiredEnvironment("YPI_CANCEL_NESTED_RECEIPT");
	const postTerminalReceipt = requiredEnvironment("YPI_CANCEL_POST_TERMINAL_RECEIPT");
	const forbiddenDepthThree = requiredEnvironment("YPI_CANCEL_DEPTH_THREE_RECEIPT");

	if (depth === "1") {
		writeFileSync(path.join(process.cwd(), "edit.txt"), "edited by cancelled implementer\n");
		writeJsonReceipt(implementerReceipt, currentProcessReceipt());
		const runtime = resolveRuntime(
			new URL("../extensions/recursive.ts", import.meta.url).href,
		);
		try {
			const result = await runRecursiveChild(runtime, {
				prompt: "hold depth two until root cancellation",
				caller: "tool",
				mode: "review",
				parent: {
					cwd: process.cwd(),
					provider: process.env.RLM_PROVIDER,
					model: process.env.RLM_MODEL,
					thinkingLevel: process.env.RLM_THINKING_LEVEL,
				},
			});
			writeJsonReceipt(nestedReceipt, {
				exitCode: result.details.exitCode,
				text: result.text,
			});
		} catch (error) {
			writeJsonReceipt(nestedReceipt, {
				exitCode: (error as Error & { exitCode?: number }).exitCode || 1,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}

	if (depth === "2") {
		writeJsonReceipt(descendantReceipt, currentProcessReceipt());
		let handlingSignal = false;
		const keepAlive = setInterval(() => {}, 1_000);
		const onTermination = async () => {
			if (handlingSignal) return;
			handlingSignal = true;
			const runtime = resolveRuntime(
				new URL("../extensions/recursive.ts", import.meta.url).href,
			);
			try {
				await runRecursiveChild(runtime, {
					prompt: "attempt admission after root authority termination",
					caller: "tool",
					mode: "review",
					parent: {
						cwd: process.cwd(),
						provider: process.env.RLM_PROVIDER,
						model: process.env.RLM_MODEL,
						thinkingLevel: process.env.RLM_THINKING_LEVEL,
					},
				});
				writeJsonReceipt(postTerminalReceipt, {
					code: 0,
					error: "post-terminal recursive request unexpectedly succeeded",
					observedAuthorityFile: process.env.YPI_TREE_AUTHORITY_FILE,
					observedGeneration: process.env.YPI_TREE_GENERATION,
				});
			} catch (error) {
				writeJsonReceipt(postTerminalReceipt, {
					code: (error as Error & { exitCode?: number }).exitCode || 1,
					error: error instanceof Error ? error.message : String(error),
					observedAuthorityFile: process.env.YPI_TREE_AUTHORITY_FILE,
					observedGeneration: process.env.YPI_TREE_GENERATION,
				});
			}
			clearInterval(keepAlive);
			process.exit(0);
		};
		process.once("SIGTERM", () => {
			void onTermination().catch((error) => {
				writeJsonReceipt(postTerminalReceipt, {
					code: -1,
					error: error instanceof Error ? error.message : String(error),
				});
				process.exit(1);
			});
		});
		await new Promise(() => {});
		return;
	}

	if (depth === "3") {
		writeJsonReceipt(forbiddenDepthThree, currentProcessReceipt());
	}
}

async function rootWorker(): Promise<void> {
	const repo = requiredEnvironment("YPI_CANCEL_REPO");
	const rootReceiptPath = requiredEnvironment("YPI_CANCEL_ROOT_RECEIPT");
	process.env.RLM_DEPTH = "0";
	const runtime = resolveRuntime(new URL("../extensions/recursive.ts", import.meta.url).href);
	ensureEnvironment(runtime);

	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const pi = {
		registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
			tool = value;
		},
		getThinkingLevel() {
			return "medium";
		},
		getAllTools() {
			return [
				{ name: "read" },
				{ name: "grep" },
				{ name: "find" },
				{ name: "ls" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "rlm_query" },
			];
		},
	} as unknown as ExtensionAPI;
	registerNativeRlmQueryTool(pi, runtime);
	if (!tool) throw new Error("native rlm_query tool was not registered");

	const context = {
		cwd: repo,
		model: { provider: "test", id: "test" },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionDir: () => requiredEnvironment("YPI_CANCEL_MARKERS"),
		},
		hasUI: false,
	} as unknown as ExtensionContext;
	const controller = new AbortController();
	let cancellationRequested = false;
	let termination: Promise<void> | undefined;
	const onTerminate = () => {
		cancellationRequested = true;
		termination ??= terminateRootTreeCoordinator("cross-depth-root-cancelled");
		controller.abort();
	};
	process.once("SIGTERM", onTerminate);

	let caught: unknown;
	try {
		await tool.execute(
			"cross-depth-cancellation",
			{
				prompt: "Edit edit.txt, then keep one recursive review child alive.",
				mode: "implement",
				scope: ["edit.txt"],
			},
			controller.signal,
			undefined,
			context,
		);
	} catch (error) {
		caught = error;
	} finally {
		if (termination) await termination;
		process.removeListener("SIGTERM", onTerminate);
	}

	const recursiveError = caught instanceof RecursiveChildError ? caught : undefined;
	const receipt: RootReceipt = {
		cancelled: cancellationRequested,
		exitCode: recursiveError?.exitCode || (caught ? 1 : 0),
		error: caught instanceof Error ? caught.message : String(caught || ""),
		authorityFile: process.env.YPI_TREE_AUTHORITY_FILE,
		callCounterFile: process.env.RLM_CALL_COUNTER_FILE,
		traceFile: process.env.PI_TRACE_FILE,
		workspace: recursiveError?.details?.workspace,
	};
	writeJsonReceipt(rootReceiptPath, receipt);
	process.exitCode = cancellationRequested ? 130 : caught ? 1 : 0;
}

async function main(): Promise<void> {
	console.log("\n=== Cross-depth writable cancellation harness ===");
	let passed = 0;
	let failed = 0;
	const record = (condition: boolean, label: string, detail = "") => {
		if (condition) {
			passed++;
			console.log(`  PASS ${label}`);
		} else {
			failed++;
			console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
		}
	};

	const scratch = mkdtempSync(path.join(tmpdir(), "ypi_cancel."));
	chmodSync(scratch, 0o700);
	const repo = path.join(scratch, "repo");
	const markers = path.join(scratch, "markers");
	const wrapper = path.join(scratch, "pi");
	const rootReceiptPath = path.join(markers, "root.json");
	const implementerReceiptPath = path.join(markers, "implementer.json");
	const descendantReceiptPath = path.join(markers, "descendant.json");
	const nestedReceiptPath = path.join(markers, "nested.json");
	const postTerminalReceiptPath = path.join(markers, "post-terminal.json");
	const forbiddenDepthThreePath = path.join(markers, "depth-three.json");
	const traceFile = path.join(scratch, "trace.jsonl");
	const callCounterFile = path.join(scratch, "calls.counter");
	const realRepositoryBefore = repositorySnapshot(projectRoot);
	let rootWorkerProcess: ChildProcess | undefined;
	let rootWorkerStdout = "";
	let rootWorkerStderr = "";
	let unrelated: ChildProcess | undefined;
	let unrelatedReceipt: ProcessReceipt | undefined;

	try {
		mkdirSync(repo, { mode: 0o700 });
		mkdirSync(markers, { mode: 0o700 });
		git(repo, "init", "-q");
		writeFileSync(path.join(repo, "edit.txt"), "base\n");
		git(repo, "add", "edit.txt");
		git(repo, "commit", "-qm", "base");
		const baseline = git(repo, "rev-parse", "HEAD");

		writeFileSync(
			wrapper,
			[
				"#!/bin/sh",
				`exec ${shellQuote(process.execPath)} ${shellQuote(import.meta.path)} --fake-pi "$@"`,
				"",
			].join("\n"),
			{ mode: 0o700 },
		);
		chmodSync(wrapper, 0o700);

		unrelated = spawn("/bin/sleep", ["30"], {
			detached: process.platform !== "win32",
			stdio: "ignore",
		});
		if (!unrelated.pid) throw new Error("unrelated control PID is unavailable");
		const unrelatedIdentity = processStartIdentity(unrelated.pid);
		if (!unrelatedIdentity) {
			throw new Error("unrelated control process identity is unavailable");
		}
		unrelatedReceipt = {
			pid: unrelated.pid,
			processIdentity: unrelatedIdentity,
			processGroupId: processGroupId(unrelated.pid),
		};

		const environment = cleanGitEnvironment({
			TMPDIR: scratch,
			YPI_PI_BIN: wrapper,
			YPI_CANCEL_REPO: repo,
			YPI_CANCEL_MARKERS: markers,
			YPI_CANCEL_ROOT_RECEIPT: rootReceiptPath,
			YPI_CANCEL_IMPLEMENTER_RECEIPT: implementerReceiptPath,
			YPI_CANCEL_DESCENDANT_RECEIPT: descendantReceiptPath,
			YPI_CANCEL_NESTED_RECEIPT: nestedReceiptPath,
			YPI_CANCEL_POST_TERMINAL_RECEIPT: postTerminalReceiptPath,
			YPI_CANCEL_DEPTH_THREE_RECEIPT: forbiddenDepthThreePath,
			RLM_DEPTH: "0",
			RLM_MAX_DEPTH: "3",
			RLM_MAX_CALLS: "65536",
			RLM_MAX_CONCURRENT_CALLS: "3",
			RLM_CALL_COUNT: "0",
			RLM_CALL_COUNTER_FILE: callCounterFile,
			RLM_CONCURRENCY_DIR: path.join(scratch, "c"),
			RLM_JSON: "0",
			RLM_SHARED_SESSIONS: "0",
			RLM_REQUIRE_TRANSCRIPTS: "0",
			RLM_TRACE_ID: "cross-depth-cancellation",
			PI_TRACE_FILE: traceFile,
		});
		for (const key of Object.keys(environment)) {
			if (key.startsWith("YPI_TREE_") || key === "RLM_ACTIVE_SLOT_TOKEN") {
				delete environment[key];
			}
		}

		rootWorkerProcess = spawn(
			process.execPath,
			[import.meta.path, "--root-worker"],
			{
				cwd: projectRoot,
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		rootWorkerProcess.stdout?.on("data", (chunk) => {
			rootWorkerStdout += String(chunk);
		});
		rootWorkerProcess.stderr?.on("data", (chunk) => {
			rootWorkerStderr += String(chunk);
		});
		await Promise.all([
			waitForFile(implementerReceiptPath),
			waitForFile(descendantReceiptPath),
		]);
		const implementer = JSON.parse(
			readFileSync(implementerReceiptPath, "utf8"),
		) as ProcessReceipt;
		const descendant = JSON.parse(
			readFileSync(descendantReceiptPath, "utf8"),
		) as ProcessReceipt;
		record(
			implementer.processGroupId === implementer.pid
				&& descendant.processGroupId === descendant.pid
				&& implementer.pid !== descendant.pid,
			"writer and recursive descendant are independently detached process groups",
			JSON.stringify({ implementer, descendant }),
		);
		record(
			implementer.generation === descendant.generation,
			"writer and descendant inherit one exact root generation",
		);

		rootWorkerProcess.kill("SIGTERM");
		const rootExit = await waitForExit(rootWorkerProcess, 20_000);
		await waitForFile(rootReceiptPath, 2_000);
		await waitForFile(postTerminalReceiptPath, 2_000);
		const rootReceipt = JSON.parse(
			readFileSync(rootReceiptPath, "utf8"),
		) as RootReceipt;
		const postTerminal = JSON.parse(
			readFileSync(postTerminalReceiptPath, "utf8"),
		) as {
			code?: number;
			stderr?: string;
			error?: string;
			observedAuthorityFile?: string;
			observedGeneration?: string;
		};
		record(
			rootExit.code === 130
				&& rootReceipt.cancelled
				&& rootReceipt.exitCode === 130,
			"root cancellation is explicit and exits 130",
			JSON.stringify({ rootExit, rootReceipt }),
		);
		record(
			postTerminal.code === 130
				&& `${postTerminal.stderr || ""}${postTerminal.error || ""}`.includes(
					"authority is terminal",
				)
				&& !existsSync(forbiddenDepthThreePath),
			"post-terminal descendant admission fails before a depth-three launch",
			JSON.stringify(postTerminal),
		);
		record(
			readFileSync(callCounterFile, "utf8").trim() === "2",
			"rejected post-terminal work consumes no call allocation",
			readFileSync(callCounterFile, "utf8").trim(),
		);

		const authorityFile = rootReceipt.authorityFile || "";
		const authority = JSON.parse(readFileSync(authorityFile, "utf8")) as {
			status?: string;
			terminalReason?: string;
			rootPid?: number;
			rootProcessIdentity?: string;
			generation?: string;
		};
		const trace = readFileSync(traceFile, "utf8");
		record(
			authority.status === "terminal"
				&& authority.terminalReason === "cross-depth-root-cancelled"
				&& authority.generation === descendant.generation
				&& trace.includes("TREE_TERMINAL")
				&& trace.includes("cross-depth-root-cancelled"),
			"authority manifest and trace record one terminal generation",
			JSON.stringify(authority),
		);
		record(
			!trace.includes("depth=2→3")
				&& !trace.includes("depth=2 child_depth=3"),
			"terminal trace contains no depth-three admission",
		);
		record(
			!processMatchesStartIdentity(
				implementer.pid,
				implementer.processIdentity,
			)
				&& !processMatchesStartIdentity(
					descendant.pid,
					descendant.processIdentity,
				),
			"controlled writer and descendant are terminal after bounded cleanup",
		);
		record(
			Boolean(
				unrelatedReceipt
				&& processMatchesStartIdentity(
					unrelatedReceipt.pid,
					unrelatedReceipt.processIdentity,
				),
			),
			"root cancellation does not signal an unrelated process",
		);

		const workspace = rootReceipt.workspace;
		const attemptRef = workspace?.attemptRef || "";
		const attemptCommit = workspace?.attemptCommit || "";
		const commonGitDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
		record(
			workspace?.reportComplete === true
				&& workspace.treeRestored === true
				&& workspace.baselineHead === baseline
				&& workspace.changedPaths?.join("\0") === "edit.txt"
				&& git(repo, "rev-parse", "--verify", `${attemptRef}^{commit}`) === attemptCommit
				&& git(repo, "rev-parse", `${attemptCommit}^`) === baseline
				&& git(repo, "show", `${attemptRef}:edit.txt`) === "edited by cancelled implementer",
			"cancelled writable work is finalized to an exact-parent verified attempt ref",
			JSON.stringify(workspace),
		);
		record(
			git(repo, "status", "--porcelain=v2", "--untracked-files=all") === ""
				&& git(repo, "worktree", "list", "--porcelain")
					.split("\n")
					.filter((line) => line.startsWith("worktree ")).length === 1
				&& readImplementerLeaseRecords(commonGitDir).length === 0,
			"fixture checkout is clean with no live worktree or implementer lease",
		);
		record(
			repositorySnapshot(projectRoot) === realRepositoryBefore,
			"actual checkout status, worktrees, and ypi refs remain byte-identical",
		);
		record(
			(statSync(authorityFile).mode & 0o777) === 0o600,
			"terminal authority receipt remains private",
		);
	} catch (error) {
		failed++;
		const nestedDiagnostics = existsSync(nestedReceiptPath)
			? readFileSync(nestedReceiptPath, "utf8")
			: "missing";
		const rootDiagnostics = existsSync(rootReceiptPath)
			? readFileSync(rootReceiptPath, "utf8")
			: "missing";
		console.error(
			`  FAIL harness completed without an unhandled error: ${
				error instanceof Error ? error.stack || error.message : String(error)
			}\nroot stdout=${JSON.stringify(rootWorkerStdout)}`
			+ `\nroot stderr=${JSON.stringify(rootWorkerStderr)}`
			+ `\nnested receipt=${nestedDiagnostics}`
			+ `\nroot receipt=${rootDiagnostics}`,
		);
	} finally {
		if (rootWorkerProcess?.pid) {
			try {
				process.kill(rootWorkerProcess.pid, "SIGKILL");
			} catch {
				// Root worker is already terminal.
			}
		}
		stopRecordedProcess(implementerReceiptPath);
		stopRecordedProcess(descendantReceiptPath);
		if (
			unrelatedReceipt
			&& processMatchesStartIdentity(
				unrelatedReceipt.pid,
				unrelatedReceipt.processIdentity,
			)
		) {
			const target = process.platform !== "win32"
				&& unrelatedReceipt.processGroupId === unrelatedReceipt.pid
				? -unrelatedReceipt.pid
				: unrelatedReceipt.pid;
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// Control process is already terminal.
			}
		}
		rmSync(scratch, { recursive: true, force: true });
	}

	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

if (mode === "--fake-pi") {
	await fakePi();
} else if (mode === "--root-worker") {
	await rootWorker();
} else {
	await main();
}

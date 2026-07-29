import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureEnvironment } from "./env.ts";
import { remainingTimeoutSeconds } from "./guardrails.ts";
import { cancelAsyncJob, createAsyncJob, discardAsyncJob, finishAsyncJob, launchAsyncWorker, markAsyncJobAdmitted, markAsyncJobChildPid, readAsyncJob, waitForAsyncAdmission, waitForAsyncTerminal } from "./internal/cli-async.ts";
import { resolveContextSource, type ContextSource } from "./internal/cli-input.ts";
import { terminateRootTreeCoordinator } from "./internal/tree-coordinator.ts";
import { formatRecursiveResultForTool, RecursiveChildError, runRecursiveChild } from "./runtime-core.ts";
import { resolveRuntime, type YpiRuntime } from "./runtime.ts";

interface CliFlags {
	fork: boolean;
	async: boolean;
	prompt: string;
}

interface CliExecutionOptions {
	cwd?: string;
	extensionPath?: string | null;
	treeStartTimeSeconds?: number;
	onText?: (text: string) => boolean | void;
	onTextDrain?: () => Promise<void>;
	onAdmitted?: (callCount: number) => void;
	onChildSpawn?: (pid: number) => void;
	signal?: AbortSignal;
}

const modulePath = fileURLToPath(import.meta.url);
const moduleExtensionPath = path.basename(modulePath) === "rlm_query.mjs" && path.basename(path.dirname(modulePath)) === "dist"
	? path.join(path.dirname(modulePath), "..", "extensions", "recursive.ts")
	: fileURLToPath(new URL("../recursive.ts", import.meta.url));
const runtimeFromModule = resolveRuntime(pathToFileURL(moduleExtensionPath).href);

function activeRuntime(): YpiRuntime {
	return {
		...runtimeFromModule,
		systemPromptPath: process.env.RLM_SYSTEM_PROMPT || runtimeFromModule.systemPromptPath,
	};
}

function usage(): never {
	console.error('Usage: rlm_query [--fork] [--async] "your prompt here"');
	process.exit(1);
}

function rejectRetiredFlags(args: string[]): void {
	for (const argument of args) {
		if (argument === "--notify") {
			console.error("✗ --notify was removed; read the async output and sentinel paths");
			process.exit(2);
		}
		if (argument !== "--fork" && argument !== "--async") return;
	}
}

function parseFlags(args: string[]): CliFlags {
	let fork = false;
	let async = false;
	let index = 0;
	flagLoop: while (args[index]?.startsWith("--")) {
		switch (args[index]) {
			case "--fork":
				fork = true;
				index++;
				break;
			case "--async":
				async = true;
				index++;
				break;
			default:
				// Preserve the historical parser: an unknown --token becomes the prompt.
				break flagLoop;
		}
	}
	const prompt = args[index];
	if (!prompt) usage();
	return { fork, async, prompt };
}

function parentContext(cwd = process.cwd()) {
	return {
		cwd,
		provider: process.env.RLM_PROVIDER,
		model: process.env.RLM_MODEL,
		thinkingLevel: process.env.RLM_THINKING_LEVEL,
		sessionFile: process.env.RLM_SESSION_FILE || undefined,
		sessionDir: process.env.RLM_SESSION_DIR || undefined,
	};
}

function configuredExtensionPath(): string | null {
	const configured = process.env.YPI_EXTENSION_PATH;
	return configured && existsSync(configured) ? configured : null;
}

function cliErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0] || "Recursive child failed";
	return `✗ ${firstLine}\n  Why: the canonical recursion runtime rejected the request or the child failed\n  Fix: inspect the remaining error text, configuration, and child output\n${message}`;
}

function writeStdout(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			process.stdout.removeListener("error", onError);
			reject(error);
		};
		process.stdout.once("error", onError);
		process.stdout.write(text, () => {
			if (settled) return;
			settled = true;
			process.stdout.removeListener("error", onError);
			resolve();
		});
	});
}

function errorExitCode(error: unknown): number {
	if (error instanceof RecursiveChildError) return error.exitCode;
	if (typeof error === "object" && error !== null && "exitCode" in error && typeof error.exitCode === "number") return error.exitCode;
	return 1;
}

async function executeRequest(runtime: YpiRuntime, flags: Pick<CliFlags, "prompt" | "fork">, source: ContextSource, options: CliExecutionOptions = {}) {
	return runRecursiveChild(runtime, {
		prompt: flags.prompt,
		fork: flags.fork,
		caller: "cli",
		context: source.context,
		contextPath: source.contextPath,
		extensionPath: options.extensionPath === undefined ? configuredExtensionPath() : options.extensionPath,
		treeStartTimeSeconds: options.treeStartTimeSeconds,
		onText: options.onText,
		onTextDrain: options.onTextDrain,
		onAdmitted: options.onAdmitted,
		onChildSpawn: options.onChildSpawn,
		signal: options.signal,
		parent: parentContext(options.cwd),
	});
}

async function runWorker(jobPath: string): Promise<void> {
	const controller = new AbortController();
	let requestedExitCode: number | undefined;
	const onInterrupt = () => { requestedExitCode = 130; controller.abort(); };
	const onTerminate = () => { requestedExitCode = 143; controller.abort(); };
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	try {
		const job = readAsyncJob(jobPath);
		const runtime = activeRuntime();
		ensureEnvironment(runtime);
		if (job.parentSessionSnapshot) process.env.RLM_SESSION_FILE = job.parentSessionSnapshot;
		if (job.rootPromptSnapshot) process.env.RLM_ROOT_PROMPT_FILE = job.rootPromptSnapshot;
		let code = 0;
		let output = "";
		try {
			const result = await executeRequest(runtime, { prompt: job.prompt, fork: job.fork }, { contextPath: job.contextPath }, {
				cwd: job.cwd,
				extensionPath: job.extensionPath,
				treeStartTimeSeconds: job.treeStartTimeSeconds,
				onAdmitted: () => markAsyncJobAdmitted(job),
				onChildSpawn: (pid) => markAsyncJobChildPid(job, pid),
				signal: controller.signal,
			});
			output = formatRecursiveResultForTool(result);
		} catch (error) {
			code = requestedExitCode ?? errorExitCode(error);
			output = `${cliErrorText(error)}\n`;
		}
		finishAsyncJob(job, code, output);
	} finally {
		await terminateRootTreeCoordinator("async-root-complete");
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onTerminate);
	}
}

async function cancelAsyncJobToTerminal(
	job: ReturnType<typeof createAsyncJob>,
	workerPid: number,
): Promise<boolean> {
	cancelAsyncJob(job, workerPid);
	if (await waitForAsyncTerminal(job)) return true;
	cancelAsyncJob(job, workerPid, "SIGKILL");
	return waitForAsyncTerminal(job, 1_000);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
	if (args[0] === "--ypi-async-worker") {
		if (!args[1]) usage();
		await runWorker(args[1]);
		return 0;
	}

	const invocationStartedAt = Math.floor(Date.now() / 1000);
	const runtime = activeRuntime();
	ensureEnvironment(runtime);
	const extensionPath = configuredExtensionPath();
	if (process.env.RLM_DEPTH === "0") process.env.RLM_START_TIME = String(invocationStartedAt);
	const controller = new AbortController();
	let signalExitCode = 130;
	let brokenPipe = false;
	let stdoutFailure: Error | undefined;
	const onStdoutError = (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") brokenPipe = true;
		else stdoutFailure = error;
		controller.abort();
	};
	const onInterrupt = () => {
		signalExitCode = 130;
		void terminateRootTreeCoordinator("root-cli-interrupt");
		controller.abort();
	};
	const onTerminate = () => {
		signalExitCode = 143;
		void terminateRootTreeCoordinator("root-cli-terminate");
		controller.abort();
	};
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);
	process.stdout.on("error", onStdoutError);
	let source: ContextSource | undefined;
	try {
		rejectRetiredFlags(args);
		const flags = parseFlags(args);
		const remaining = remainingTimeoutSeconds();
		source = await resolveContextSource({
			signal: controller.signal,
			timeoutMilliseconds: remaining === undefined ? undefined : Math.max(0, remaining * 1000),
		});

		if (flags.async) {
			let job: ReturnType<typeof createAsyncJob> | undefined;
			let pid = 0;
			try {
				job = createAsyncJob({
					prompt: flags.prompt,
					fork: flags.fork,
					cwd: process.cwd(),
					context: source.context,
					contextPath: source.contextPath,
					extensionPath,
					treeStartTimeSeconds: invocationStartedAt,
				});
				pid = launchAsyncWorker(job, fileURLToPath(import.meta.url));
				const admissionRemaining = remainingTimeoutSeconds();
				await waitForAsyncAdmission(
					job,
					admissionRemaining === undefined ? undefined : Math.max(0, admissionRemaining * 1000),
					controller.signal,
				);
				if (controller.signal.aborted) throw new Error("Async recursion acknowledgement cancelled");
				await writeStdout(`${JSON.stringify({
					job_id: path.basename(path.dirname(job.jobPath)),
					output: job.outputPath,
					sentinel: job.sentinelPath,
					pid,
				})}\n`);
				return 0;
			} catch (error) {
				if (job && controller.signal.aborted) {
					const terminal = pid <= 0 || await cancelAsyncJobToTerminal(job, pid);
					if (terminal) {
						discardAsyncJob(job, pid);
					} else {
						console.error(`Async job did not publish terminal state; preserved at ${path.dirname(job.jobPath)}`);
					}
					return brokenPipe ? 0 : signalExitCode;
				}
				if (job) {
					const terminal = pid <= 0 || existsSync(job.sentinelPath) || await cancelAsyncJobToTerminal(job, pid);
					if (terminal) {
						discardAsyncJob(job, pid);
					} else {
						console.error(`Async job did not publish terminal state; preserved at ${path.dirname(job.jobPath)}`);
					}
				}
				console.error(cliErrorText(error));
				return errorExitCode(error);
			}
		}

		const result = await executeRequest(runtime, flags, source, {
			cwd: process.cwd(),
			extensionPath,
			treeStartTimeSeconds: invocationStartedAt,
			signal: controller.signal,
			onText(text) {
				return process.stdout.write(text);
			},
			onTextDrain() {
				return new Promise((resolve) => process.stdout.once("drain", resolve));
			},
		});
		for (const warning of result.warnings) console.error(`[${warning}]`);
		if (result.stderr) console.error(result.stderr);
		return 0;
	} catch (error) {
		if (brokenPipe) return 0;
		if (stdoutFailure) {
			console.error(cliErrorText(stdoutFailure));
			return 1;
		}
		if (!controller.signal.aborted) console.error(cliErrorText(error));
		return controller.signal.aborted ? signalExitCode : errorExitCode(error);
	} finally {
		if ((process.env.RLM_DEPTH || "0") === "0") {
			await terminateRootTreeCoordinator("root-cli-complete");
		}
		process.removeListener("SIGINT", onInterrupt);
		process.removeListener("SIGTERM", onTerminate);
		process.stdout.removeListener("error", onStdoutError);
		source?.cleanup?.();
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}

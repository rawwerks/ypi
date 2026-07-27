import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type { CostSummary } from "../guardrails.ts";
import {
	createBoundedCapture,
	createJsonDecoder,
	MAX_CHILD_STREAM_CHARS,
	MAX_TOOL_OUTPUT_CHARS,
	type ChildOutputSnapshot,
	type ChildToolActivity,
} from "./child-output.ts";

export interface ChildProcessOptions {
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	jsonMode: boolean;
	stdinText?: string;
	onText?: (text: string) => boolean | void;
	onToolActivity?: (activity: ChildToolActivity) => void;
	onTextDrain?: () => Promise<void>;
	onSpawn?: (pid: number) => void;
	quiesceProcessGroup?: boolean;
	launchGate?: {
		launcherPath: string;
		pidFile: string;
		readyFile: string;
	};
}

export interface ChildProcessResult extends ChildOutputSnapshot {
	code: number;
	signal: NodeJS.Signals | null;
	cost?: CostSummary;
	timedOut: boolean;
	cancelled: boolean;
}

function signalledExitCode(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	return 128 + (osConstants.signals[signal] || 0);
}

export function runChildProcess(options: ChildProcessOptions): Promise<ChildProcessResult> {
	return new Promise((resolve, reject) => {
		const piExecutable = process.env.YPI_PI_BIN || "pi";
		const executable = options.launchGate ? process.env.YPI_NODE_BIN || "node" : piExecutable;
		const args = options.launchGate
			? [
				options.launchGate.launcherPath,
				"--pid-file",
				options.launchGate.pidFile,
				"--ready-file",
				options.launchGate.readyFile,
				"--owner-pid",
				String(process.pid),
				"--",
				piExecutable,
				...options.args,
			]
			: options.args;
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		if (child.pid) {
			try {
				options.onSpawn?.(child.pid);
				if (options.launchGate) {
					writeFileSync(options.launchGate.readyFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
				}
			} catch (error) {
				const target = process.platform === "win32" ? child.pid : -child.pid;
				try { process.kill(target, "SIGKILL"); } catch { child.kill("SIGKILL"); }
				child.on("error", () => {});
				reject(error);
				return;
			}
		}
		// Pi's non-interactive stdin path preserves the exact task without CLI
		// option parsing, @file wrappers, or ARG_MAX exposure.
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") reject(error);
		});
		child.stdin.end(options.stdinText ?? "");
		let stdoutCharacters = 0;
		const rawStderr = createBoundedCapture(MAX_TOOL_OUTPUT_CHARS);
		const plainText = createBoundedCapture(MAX_TOOL_OUTPUT_CHARS);
		const jsonDecoder = createJsonDecoder(options.onText, options.onToolActivity);
		let timedOut = false;
		let cancelled = false;
		let terminating = false;
		let killTimer: NodeJS.Timeout | undefined;
		let quiesceKillTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let flowPaused = false;
		const applyBackpressure = (keepFlowing: boolean | void) => {
			if (keepFlowing !== false || flowPaused) return;
			flowPaused = true;
			child.stdout.pause();
			(options.onTextDrain?.() || Promise.resolve()).finally(() => {
				flowPaused = false;
				if (!child.stdout.destroyed) child.stdout.resume();
			});
		};
		child.stdout.on("data", (chunk: string) => {
			stdoutCharacters += chunk.length;
			if (options.jsonMode) applyBackpressure(jsonDecoder.append(chunk));
			else {
				plainText.append(chunk);
				if (chunk) applyBackpressure(options.onText?.(chunk));
			}
		});
		child.stderr.on("data", (chunk: string) => rawStderr.append(chunk));

		const killChild = (reason: "abort" | "timeout") => {
			if (terminating) return;
			terminating = true;
			if (reason === "timeout") timedOut = true;
			else cancelled = true;
			if (!child.pid) {
				child.kill("SIGTERM");
				return;
			}
			const target = process.platform === "win32" ? child.pid : -child.pid;
			try { process.kill(target, "SIGTERM"); } catch { child.kill("SIGTERM"); }
			killTimer = setTimeout(() => {
				try { process.kill(target, "SIGKILL"); } catch { child.kill("SIGKILL"); }
			}, 1500);
		};
		const abortHandler = () => killChild("abort");
		const cleanup = (preserveKillEscalation = false) => {
			options.signal?.removeEventListener("abort", abortHandler);
			if (killTimer && !preserveKillEscalation) clearTimeout(killTimer);
			if (quiesceKillTimer) clearTimeout(quiesceKillTimer);
			if (timeoutTimer) clearTimeout(timeoutTimer);
		};

		child.on("error", (error) => { cleanup(); reject(error); });
		child.on("exit", () => {
			// `close` waits for inherited stdio descriptors. Start quiescing as soon
			// as the trusted child leader exits so a background descendant retaining
			// those descriptors cannot hold the writer lease indefinitely.
			if (!options.quiesceProcessGroup || !child.pid || process.platform === "win32" || terminating) return;
			const target = -child.pid;
			try { process.kill(target, "SIGTERM"); } catch { return; }
			quiesceKillTimer = setTimeout(() => {
				try { process.kill(target, "SIGKILL"); } catch { /* group already gone */ }
			}, 250);
		});
		child.on("close", (code, childSignal) => {
			// The direct child can close its inherited stdio while a descendant in
			// the detached group survives. A writable shared-checkout lease is not
			// released until that process group receives a final TERM/KILL sweep.
			cleanup(terminating);
			jsonDecoder.finish();
			const json = jsonDecoder.result();
			const settle = () => resolve({
				code: timedOut ? 124 : cancelled ? 130 : code ?? signalledExitCode(childSignal),
				signal: childSignal,
				stderr: rawStderr.text(),
				text: options.jsonMode ? json.text : plainText.text(),
				cost: options.jsonMode ? json.cost : undefined,
				stdoutTruncated: stdoutCharacters > MAX_CHILD_STREAM_CHARS,
				stderrTruncated: rawStderr.truncated,
				textTruncated: options.jsonMode ? json.textTruncated : plainText.truncated,
				jsonEventTruncated: options.jsonMode ? json.jsonEventTruncated : false,
				jsonCostIncomplete: options.jsonMode ? json.jsonCostIncomplete : false,
				timedOut,
				cancelled,
			});
			if (!options.quiesceProcessGroup || !child.pid || process.platform === "win32") {
				settle();
				return;
			}
			const target = -child.pid;
			try { process.kill(target, "SIGTERM"); } catch { /* no surviving descendants */ }
			setTimeout(() => {
				try { process.kill(target, "SIGKILL"); } catch { /* group already gone */ }
				if (killTimer) clearTimeout(killTimer);
				settle();
			}, 250);
		});
		if (options.timeoutSeconds !== undefined) timeoutTimer = setTimeout(() => killChild("timeout"), options.timeoutSeconds * 1000);
		if (options.signal?.aborted) abortHandler();
		else options.signal?.addEventListener("abort", abortHandler, { once: true });
	});
}

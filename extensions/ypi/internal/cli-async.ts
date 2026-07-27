import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId } from "../env.ts";

export class AsyncAdmissionError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "AsyncAdmissionError";
		this.exitCode = exitCode;
	}
}

export interface AsyncJobInput {
	prompt: string;
	fork: boolean;
	notifyPid?: number;
	cwd: string;
	context?: string;
	contextPath?: string;
	extensionPath: string | null;
	treeStartTimeSeconds: number;
}

export interface AsyncJob {
	prompt: string;
	fork: boolean;
	notifyPid?: number;
	cwd: string;
	contextPath?: string;
	ownedContextPath?: string;
	parentSessionSnapshot?: string;
	rootPromptSnapshot?: string;
	outputPath: string;
	sentinelPath: string;
	admissionPath: string;
	childPidPath: string;
	jobPath: string;
	extensionPath: string | null;
	treeStartTimeSeconds: number;
}

function assertInsideJobDir(job: AsyncJob, candidate: string): void {
	const jobDir = path.dirname(path.resolve(job.jobPath));
	if (path.dirname(path.resolve(candidate)) !== jobDir) {
		throw new Error(`Invalid async job path outside private job directory: ${candidate}`);
	}
}

function snapshotFile(source: string, target: string): string {
	copyFileSync(source, target);
	chmodSync(target, 0o600);
	return target;
}

export function createAsyncJob(input: AsyncJobInput): AsyncJob {
	const traceId = safeTraceId(process.env.RLM_TRACE_ID || randomBytes(4).toString("hex"));
	process.env.RLM_TRACE_ID = traceId;
	const root = process.env.TMPDIR || tmpdir();
	const jobDir = mkdtempSync(path.join(root, `rlm_async_${traceId}_`));
	const jobPath = path.join(jobDir, "job.json");
	const outputPath = path.join(jobDir, "output.txt");
	const sentinelPath = path.join(jobDir, "done");
	const admissionPath = path.join(jobDir, "admitted");
	const childPidPath = path.join(jobDir, "child.pid");
	try {
		writeFileSync(outputPath, "", { flag: "wx", mode: 0o600 });

		let ownedContextPath: string | undefined;
		if (input.context !== undefined) {
			ownedContextPath = path.join(jobDir, "context.txt");
			writeFileSync(ownedContextPath, input.context, { flag: "wx", mode: 0o600 });
		} else if (input.contextPath && existsSync(input.contextPath)) {
			ownedContextPath = snapshotFile(input.contextPath, path.join(jobDir, "context.txt"));
		}

		let parentSessionSnapshot: string | undefined;
		if (input.fork && process.env.RLM_SESSION_FILE && existsSync(process.env.RLM_SESSION_FILE)) {
			parentSessionSnapshot = snapshotFile(process.env.RLM_SESSION_FILE, path.join(jobDir, "parent-session.jsonl"));
		}
		let rootPromptSnapshot: string | undefined;
		if (process.env.RLM_ROOT_PROMPT_FILE && existsSync(process.env.RLM_ROOT_PROMPT_FILE)) {
			rootPromptSnapshot = snapshotFile(process.env.RLM_ROOT_PROMPT_FILE, path.join(jobDir, "root-prompt.txt"));
		}

		return {
			prompt: input.prompt,
			fork: input.fork,
			notifyPid: input.notifyPid,
			cwd: input.cwd,
			contextPath: ownedContextPath,
			ownedContextPath,
			parentSessionSnapshot,
			rootPromptSnapshot,
			outputPath,
			sentinelPath,
			admissionPath,
			childPidPath,
			jobPath,
			extensionPath: input.extensionPath,
			treeStartTimeSeconds: input.treeStartTimeSeconds,
		};
	} catch (error) {
		rmSync(jobDir, { recursive: true, force: true });
		throw error;
	}
}

export function launchAsyncWorker(job: AsyncJob, cliPath: string): number {
	writeFileSync(job.jobPath, `${JSON.stringify(job)}\n`, { flag: "wx", mode: 0o600 });
	const child = spawn(process.execPath, [cliPath, "--ypi-async-worker", job.jobPath], {
		cwd: job.cwd,
		env: process.env,
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	child.unref();
	return child.pid || 0;
}

export function readAsyncJob(jobPath: string): AsyncJob {
	const job = JSON.parse(readFileSync(jobPath, "utf8")) as AsyncJob;
	if (path.resolve(job.jobPath) !== path.resolve(jobPath)) throw new Error("Async job identity mismatch");
	for (const candidate of [job.outputPath, job.sentinelPath, job.admissionPath, job.childPidPath, job.ownedContextPath, job.parentSessionSnapshot, job.rootPromptSnapshot]) {
		if (candidate) assertInsideJobDir(job, candidate);
	}
	return job;
}

export function markAsyncJobAdmitted(job: AsyncJob): void {
	writeFileSync(job.admissionPath, "accepted\n", { flag: "wx", mode: 0o600 });
}

export function markAsyncJobChildPid(job: AsyncJob, pid: number): void {
	writeFileSync(job.childPidPath, `${pid}\n`, { flag: "wx", mode: 0o600 });
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (pid <= 0) return;
	const target = process.platform === "win32" ? pid : -pid;
	try { process.kill(target, signal); } catch { /* process already exited */ }
}

export function cancelAsyncJob(job: AsyncJob, workerPid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	if (existsSync(job.childPidPath)) {
		const childPid = Number(readFileSync(job.childPidPath, "utf8").trim());
		if (Number.isSafeInteger(childPid) && childPid > 0) signalProcessGroup(childPid, signal);
	}
	signalProcessGroup(workerPid, signal);
}

export async function waitForAsyncTerminal(job: AsyncJob, timeoutMilliseconds = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		if (existsSync(job.sentinelPath)) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return existsSync(job.sentinelPath);
}

export function discardAsyncJob(job: AsyncJob, workerPid = 0): void {
	if (workerPid > 0 && !existsSync(job.admissionPath) && !existsSync(job.sentinelPath)) {
		const target = process.platform === "win32" ? workerPid : -workerPid;
		try { process.kill(target, "SIGTERM"); } catch { /* worker already exited */ }
	}
	rmSync(path.dirname(job.jobPath), { recursive: true, force: true });
}

export async function waitForAsyncAdmission(job: AsyncJob, timeoutMilliseconds = 30_000, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new AsyncAdmissionError("Async recursion admission cancelled", 130);
		if (existsSync(job.admissionPath)) return;
		if (existsSync(job.sentinelPath)) {
			const code = Number(readFileSync(job.sentinelPath, "utf8").trim() || "1");
			if (code === 0) return;
			throw new AsyncAdmissionError(readFileSync(job.outputPath, "utf8").trim() || `Async recursion request rejected with exit ${code}`, code);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (signal?.aborted) throw new AsyncAdmissionError("Async recursion admission cancelled", 130);
	throw new Error(`Async recursion admission timed out after ${timeoutMilliseconds}ms`);
}

function notifyPeer(job: AsyncJob, code: number, output: string): void {
	if (!job.notifyPid) return;
	// Pi peer inboxes are a host protocol surface rooted at /tmp, independent
	// from caller-selected TMPDIR used for ypi-owned job artifacts.
	const inboxRoot = "/tmp";
	for (const name of (() => { try { return readdirSync(inboxRoot); } catch { return []; } })()) {
		if (!name.startsWith("pi_peer_")) continue;
		const dir = path.join(inboxRoot, name);
		try {
			const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
			if (Number(meta.pid) !== job.notifyPid) continue;
			const message = {
				from_pid: process.pid,
				from_project: "rlm_query",
				exit_code: code,
				message: `[rlm_query --async result exit=${code}]\n\n${output.slice(-50_000)}`,
				timestamp: new Date().toISOString(),
				id: `async_${path.basename(path.dirname(job.jobPath))}`,
			};
			writeFileSync(path.join(dir, "inbox.jsonl"), `${JSON.stringify(message)}\n`, { flag: "a" });
			break;
		} catch {
			// Ignore malformed or concurrently removed peer directories.
		}
	}
}

export function finishAsyncJob(job: AsyncJob, code: number, output: string): void {
	writeFileSync(job.outputPath, output, { mode: 0o600 });
	writeFileSync(job.sentinelPath, `${code}\n`, { flag: "wx", mode: 0o600 });
	notifyPeer(job, code, output);
	rmSync(job.jobPath, { force: true });
	if (job.ownedContextPath) rmSync(job.ownedContextPath, { force: true });
	if (job.parentSessionSnapshot) rmSync(job.parentSessionSnapshot, { force: true });
	if (job.rootPromptSnapshot) rmSync(job.rootPromptSnapshot, { force: true });
	rmSync(job.childPidPath, { force: true });
}

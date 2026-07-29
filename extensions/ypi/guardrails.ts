import { constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { accessSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendOwnedPrivateFile,
	parsePrivateFileIdentity,
} from "./internal/private-path.ts";
import { atomicWriteFile } from "./internal/atomic-file.ts";
import { createPrivateDirectory } from "./internal/private-path.ts";

const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 500;
export const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function exactNonNegativeInteger(name: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}: ${JSON.stringify(value)} must be a non-negative integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}: ${JSON.stringify(value)} exceeds the safe integer range.`);
	return parsed;
}

function readCounter(filePath: string): number {
	const raw = existsSync(filePath)
		? readFileSync(filePath, "utf8").trim() || "0"
		: process.env.RLM_CALL_COUNT || "0";
	return exactNonNegativeInteger("RLM_CALL_COUNT/counter", raw);
}

export async function allocateCallCount(deadlineMilliseconds?: number): Promise<number> {
	const remaining = deadlineMilliseconds === undefined ? remainingTimeoutSeconds() : undefined;
	const deadline = deadlineMilliseconds ?? (remaining === undefined ? undefined : Date.now() + Math.max(0, remaining * 1000));
	const counterFile = process.env.RLM_CALL_COUNTER_FILE || path.join(tmpdir(), "rlm_calls_default.counter");
	process.env.RLM_CALL_COUNTER_FILE = counterFile;
	const lockDir = `${counterFile}.lock`;
	mkdirSync(path.dirname(counterFile), { recursive: true });

	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		if (deadline !== undefined && Date.now() >= deadline) {
			const error = new Error(`Timeout exceeded while waiting for call counter lock: ${lockDir}`) as Error & { exitCode: number };
			error.exitCode = 124;
			throw error;
		}
		try {
			createPrivateDirectory(lockDir);
			try {
				const next = readCounter(counterFile) + 1;
				atomicWriteFile(counterFile, `${next}\n`);
				process.env.RLM_CALL_COUNT = String(next);
				return next;
			} finally {
				rmSync(lockDir, { recursive: true, force: true });
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			await sleep(LOCK_RETRY_MS);
		}
	}

	throw new Error(`Timed out waiting for call counter lock: ${lockDir}`);
}

export function assertWithinMaxCalls(callCount: number): void {
	const configured = process.env.RLM_MAX_CALLS;
	if (configured === undefined || configured === "") return;
	const maxCalls = exactNonNegativeInteger("RLM_MAX_CALLS", configured);
	// callCount is the 1-based number of the call being allocated, so RLM_MAX_CALLS=N
	// must permit calls 1..N and only reject call N+1.
	if (callCount > maxCalls) {
		throw new Error(`Max calls exceeded: ${maxCalls} of ${maxCalls} child calls already used. Continue the task directly without spawning more children.`);
	}
}

export function remainingTimeoutSeconds(): number | undefined {
	const configured = process.env.RLM_TIMEOUT;
	if (configured === undefined || configured === "") return undefined;
	const timeout = exactNonNegativeInteger("RLM_TIMEOUT", configured);
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`Invalid RLM_TIMEOUT: ${JSON.stringify(configured)} exceeds the supported maximum of ${MAX_TIMEOUT_SECONDS} seconds.`,
		);
	}
	const now = Math.floor(Date.now() / 1000);
	const start = exactNonNegativeInteger("RLM_START_TIME", process.env.RLM_START_TIME || `${now}`);
	const elapsed = Math.max(0, now - start);
	return timeout - elapsed;
}

export function assertTimeoutAvailable(): number | undefined {
	const remaining = remainingTimeoutSeconds();
	if (remaining !== undefined && remaining <= 0) {
		const timeout = process.env.RLM_TIMEOUT || "0";
		throw new Error(`Timeout exceeded: no time remains from RLM_TIMEOUT=${timeout}. Increase RLM_TIMEOUT or simplify the task.`);
	}
	return remaining;
}

export interface CostSummary {
	cost: number;
	tokens: number;
}

export interface CostLedgerSummary extends CostSummary {
	incomplete: boolean;
}

export function readCostSummary(costFile = process.env.RLM_COST_FILE): CostLedgerSummary {
	if (!costFile || !existsSync(costFile)) {
		return { cost: 0, tokens: 0, incomplete: false };
	}

	let raw: string;
	try {
		raw = readFileSync(costFile, "utf8");
	} catch {
		return { cost: 0, tokens: 0, incomplete: true };
	}
	let cost = 0;
	let tokens = 0;
	let incomplete = false;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			cost += Number(parsed.cost || 0);
			tokens += Number(parsed.tokens || 0);
			if (parsed.incomplete === true) incomplete = true;
		} catch {
			// Ignore malformed cost lines; this matches rlm_cost's tolerant parser.
		}
	}
	return { cost, tokens, incomplete };
}

function appendTelemetryLine(line: string): void {
	if (!process.env.RLM_COST_FILE || !process.env.YPI_COST_FILE_IDENTITY) return;
	try {
		appendOwnedPrivateFile(
			process.env.RLM_COST_FILE,
			parsePrivateFileIdentity(process.env.YPI_COST_FILE_IDENTITY),
			`${line}\n`,
		);
	} catch {
		delete process.env.RLM_COST_FILE;
		delete process.env.YPI_COST_FILE_IDENTITY;
	}
}

export function appendCostSummary(summary: CostSummary): void {
	appendTelemetryLine(JSON.stringify(summary));
}

export function appendIncompleteCostMarker(reason: string): void {
	appendTelemetryLine(JSON.stringify({ incomplete: true, reason }));
}

export function canExecute(filePath: string): boolean {
	try {
		accessSync(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

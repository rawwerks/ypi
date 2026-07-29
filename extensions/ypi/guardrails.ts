import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendOwnedPrivateFile,
	parsePrivateFileIdentity,
} from "./internal/private-path.ts";
import { allocateCoordinatedCall } from "./internal/tree-coordinator.ts";

export const MAX_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

function exactNonNegativeInteger(name: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid ${name}: ${JSON.stringify(value)} must be a non-negative integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}: ${JSON.stringify(value)} exceeds the safe integer range.`);
	return parsed;
}

export async function allocateCallCount(
	deadlineMilliseconds?: number,
	signal?: AbortSignal,
): Promise<number> {
	const remaining = deadlineMilliseconds === undefined ? remainingTimeoutSeconds() : undefined;
	const deadline = deadlineMilliseconds ?? (remaining === undefined ? undefined : Date.now() + Math.max(0, remaining * 1000));
	const counterFile = process.env.RLM_CALL_COUNTER_FILE || path.join(tmpdir(), "rlm_calls_default.counter");
	process.env.RLM_CALL_COUNTER_FILE = counterFile;
	const maximum = exactNonNegativeInteger(
		"RLM_MAX_CALLS",
		process.env.RLM_MAX_CALLS || "65536",
	);
	const seed = exactNonNegativeInteger(
		"RLM_CALL_COUNT",
		process.env.RLM_CALL_COUNT || "0",
	);
	const next = await allocateCoordinatedCall(
		maximum,
		seed,
		counterFile,
		{ deadlineMilliseconds: deadline, signal },
	);
	process.env.RLM_CALL_COUNT = String(next);
	return next;
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

export const MAX_COST_LEDGER_BYTES = 16 * 1024 * 1024;

export interface CostLedgerReadLifecycleEvent {
	stage: "before-final-recheck";
	path: string;
	device: string;
	inode: string;
}

export type CostLedgerReadLifecycleHookForTests = (
	event: CostLedgerReadLifecycleEvent,
) => void;

let costLedgerReadLifecycleHookForTests:
	CostLedgerReadLifecycleHookForTests | undefined;

/** Test-only deterministic observational-read race hook. Inert by default. */
export function setCostLedgerReadLifecycleHookForTests(
	hook: CostLedgerReadLifecycleHookForTests | undefined,
): void {
	costLedgerReadLifecycleHookForTests = hook;
}

function sameCostFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev
		&& left.ino === right.ino
		&& left.uid === right.uid
		&& (left.mode & 0o777n) === (right.mode & 0o777n)
		&& left.nlink === right.nlink;
}

function sameCostFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return sameCostFileIdentity(left, right)
		&& left.size === right.size
		&& left.mtimeNs === right.mtimeNs
		&& left.ctimeNs === right.ctimeNs;
}

function assertPrivateCostFile(metadata: BigIntStats, candidate: string): void {
	const uid = process.getuid?.();
	if (
		!metadata.isFile()
		|| metadata.isSymbolicLink()
		|| metadata.nlink !== 1n
		|| (uid !== undefined && metadata.uid !== BigInt(uid))
		|| (
			process.platform !== "win32"
			&& (metadata.mode & 0o777n) !== 0o600n
		)
	) {
		throw new Error(`Cost ledger is not a current-user 0600 one-link regular file: ${candidate}`);
	}
	if (metadata.size < 0n || metadata.size > BigInt(MAX_COST_LEDGER_BYTES)) {
		throw new Error(`Cost ledger exceeds the supported size bound: ${candidate}`);
	}
}

function readPrivateCostLedger(candidate: string): string {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			candidate,
			constants.O_RDONLY
				| (constants.O_NOFOLLOW || 0)
				| (constants.O_NONBLOCK || 0),
		);
		const opened = fstatSync(descriptor, { bigint: true });
		assertPrivateCostFile(opened, candidate);
		const named = lstatSync(candidate, { bigint: true });
		assertPrivateCostFile(named, candidate);
		if (!sameCostFileSnapshot(opened, named)) {
			throw new Error(`Cost ledger pathname identity changed: ${candidate}`);
		}

		if (
			candidate === process.env.RLM_COST_FILE
			&& process.env.YPI_COST_FILE_IDENTITY
		) {
			const expected = parsePrivateFileIdentity(
				process.env.YPI_COST_FILE_IDENTITY,
			);
			if (
				expected.device !== opened.dev.toString()
				|| expected.inode !== opened.ino.toString()
				|| expected.kind !== "file"
				|| expected.mode !== Number(opened.mode & 0o777n)
				|| expected.links !== opened.nlink.toString()
			) {
				throw new Error("Inherited cost-ledger identity changed");
			}
		}

		const bytes = Buffer.alloc(Number(opened.size));
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(
				descriptor,
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (count <= 0) {
				throw new Error(`Cost ledger became shorter during observation: ${candidate}`);
			}
			offset += count;
		}

		costLedgerReadLifecycleHookForTests?.({
			stage: "before-final-recheck",
			path: candidate,
			device: opened.dev.toString(),
			inode: opened.ino.toString(),
		});
		const heldAfter = fstatSync(descriptor, { bigint: true });
		const namedAfter = lstatSync(candidate, { bigint: true });
		assertPrivateCostFile(heldAfter, candidate);
		assertPrivateCostFile(namedAfter, candidate);
		if (
			!sameCostFileSnapshot(opened, heldAfter)
			|| !sameCostFileSnapshot(opened, namedAfter)
		) {
			throw new Error(`Cost ledger changed during observation: ${candidate}`);
		}
		return bytes.toString("utf8");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function disableBadCostSink(candidate: string): void {
	if (process.env.RLM_COST_FILE !== candidate) return;
	delete process.env.RLM_COST_FILE;
	delete process.env.YPI_COST_FILE_IDENTITY;
}

export function readCostSummary(costFile = process.env.RLM_COST_FILE): CostLedgerSummary {
	if (!costFile) return { cost: 0, tokens: 0, incomplete: false };

	let raw: string;
	try {
		raw = readPrivateCostLedger(costFile);
	} catch {
		// Cost is observational. Invalid input disables only the matching sink
		// and must never block product work.
		disableBadCostSink(costFile);
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
			// Malformed individual telemetry records remain observational.
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

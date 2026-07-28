import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-file.ts";
import { processIsAlive } from "./process-liveness.ts";

export const DEFAULT_MAX_CONCURRENT_CALLS = 3;

const LOCK_RETRY_MILLISECONDS = 10;
const OWNERLESS_LOCK_GRACE_MILLISECONDS = 5_000;
const SLOT_TOKEN = /^[0-9a-f]{32}$/;
const SLOT_DIRECTORY = /^slot-([0-9a-f]{32})$/;
const STAGED_SLOT = /^\.slot-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.tmp$/;

interface ConcurrencySlotRecord {
	schemaVersion: 1;
	token: string;
	ownerPid: number;
	childPid?: number;
	createdAtEpochSeconds: number;
}

interface RegistryLock {
	release(): void;
}

export interface ConcurrencySlotLease {
	token: string;
	pidFile: string;
	readyFile: string;
	noteChildPid(pid: number): void;
	release(): Promise<void>;
}

export interface ConcurrencySlotOptions {
	deadlineMilliseconds?: number;
	signal?: AbortSignal;
}

export interface InheritedSlotSuspension {
	resume(): Promise<void>;
}

function controlError(message: string, exitCode = 1): Error & { exitCode: number } {
	const error = new Error(message) as Error & { exitCode: number };
	error.exitCode = exitCode;
	return error;
}

function exactPositiveInteger(name: string, raw: string): number {
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw controlError(`Invalid ${name}: ${JSON.stringify(raw)} must be a positive integer.`);
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) {
		throw controlError(`Invalid ${name}: ${JSON.stringify(raw)} exceeds the safe integer range.`);
	}
	return parsed;
}

function configuredMaximum(): number {
	return exactPositiveInteger(
		"RLM_MAX_CONCURRENT_CALLS",
		process.env.RLM_MAX_CONCURRENT_CALLS || String(DEFAULT_MAX_CONCURRENT_CALLS),
	);
}

function registryRoot(): string {
	const configured = process.env.RLM_CONCURRENCY_DIR;
	if (!configured) {
		throw controlError("RLM_CONCURRENCY_DIR is unavailable; initialize the canonical ypi environment before recursive admission.");
	}
	return configured;
}

function pathExistsWithoutFollowing(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function assertOwnedDirectory(candidate: string): void {
	const metadata = lstatSync(candidate);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw controlError(`Recursive concurrency path is not an owned directory: ${candidate}`);
	}
}

function ensureOwnedDirectory(candidate: string): void {
	let created = false;
	try {
		mkdirSync(candidate, { mode: 0o700 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	assertOwnedDirectory(candidate);
	if (created) chmodSync(candidate, 0o700);
}

function readRegularJson(candidate: string): unknown {
	const metadata = lstatSync(candidate);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw controlError(`Recursive concurrency metadata is not a regular file: ${candidate}`);
	}
	return JSON.parse(readFileSync(candidate, "utf8"));
}

function parseSlotRecord(value: unknown, expectedToken: string): ConcurrencySlotRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw controlError("Recursive concurrency slot metadata must be an object.");
	}
	const record = value as Partial<ConcurrencySlotRecord>;
	if (
		record.schemaVersion !== 1
		|| record.token !== expectedToken
		|| !SLOT_TOKEN.test(expectedToken)
		|| !Number.isSafeInteger(record.ownerPid)
		|| Number(record.ownerPid) <= 0
		|| (
			record.childPid !== undefined
			&& (!Number.isSafeInteger(record.childPid) || Number(record.childPid) <= 0)
		)
		|| !Number.isSafeInteger(record.createdAtEpochSeconds)
		|| Number(record.createdAtEpochSeconds) < 0
	) {
		throw controlError(`Recursive concurrency slot metadata is invalid for ${expectedToken}.`);
	}
	return record as ConcurrencySlotRecord;
}

function slotDirectory(root: string, token: string): string {
	if (!SLOT_TOKEN.test(token)) {
		throw controlError(`Invalid recursive concurrency slot token: ${JSON.stringify(token)}`);
	}
	return path.join(root, `slot-${token}`);
}

function readSlotRecord(root: string, token: string): ConcurrencySlotRecord {
	const directory = slotDirectory(root, token);
	assertOwnedDirectory(directory);
	return parseSlotRecord(
		readRegularJson(path.join(directory, "lease.json")),
		token,
	);
}

function removeSlotDirectory(root: string, token: string): void {
	const directory = slotDirectory(root, token);
	if (!pathExistsWithoutFollowing(directory)) return;
	assertOwnedDirectory(directory);
	const record = readSlotRecord(root, token);
	if (record.token !== token) {
		throw controlError(`Recursive concurrency slot ownership changed at ${directory}.`);
	}
	rmSync(directory, { recursive: true });
}

function lockOwnerAlive(lockPath: string): boolean | undefined {
	const ownerPath = path.join(lockPath, "owner.json");
	if (!pathExistsWithoutFollowing(ownerPath)) return undefined;
	try {
		const value = readRegularJson(ownerPath) as { pid?: unknown };
		const pid = Number(value?.pid);
		return Number.isSafeInteger(pid) && pid > 0 ? processIsAlive(pid) : undefined;
	} catch {
		return undefined;
	}
}

function recoverStaleLock(lockPath: string): boolean {
	if (!pathExistsWithoutFollowing(lockPath)) return true;
	assertOwnedDirectory(lockPath);
	if (lockOwnerAlive(lockPath) === true) return false;
	const age = Date.now() - statSync(lockPath).mtimeMs;
	if (age < OWNERLESS_LOCK_GRACE_MILLISECONDS) return false;
	rmSync(lockPath, { recursive: true });
	return true;
}

function assertWaitAllowed(options: ConcurrencySlotOptions, subject: string): void {
	if (options.signal?.aborted) {
		throw controlError(`Recursive child cancelled while waiting for ${subject}.`, 130);
	}
	if (
		options.deadlineMilliseconds !== undefined
		&& Date.now() >= options.deadlineMilliseconds
	) {
		throw controlError(`RLM_TIMEOUT expired while waiting for ${subject}.`, 124);
	}
}

function wait(options: ConcurrencySlotOptions): Promise<void> {
	assertWaitAllowed(options, "a concurrency slot");
	const remaining = options.deadlineMilliseconds === undefined
		? LOCK_RETRY_MILLISECONDS
		: Math.max(1, Math.min(
			LOCK_RETRY_MILLISECONDS,
			options.deadlineMilliseconds - Date.now(),
		));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			options.signal?.removeEventListener("abort", onAbort);
			resolve();
		}, remaining);
		const onAbort = () => {
			clearTimeout(timer);
			reject(controlError("Recursive child cancelled while waiting for a concurrency slot.", 130));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function acquireRegistryLock(
	root: string,
	options: ConcurrencySlotOptions,
): Promise<RegistryLock> {
	const lockPath = `${root}.lock`;
	while (true) {
		assertWaitAllowed(options, "the concurrency registry lock");
		let created = false;
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			created = true;
			chmodSync(lockPath, 0o700);
			const token = randomBytes(16).toString("hex");
			atomicWriteJson(path.join(lockPath, "owner.json"), {
				schemaVersion: 1,
				token,
				pid: process.pid,
				createdAtEpochSeconds: Math.floor(Date.now() / 1000),
			});
			return {
				release() {
					try {
						const owner = readRegularJson(path.join(lockPath, "owner.json")) as {
							token?: unknown;
						};
						if (owner.token === token) rmSync(lockPath, { recursive: true });
					} catch {
						// Uncertain lock ownership is preserved for stale-lock recovery.
					}
				},
			};
		} catch (error) {
			if (created) {
				rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (recoverStaleLock(lockPath)) continue;
			await wait(options);
		}
	}
}

async function withRegistryLock<T>(
	root: string,
	options: ConcurrencySlotOptions,
	action: () => T,
): Promise<T> {
	const lock = await acquireRegistryLock(root, options);
	try {
		return action();
	} finally {
		lock.release();
	}
}

function scanLiveSlots(root: string): ConcurrencySlotRecord[] {
	ensureOwnedDirectory(root);
	const live: ConcurrencySlotRecord[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const staged = STAGED_SLOT.exec(entry.name);
		if (staged) {
			const candidate = path.join(root, entry.name);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				throw controlError(`Recursive concurrency registry contains invalid staged state: ${candidate}`);
			}
			if (processIsAlive(Number(staged[2]))) {
				throw controlError(`Recursive concurrency registry contains live incomplete state: ${candidate}`);
			}
			rmSync(candidate, { recursive: true });
			continue;
		}
		const match = SLOT_DIRECTORY.exec(entry.name);
		if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
			throw controlError(`Recursive concurrency registry contains unexpected state: ${path.join(root, entry.name)}`);
		}
		const record = readSlotRecord(root, match[1]);
		if (processIsAlive(record.ownerPid) || processIsAlive(record.childPid)) {
			live.push(record);
		} else {
			removeSlotDirectory(root, record.token);
		}
	}
	return live;
}

function createSlot(
	root: string,
	token: string,
	childPid?: number,
): ConcurrencySlotLease {
	const directory = slotDirectory(root, token);
	if (pathExistsWithoutFollowing(directory)) {
		throw controlError(`Recursive concurrency slot already exists: ${directory}`);
	}
	const staging = path.join(
		root,
		`.slot-${token}-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	mkdirSync(staging, { mode: 0o700 });
	chmodSync(staging, 0o700);
	const record: ConcurrencySlotRecord = {
		schemaVersion: 1,
		token,
		ownerPid: process.pid,
		...(childPid === undefined ? {} : { childPid }),
		createdAtEpochSeconds: Math.floor(Date.now() / 1000),
	};
	try {
		atomicWriteJson(path.join(staging, "lease.json"), record);
		renameSync(staging, directory);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}

	let releasePromise: Promise<void> | undefined;
	return {
		token,
		pidFile: path.join(directory, "child-pid"),
		readyFile: path.join(directory, "child-ready"),
		noteChildPid(pid: number) {
			if (releasePromise) throw controlError("Recursive concurrency slot was released before child PID registration.");
			if (!Number.isSafeInteger(pid) || pid <= 0) {
				throw controlError(`Invalid recursive child PID: ${pid}`);
			}
			const current = readSlotRecord(root, token);
			if (current.ownerPid !== process.pid) {
				throw controlError(`Recursive concurrency slot ${token} is no longer owned by this process.`);
			}
			atomicWriteJson(path.join(directory, "lease.json"), {
				...current,
				childPid: pid,
			});
		},
		release(): Promise<void> {
			releasePromise ??= withRegistryLock(root, {}, () => {
				removeSlotDirectory(root, token);
			});
			return releasePromise;
		},
	};
}

async function acquireSlotWithToken(
	token: string,
	options: ConcurrencySlotOptions,
	childPid?: number,
): Promise<ConcurrencySlotLease> {
	const root = registryRoot();
	const maximum = configuredMaximum();
	while (true) {
		assertWaitAllowed(options, "a concurrency slot");
		const lease = await withRegistryLock(root, options, () => {
			const live = scanLiveSlots(root);
			if (live.length >= maximum) return undefined;
			return createSlot(root, token, childPid);
		});
		if (lease) return lease;
		await wait(options);
	}
}

export function concurrencySlotExists(token: string): boolean {
	return pathExistsWithoutFollowing(slotDirectory(registryRoot(), token));
}

export function acquireConcurrencySlot(
	options: ConcurrencySlotOptions = {},
): Promise<ConcurrencySlotLease> {
	return acquireSlotWithToken(randomBytes(16).toString("hex"), options);
}

let inheritedToken: string | undefined;
let nestedDelegations = 0;
let transitionQueue: Promise<unknown> = Promise.resolve();

function serializeTransition<T>(action: () => Promise<T>): Promise<T> {
	const result = transitionQueue.then(action, action);
	transitionQueue = result.then(() => undefined, () => undefined);
	return result;
}

function synchronizeInheritedToken(): void {
	if (nestedDelegations !== 0) return;
	const configured = process.env.RLM_ACTIVE_SLOT_TOKEN;
	if (configured && !SLOT_TOKEN.test(configured)) {
		throw controlError(`Invalid RLM_ACTIVE_SLOT_TOKEN: ${JSON.stringify(configured)}`);
	}
	inheritedToken = configured || undefined;
}

async function removeInheritedSlot(
	token: string,
	options: ConcurrencySlotOptions,
): Promise<void> {
	const root = registryRoot();
	await withRegistryLock(root, options, () => {
		const record = readSlotRecord(root, token);
		if (record.childPid !== process.pid && record.ownerPid !== process.pid) {
			throw controlError(`Recursive process ${process.pid} does not own inherited concurrency slot ${token}.`);
		}
		removeSlotDirectory(root, token);
	});
}

export async function suspendInheritedConcurrencySlot(
	options: ConcurrencySlotOptions = {},
): Promise<InheritedSlotSuspension> {
	let participates = false;
	let resumed = false;
	await serializeTransition(async () => {
		synchronizeInheritedToken();
		if (!inheritedToken) return;
		if (nestedDelegations === 0) await removeInheritedSlot(inheritedToken, options);
		nestedDelegations++;
		participates = true;
	});
	return {
		async resume() {
			if (resumed) return;
			resumed = true;
			await serializeTransition(async () => {
				if (!participates || !inheritedToken) return;
				nestedDelegations--;
				if (nestedDelegations < 0) {
					throw controlError("Recursive concurrency suspension accounting underflowed.");
				}
				if (nestedDelegations === 0) {
					await acquireSlotWithToken(inheritedToken, {}, process.pid);
				}
			});
		},
	};
}

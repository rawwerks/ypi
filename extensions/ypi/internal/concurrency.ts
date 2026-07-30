import { randomBytes } from "node:crypto";
import {
	acquireCoordinatedSlot,
	releaseCoordinatedSlot,
	resumeCoordinatedSlot,
	suspendCoordinatedSlot,
	treeCoordinatorHasSlotForTests,
	type CoordinatorWaitOptions,
} from "./tree-coordinator.ts";

export const DEFAULT_MAX_CONCURRENT_CALLS = 3;

const SLOT_TOKEN = /^[0-9a-f]{32}$/;

export interface ConcurrencySlotLease {
	token: string;
	noteChildPid(pid: number): void;
	release(): Promise<void>;
}

export interface ConcurrencySlotOptions extends CoordinatorWaitOptions {}

export interface InheritedSlotSuspension {
	resume(): Promise<void>;
}

function controlError(message: string): Error & { exitCode: number } {
	const error = new Error(message) as Error & { exitCode: number };
	error.exitCode = 1;
	return error;
}

function configuredMaximum(): number {
	const raw = process.env.RLM_MAX_CONCURRENT_CALLS
		|| String(DEFAULT_MAX_CONCURRENT_CALLS);
	if (!/^[1-9][0-9]*$/.test(raw)) {
		throw controlError(
			`Invalid RLM_MAX_CONCURRENT_CALLS: ${JSON.stringify(raw)} must be a positive integer.`,
		);
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) {
		throw controlError(
			`Invalid RLM_MAX_CONCURRENT_CALLS: ${JSON.stringify(raw)} exceeds the safe integer range.`,
		);
	}
	return parsed;
}

async function acquireSlotWithToken(
	token: string,
	options: ConcurrencySlotOptions,
): Promise<ConcurrencySlotLease> {
	if (!SLOT_TOKEN.test(token)) {
		throw controlError(
			`Invalid recursive concurrency slot token: ${JSON.stringify(token)}`,
		);
	}
	await acquireCoordinatedSlot(token, configuredMaximum(), options);
	let releasePromise: Promise<void> | undefined;
	return {
		token,
		noteChildPid(pid: number) {
			if (releasePromise) {
				throw controlError(
					"Recursive concurrency slot was released before child PID registration.",
				);
			}
			if (!Number.isSafeInteger(pid) || pid <= 0) {
				throw controlError(`Invalid recursive child PID: ${pid}`);
			}
			// The launch gate binds the stable process identity directly with the
			// coordinator immediately before exec. This synchronous callback only
			// validates the parent's observation.
		},
		release() {
			releasePromise ??= releaseCoordinatedSlot(token);
			return releasePromise;
		},
	};
}

export function acquireConcurrencySlot(
	options: ConcurrencySlotOptions = {},
): Promise<ConcurrencySlotLease> {
	return acquireSlotWithToken(randomBytes(16).toString("hex"), options);
}

export function concurrencySlotExists(token: string): boolean {
	if (!SLOT_TOKEN.test(token)) return false;
	return treeCoordinatorHasSlotForTests(token);
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
		throw controlError(
			`Invalid RLM_ACTIVE_SLOT_TOKEN: ${JSON.stringify(configured)}`,
		);
	}
	inheritedToken = configured || undefined;
}

export async function suspendInheritedConcurrencySlot(
	options: ConcurrencySlotOptions = {},
): Promise<InheritedSlotSuspension> {
	let participates = false;
	let participationReleased = false;
	let resumed = false;
	let resumePromise: Promise<void> | undefined;
	await serializeTransition(async () => {
		synchronizeInheritedToken();
		if (!inheritedToken) return;
		if (nestedDelegations === 0) {
			await suspendCoordinatedSlot(inheritedToken, options);
		}
		nestedDelegations++;
		participates = true;
	});
	return {
		resume() {
			if (resumed) return Promise.resolve();
			resumePromise ??= serializeTransition(async () => {
				if (!participates || !inheritedToken) {
					resumed = true;
					return;
				}
				if (!participationReleased) {
					nestedDelegations--;
					participationReleased = true;
					if (nestedDelegations < 0) {
						throw controlError(
							"Recursive concurrency suspension accounting underflowed.",
						);
					}
				}
				if (nestedDelegations === 0) {
					// Cancellation of the delegated call does not cancel structural
					// accounting restoration. A terminal tree authority still rejects
					// this request immediately.
					await resumeCoordinatedSlot(
						inheritedToken,
						configuredMaximum(),
						{
							deadlineMilliseconds: options.deadlineMilliseconds,
						},
					);
				}
				resumed = true;
			}).catch((error) => {
				resumePromise = undefined;
				throw error;
			});
			return resumePromise;
		},
	};
}

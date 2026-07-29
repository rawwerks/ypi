import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { allocateCallCount } from "../extensions/ypi/guardrails.ts";
import { atomicCreateFile } from "../extensions/ypi/internal/atomic-file.ts";
import {
	acquireConcurrencySlot,
	concurrencySlotExists,
	suspendInheritedConcurrencySlot,
} from "../extensions/ypi/internal/concurrency.ts";
import {
	assertTreeCoordinatorActive,
	beginRootTreeCoordinator,
	ensureRootTreeCoordinator,
	registerCoordinatedLaunch,
	terminateRootTreeCoordinator,
	treeAuthorityManifestForTests,
	treeCoordinatorSlotCountForTests,
	treeCoordinatorSocketExistsForTests,
} from "../extensions/ypi/internal/tree-coordinator.ts";
import {
	currentProcessStartIdentity,
	processGroupId,
	processMatchesStartIdentity,
} from "../extensions/ypi/internal/process-identity.ts";

async function waitForFile(candidate: string, timeoutMilliseconds = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!existsSync(candidate)) {
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${candidate}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function worker(): Promise<never> {
	const marker = process.env.YPI_CONCURRENCY_MARKER;
	if (!marker) throw new Error("worker marker is required");
	atomicCreateFile(`${marker}.started`, `${process.pid}\n`);
	const lease = await acquireConcurrencySlot();
	atomicCreateFile(`${marker}.acquired`, `${lease.token}\n`);
	if (process.argv[3] === "child") {
		const child = spawn("/bin/sleep", ["30"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) throw new Error("worker child PID is unavailable");
		child.unref();
		try {
			await registerCoordinatedLaunch(lease.token, child.pid);
			atomicCreateFile(
				marker,
				`${JSON.stringify({ token: lease.token, childPid: child.pid })}\n`,
			);
		} catch (error) {
			atomicCreateFile(marker, `${JSON.stringify({
				token: lease.token,
				childPid: child.pid,
				error: error instanceof Error ? error.message : String(error),
			})}\n`);
			throw error;
		}
	} else {
		atomicCreateFile(marker, `${JSON.stringify({ token: lease.token })}\n`);
	}
	await new Promise(() => {});
	throw new Error("unreachable");
}

async function orphanProbe(): Promise<void> {
	const ready = process.env.YPI_ORPHAN_READY;
	const result = process.env.YPI_ORPHAN_RESULT;
	if (!ready || !result) throw new Error("orphan probe paths are required");
	atomicCreateFile(ready, `${JSON.stringify({
		pid: process.pid,
		processIdentity: currentProcessStartIdentity(),
		processGroupId: processGroupId(process.pid),
	})}\n`);
	const authorityFile = process.env.YPI_TREE_AUTHORITY_FILE;
	if (!authorityFile) throw new Error("orphan probe authority path is required");
	const authority = JSON.parse(readFileSync(authorityFile, "utf8")) as {
		rootPid?: unknown;
		rootProcessIdentity?: unknown;
	};
	const rootPid = Number(authority.rootPid);
	const rootIdentity = typeof authority.rootProcessIdentity === "string"
		? authority.rootProcessIdentity
		: undefined;
	const deadline = Date.now() + 5_000;
	while (processMatchesStartIdentity(rootPid, rootIdentity)) {
		if (Date.now() >= deadline) {
			throw new Error("orphan probe timed out waiting for root death");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	try {
		await assertTreeCoordinatorActive();
		atomicCreateFile(result, `${JSON.stringify({
			exitCode: 0,
			error: "orphan admission unexpectedly succeeded",
		})}\n`);
	} catch (error) {
		atomicCreateFile(result, `${JSON.stringify({
			exitCode: (error as Error & { exitCode?: number }).exitCode || 1,
			error: error instanceof Error ? error.message : String(error),
			counterExists: existsSync(process.env.RLM_CALL_COUNTER_FILE || ""),
		})}\n`);
	}
}

async function abruptRootOwner(): Promise<never> {
	const marker = process.env.YPI_ABRUPT_ROOT_MARKER;
	if (!marker) throw new Error("abrupt root marker is required");
	ensureRootTreeCoordinator();
	await assertTreeCoordinatorActive();
	const orphan = spawn(
		process.execPath,
		[import.meta.path, "--orphan-probe"],
		{
			detached: true,
			env: process.env,
			stdio: "ignore",
		},
	);
	if (!orphan.pid) throw new Error("orphan probe PID is unavailable");
	orphan.unref();
	atomicCreateFile(marker, `${JSON.stringify({
		pid: process.pid,
		processIdentity: currentProcessStartIdentity(),
		orphanPid: orphan.pid,
		authority: treeAuthorityManifestForTests(),
	})}\n`);
	setInterval(() => {}, 1_000);
	await new Promise(() => {});
	throw new Error("unreachable");
}

async function adoptedCounterOwner(): Promise<void> {
	ensureRootTreeCoordinator();
	try {
		await assertTreeCoordinatorActive();
		const next = await allocateCallCount();
		console.log(JSON.stringify({ next }));
	} finally {
		await terminateRootTreeCoordinator("adopted-counter-owner-complete");
	}
}

if (process.argv[2] === "--worker") {
	try {
		await worker();
	} catch (error) {
		const marker = process.env.YPI_CONCURRENCY_MARKER;
		if (marker && !existsSync(marker)) {
			atomicCreateFile(marker, `${JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			})}\n`);
		}
		throw error;
	}
}
if (process.argv[2] === "--orphan-probe") {
	await orphanProbe();
	process.exit(0);
}
if (process.argv[2] === "--abrupt-root-owner") {
	await abruptRootOwner();
}
if (process.argv[2] === "--adopted-counter-owner") {
	await adoptedCounterOwner();
	process.exit(0);
}

let pass = 0;
let fail = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  PASS ${label}`);
	} else {
		fail++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

async function expectReject(
	label: string,
	expectedCode: number,
	action: () => Promise<unknown>,
): Promise<void> {
	try {
		await action();
		record(false, label, "did not reject");
	} catch (error) {
		record(
			(error as Error & { exitCode?: number }).exitCode === expectedCode,
			label,
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function nextTurn(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

function waitForProcessExit(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve());
	});
}

console.log("\n=== Recursive concurrency harness ===");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_concurrency."));
process.env.RLM_DEPTH = "0";
process.env.RLM_CONCURRENCY_DIR = path.join(scratch, "registry");
process.env.RLM_CALL_COUNTER_FILE = path.join(scratch, "calls.counter");
process.env.RLM_MAX_CONCURRENT_CALLS = "3";
process.env.RLM_MAX_CALLS = "65536";
process.env.RLM_CALL_COUNT = "0";
delete process.env.RLM_ACTIVE_SLOT_TOKEN;
ensureRootTreeCoordinator();

try {
	await assertTreeCoordinatorActive();
	record(
		treeCoordinatorSocketExistsForTests()
			&& treeAuthorityManifestForTests()?.status === "active",
		"root publishes one active generation-bound coordinator",
	);

	const authorityFile = process.env.YPI_TREE_AUTHORITY_FILE;
	const authorityRaw = readFileSync(authorityFile, "utf8");
	writeFileSync(authorityFile, "{");
	await expectReject(
		"a torn authority manifest fails closed",
		130,
		() => assertTreeCoordinatorActive(),
	);
	writeFileSync(authorityFile, authorityRaw);
	await assertTreeCoordinatorActive();
	const heldAuthority = `${authorityFile}.owned`;
	renameSync(authorityFile, heldAuthority);
	atomicCreateFile(authorityFile, authorityRaw, { mode: 0o600 });
	await expectReject(
		"an authority pathname successor fails exact-identity admission",
		130,
		() => assertTreeCoordinatorActive(),
	);
	rmSync(authorityFile);
	renameSync(heldAuthority, authorityFile);
	await assertTreeCoordinatorActive();
	record(
		readFileSync(authorityFile, "utf8") === authorityRaw,
		"exact authority restoration re-enables admission without replacement trust",
	);

	const firstCall = await allocateCallCount();
	const counterFile = process.env.RLM_CALL_COUNTER_FILE;
	const heldCounter = `${counterFile}.owned`;
	renameSync(counterFile, heldCounter);
	atomicCreateFile(counterFile, "successor-canary\n", { mode: 0o600 });
	await expectReject(
		"call projection rejects a pathname successor without consuming a call",
		1,
		() => allocateCallCount(),
	);
	record(
		readFileSync(counterFile, "utf8") === "successor-canary\n",
		"call projection preserves an unrelated pathname successor",
	);
	rmSync(counterFile);
	renameSync(heldCounter, counterFile);
	const retriedCall = await allocateCallCount();
	record(
		firstCall === 1
			&& retriedCall === 2
			&& readFileSync(counterFile, "utf8") === "2\n",
		"failed exact-identity projection remains retryable without a count gap",
	);
	const continuationDirectory = path.join(scratch, "continuation");
	const continuationCounter = path.join(continuationDirectory, "calls.counter");
	mkdirSync(continuationDirectory, { mode: 0o700 });
	atomicCreateFile(continuationCounter, "7\n", { mode: 0o600 });
	const continuation = spawn(
		process.execPath,
		[import.meta.path, "--adopted-counter-owner"],
		{
			env: {
				...process.env,
				RLM_DEPTH: "0",
				RLM_CONCURRENCY_DIR: path.join(continuationDirectory, "c"),
				RLM_CALL_COUNTER_FILE: continuationCounter,
				RLM_CALL_COUNT: "7",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let continuationOutput = "";
	let continuationError = "";
	continuation.stdout.setEncoding("utf8");
	continuation.stderr.setEncoding("utf8");
	continuation.stdout.on("data", (chunk: string) => {
		continuationOutput += chunk;
	});
	continuation.stderr.on("data", (chunk: string) => {
		continuationError += chunk;
	});
	const continuationExit = await new Promise<number | null>((resolve, reject) => {
		continuation.once("error", reject);
		continuation.once("close", resolve);
	});
	record(
		continuationExit === 0
			&& JSON.parse(continuationOutput).next === 8
			&& readFileSync(continuationCounter, "utf8") === "8\n",
		"a fresh root process adopts an exact private continuation counter",
		JSON.stringify({
			continuationExit,
			continuationOutput,
			continuationError,
		}),
	);
	const mismatchedCounter = path.join(continuationDirectory, "mismatched.counter");
	atomicCreateFile(mismatchedCounter, "7\n", { mode: 0o600 });
	const mismatchedContinuation = spawn(
		process.execPath,
		[import.meta.path, "--adopted-counter-owner"],
		{
			env: {
				...process.env,
				RLM_DEPTH: "0",
				RLM_CONCURRENCY_DIR: path.join(continuationDirectory, "mismatched-c"),
				RLM_CALL_COUNTER_FILE: mismatchedCounter,
				RLM_CALL_COUNT: "6",
			},
			stdio: "ignore",
		},
	);
	const mismatchedExit = await new Promise<number | null>((resolve, reject) => {
		mismatchedContinuation.once("error", reject);
		mismatchedContinuation.once("close", resolve);
	});
	record(
		mismatchedExit !== 0
			&& readFileSync(mismatchedCounter, "utf8") === "7\n",
		"a fresh root rejects and preserves a continuation counter with a mismatched seed",
		`exit=${mismatchedExit}`,
	);
	beginRootTreeCoordinator("concurrency-root-turn-transfer");
	await assertTreeCoordinatorActive();
	const nextGenerationCall = await allocateCallCount();
	record(
		nextGenerationCall === 1
			&& readFileSync(counterFile, "utf8") === "1\n",
		"a new root generation resets through the exact prior counter inode",
	);

	const first = await acquireConcurrencySlot();
	const second = await acquireConcurrencySlot();
	const third = await acquireConcurrencySlot();
	let fourthSettled = false;
	const fourthPromise = acquireConcurrencySlot().then((lease) => {
		fourthSettled = true;
		return lease;
	});
	await nextTurn();
	record(!fourthSettled, "a fourth sibling queues behind three active slots");
	await first.release();
	const fourth = await fourthPromise;
	record(fourthSettled, "queued sibling runs when one slot is released");
	await Promise.all([second.release(), third.release(), fourth.release()]);

	const cancellationSlots = await Promise.all([
		acquireConcurrencySlot(),
		acquireConcurrencySlot(),
		acquireConcurrencySlot(),
	]);
	const controller = new AbortController();
	const cancelled = acquireConcurrencySlot({ signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	await expectReject(
		"queued admission is cancellable without consuming a slot",
		130,
		() => cancelled,
	);
	await Promise.all(cancellationSlots.map((lease) => lease.release()));
	record(
		treeCoordinatorSlotCountForTests() === 0,
		"cancelled queue cleanup leaves no phantom slot",
		`slots=${treeCoordinatorSlotCountForTests()}`,
	);

	const deadlineSlots = await Promise.all([
		acquireConcurrencySlot(),
		acquireConcurrencySlot(),
		acquireConcurrencySlot(),
	]);
	const deadlineStarted = Date.now();
	await expectReject(
		"coordinator queue admission obeys the tree deadline",
		124,
		() => acquireConcurrencySlot({
			deadlineMilliseconds: deadlineStarted + 100,
		}),
	);
	record(
		Date.now() - deadlineStarted < 1_000,
		"coordinator deadline rejects without an unbounded lock wait",
	);
	await Promise.all(deadlineSlots.map((lease) => lease.release()));

	const staleMarker = path.join(scratch, "stale-worker.json");
	const staleWorker = spawn(
		process.execPath,
		[import.meta.path, "--worker", "owner"],
		{
			env: {
				...process.env,
				YPI_CONCURRENCY_MARKER: staleMarker,
			},
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	await waitForFile(staleMarker);
	const staleState = JSON.parse(readFileSync(staleMarker, "utf8")) as {
		token?: string;
		error?: string;
	};
	if (staleState.error || !staleState.token) {
		throw new Error(staleState.error || "stale worker returned no token");
	}
	const staleToken = staleState.token;
	const staleExit = waitForProcessExit(staleWorker);
	staleWorker.kill("SIGKILL");
	await staleExit;
	const afterCrash = await acquireConcurrencySlot();
	record(
		!concurrencySlotExists(staleToken),
		"dead owner slots are ignored without deleting filesystem claims",
	);
	await afterCrash.release();

	const childMarker = path.join(scratch, "child-worker.json");
	const childWorker = spawn(
		process.execPath,
		[import.meta.path, "--worker", "child"],
		{
			env: {
				...process.env,
				YPI_CONCURRENCY_MARKER: childMarker,
			},
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	await waitForFile(childMarker);
	const childState = JSON.parse(readFileSync(childMarker, "utf8")) as {
		token: string;
		childPid: number;
		error?: string;
	};
	if (childState.error) throw new Error(childState.error);
	const childExit = waitForProcessExit(childWorker);
	childWorker.kill("SIGKILL");
	await childExit;
	const survivorA = await acquireConcurrencySlot();
	const survivorB = await acquireConcurrencySlot();
	const survivorController = new AbortController();
	const blockedByLiveChild = acquireConcurrencySlot({
		signal: survivorController.signal,
	});
	setTimeout(() => survivorController.abort(), 50);
	await expectReject(
		"a live stable child identity preserves its slot after owner death",
		130,
		() => blockedByLiveChild,
	);
	try {
		const target = processGroupId(childState.childPid) === childState.childPid
			? -childState.childPid
			: childState.childPid;
		process.kill(target, "SIGKILL");
	} catch {
		// The child may already be gone.
	}
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(childState.childPid, 0);
			await new Promise((resolve) => setTimeout(resolve, 10));
		} catch {
			break;
		}
	}
	const afterChildDeath = await acquireConcurrencySlot();
	record(
		!concurrencySlotExists(childState.token),
		"registered slot is pruned only after stable owner and child identities die",
	);
	await Promise.all([
		survivorA.release(),
		survivorB.release(),
		afterChildDeath.release(),
	]);

	const inherited = await acquireConcurrencySlot();
	process.env.RLM_ACTIVE_SLOT_TOKEN = inherited.token;
	const occupiedA = await acquireConcurrencySlot();
	const occupiedB = await acquireConcurrencySlot();
	const suspensionA = await suspendInheritedConcurrencySlot();
	const suspensionB = await suspendInheritedConcurrencySlot();
	record(
		!concurrencySlotExists(inherited.token),
		"nested delegation yields the inherited slot once",
	);
	const descendant = await acquireConcurrencySlot();
	await suspensionA.resume();
	record(
		!concurrencySlotExists(inherited.token),
		"the inherited slot stays yielded until every nested call settles",
	);
	await descendant.release();
	await suspensionB.resume();
	record(
		concurrencySlotExists(inherited.token),
		"the inherited slot is restored after the nested batch",
	);
	await Promise.all([
		inherited.release(),
		occupiedA.release(),
		occupiedB.release(),
	]);
	delete process.env.RLM_ACTIVE_SLOT_TOKEN;

	const retryable = await acquireConcurrencySlot();
	process.env.RLM_ACTIVE_SLOT_TOKEN = retryable.token;
	const retrySuspension = await suspendInheritedConcurrencySlot();
	process.env.RLM_MAX_CONCURRENT_CALLS = "4";
	await expectReject(
		"a cap mismatch rejects inherited-slot restoration",
		1,
		() => retrySuspension.resume(),
	);
	process.env.RLM_MAX_CONCURRENT_CALLS = "3";
	await retrySuspension.resume();
	record(
		concurrencySlotExists(retryable.token),
		"failed inherited-slot restoration remains retryable",
	);
	await retryable.release();
	delete process.env.RLM_ACTIVE_SLOT_TOKEN;

	const cancelledInherited = await acquireConcurrencySlot();
	process.env.RLM_ACTIVE_SLOT_TOKEN = cancelledInherited.token;
	const resumeController = new AbortController();
	const cancelledSuspension = await suspendInheritedConcurrencySlot({
		signal: resumeController.signal,
	});
	resumeController.abort();
	await cancelledSuspension.resume();
	record(
		concurrencySlotExists(cancelledInherited.token),
		"delegated-call cancellation does not cancel structural slot restoration",
	);
	await cancelledInherited.release();
	delete process.env.RLM_ACTIVE_SLOT_TOKEN;

	process.env.RLM_MAX_CONCURRENT_CALLS = "0";
	await expectReject(
		"malformed concurrency limits fail closed",
		1,
		() => acquireConcurrencySlot(),
	);
	process.env.RLM_MAX_CONCURRENT_CALLS = "3";

	const abruptDirectory = path.join(scratch, "abrupt");
	const abruptRootMarker = path.join(abruptDirectory, "root.json");
	const orphanReady = path.join(abruptDirectory, "orphan-ready.json");
	const orphanResult = path.join(abruptDirectory, "orphan-result.json");
	mkdirSync(abruptDirectory, { mode: 0o700 });
	const abruptRoot = spawn(
		process.execPath,
		[import.meta.path, "--abrupt-root-owner"],
		{
			env: {
				...process.env,
				RLM_DEPTH: "0",
				RLM_CONCURRENCY_DIR: path.join(abruptDirectory, "c"),
				RLM_CALL_COUNTER_FILE: path.join(abruptDirectory, "calls.counter"),
				RLM_CALL_COUNT: "0",
				YPI_ABRUPT_ROOT_MARKER: abruptRootMarker,
				YPI_ORPHAN_READY: orphanReady,
				YPI_ORPHAN_RESULT: orphanResult,
			},
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	await Promise.all([
		waitForFile(abruptRootMarker),
		waitForFile(orphanReady),
	]);
	const abruptState = JSON.parse(readFileSync(abruptRootMarker, "utf8")) as {
		pid: number;
		processIdentity: string;
		orphanPid: number;
		authority: { status: string; rootProcessIdentity: string };
	};
	const orphanState = JSON.parse(readFileSync(orphanReady, "utf8")) as {
		pid: number;
		processIdentity: string;
		processGroupId?: number;
	};
	const abruptExit = waitForProcessExit(abruptRoot);
	abruptRoot.kill("SIGKILL");
	await abruptExit;
	await waitForFile(orphanResult);
	const orphanOutcome = JSON.parse(readFileSync(orphanResult, "utf8")) as {
		exitCode: number;
		error?: string;
		counterExists?: boolean;
	};
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!processMatchesStartIdentity(orphanState.pid, orphanState.processIdentity)) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	record(
		abruptState.authority.status === "active"
			&& abruptState.authority.rootProcessIdentity === abruptState.processIdentity
			&& orphanState.processGroupId === orphanState.pid
			&& orphanOutcome.exitCode === 130
			&& orphanOutcome.error?.includes("root identity is no longer live") === true
			&& orphanOutcome.counterExists === false,
		"abrupt root death revokes independently detached descendant admission by stable identity",
		JSON.stringify({ abruptState, orphanState, orphanOutcome }),
	);
	record(
		!processMatchesStartIdentity(orphanState.pid, orphanState.processIdentity),
		"orphan probe terminates after the failed post-death admission",
	);

	const entries = readdirSync(process.env.RLM_CONCURRENCY_DIR);
	record(
		entries.every(
			(entry) => !entry.endsWith(".lock")
				&& !entry.startsWith("slot-")
				&& !entry.startsWith(".slot-"),
		),
		"coordinator admission creates no ownerless lock or staged slot claims",
		entries.join(","),
	);
} finally {
	await terminateRootTreeCoordinator("concurrency-harness-complete");
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	acquireConcurrencySlot,
	concurrencySlotExists,
	suspendInheritedConcurrencySlot,
} from "../extensions/ypi/internal/concurrency.ts";

async function waitForFile(candidate: string, timeoutMilliseconds = 5_000): Promise<void> {
	if (existsSync(candidate)) return;
	await new Promise<void>((resolve, reject) => {
		const watcher = watch(path.dirname(candidate), () => {
			if (!existsSync(candidate)) return;
			clearTimeout(timer);
			watcher.close();
			resolve();
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${candidate}`));
		}, timeoutMilliseconds);
	});
}

async function worker(): Promise<never> {
	const marker = process.env.YPI_CONCURRENCY_MARKER;
	if (!marker) throw new Error("worker marker is required");
	const lease = await acquireConcurrencySlot();
	if (process.argv[3] === "child") {
		const child = spawn("/bin/sleep", ["30"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) throw new Error("worker child PID is unavailable");
		child.unref();
		lease.noteChildPid(child.pid);
		writeFileSync(marker, `${JSON.stringify({ token: lease.token, childPid: child.pid })}\n`);
	} else {
		writeFileSync(marker, `${JSON.stringify({ token: lease.token })}\n`);
	}
	await new Promise(() => {});
	throw new Error("unreachable");
}

if (process.argv[2] === "--worker") await worker();

let pass = 0;
let fail = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
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

function slotCount(root: string): number {
	if (!existsSync(root)) return 0;
	return readdirSync(root).filter((entry) => entry.startsWith("slot-")).length;
}

async function nextTurn(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

console.log("\n=== Recursive concurrency harness ===");
const scratch = mkdtempSync(path.join(tmpdir(), "ypi_concurrency."));
const registry = path.join(scratch, "registry");
process.env.RLM_CONCURRENCY_DIR = registry;
process.env.RLM_MAX_CONCURRENT_CALLS = "3";
delete process.env.RLM_ACTIVE_SLOT_TOKEN;

try {
	const first = await acquireConcurrencySlot();
	const second = await acquireConcurrencySlot();
	const third = await acquireConcurrencySlot();
	let fourthSettled = false;
	const fourthPromise = acquireConcurrencySlot().then((lease) => {
		fourthSettled = true;
		return lease;
	});
	await nextTurn();
	record(!fourthSettled && slotCount(registry) === 3, "a fourth sibling queues behind three active slots");
	await first.release();
	const fourth = await fourthPromise;
	record(fourthSettled && slotCount(registry) === 3, "queued sibling runs when one slot is released");
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
		"queued admission is cancellable without spawning work",
		130,
		() => cancelled,
	);
	record(slotCount(registry) === 3, "cancelled waiter does not consume a slot");
	await Promise.all(cancellationSlots.map((lease) => lease.release()));

	const staleMarker = path.join(scratch, "stale-worker.json");
	const staleWorker = Bun.spawn(
		[process.execPath, import.meta.path, "--worker", "owner"],
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
	const staleToken = JSON.parse(readFileSync(staleMarker, "utf8")).token as string;
	staleWorker.kill(9);
	await staleWorker.exited;
	const afterCrash = await acquireConcurrencySlot();
	record(
		!concurrencySlotExists(staleToken) && slotCount(registry) === 1,
		"dead owner slots are pruned after a process crash",
	);
	await afterCrash.release();

	const childMarker = path.join(scratch, "child-worker.json");
	const childWorker = Bun.spawn(
		[process.execPath, import.meta.path, "--worker", "child"],
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
	};
	childWorker.kill(9);
	await childWorker.exited;
	const survivorA = await acquireConcurrencySlot();
	const survivorB = await acquireConcurrencySlot();
	const survivorController = new AbortController();
	const blockedByLiveChild = acquireConcurrencySlot({
		signal: survivorController.signal,
	});
	setTimeout(() => survivorController.abort(), 50);
	await expectReject(
		"a live registered child preserves its slot after owner death",
		130,
		() => blockedByLiveChild,
	);
	try {
		process.kill(-childState.childPid, "SIGKILL");
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
		"registered slot is pruned only after both owner and child are dead",
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
		"nested delegation yields the current process slot once for a parallel batch",
	);
	const descendant = await acquireConcurrencySlot();
	await suspensionA.resume();
	record(
		!concurrencySlotExists(inherited.token),
		"the current process stays yielded until every nested call settles",
	);
	await descendant.release();
	await suspensionB.resume();
	record(
		concurrencySlotExists(inherited.token) && slotCount(registry) === 3,
		"the current process reacquires its slot after the nested batch",
	);
	await Promise.all([
		inherited.release(),
		occupiedA.release(),
		occupiedB.release(),
	]);
	delete process.env.RLM_ACTIVE_SLOT_TOKEN;

	process.env.RLM_MAX_CONCURRENT_CALLS = "0";
	await expectReject(
		"malformed concurrency limits fail closed",
		1,
		() => acquireConcurrencySlot(),
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

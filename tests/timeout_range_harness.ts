import {
	assertTimeoutAvailable,
	MAX_TIMEOUT_SECONDS,
} from "../extensions/ypi/guardrails.ts";

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function withTimeout(timeout: string, start: string, action: () => void): void {
	const previousTimeout = process.env.RLM_TIMEOUT;
	const previousStart = process.env.RLM_START_TIME;
	process.env.RLM_TIMEOUT = timeout;
	process.env.RLM_START_TIME = start;
	try {
		action();
	} finally {
		if (previousTimeout === undefined) delete process.env.RLM_TIMEOUT;
		else process.env.RLM_TIMEOUT = previousTimeout;
		if (previousStart === undefined) delete process.env.RLM_START_TIME;
		else process.env.RLM_START_TIME = previousStart;
	}
}

console.log("\n=== Timeout range harness ===");
const now = Math.floor(Date.now() / 1000);
withTimeout(String(MAX_TIMEOUT_SECONDS), String(now), () => {
	record(
		assertTimeoutAvailable() === MAX_TIMEOUT_SECONDS,
		"largest Node-safe whole-second timeout remains valid",
	);
});
withTimeout(String(MAX_TIMEOUT_SECONDS + 1), String(now), () => {
	let error = "";
	try {
		assertTimeoutAvailable();
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	record(
		error.includes(`supported maximum of ${MAX_TIMEOUT_SECONDS} seconds`),
		"one second above the Node timer ceiling fails closed",
		error,
	);
});
withTimeout(String(MAX_TIMEOUT_SECONDS), String(now + 60_000), () => {
	record(
		assertTimeoutAvailable() === MAX_TIMEOUT_SECONDS,
		"a future inherited epoch cannot expand the configured delay",
	);
});

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

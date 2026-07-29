import assert from "node:assert/strict";
import {
	assertWorktreeUnregistered,
	parseWorktreeInventory,
} from "../extensions/ypi/internal/worktree-inventory.ts";

let passed = 0;

function check(label: string, action: () => void): void {
	action();
	passed++;
	console.log(`  PASS ${label}`);
}

function inventory(...records: string[][]): Buffer {
	return Buffer.from(
		records
			.map((record) => `${record.join("\0")}\0\0`)
			.join(""),
	);
}

console.log("\n=== Git worktree inventory harness ===");

check("strict NUL inventory returns absolute record paths in order", () => {
	assert.deepEqual(
		parseWorktreeInventory(inventory(
			["worktree /repo", "HEAD 1", "bare"],
			["worktree /repo/linked", "HEAD 2", "detached"],
		)),
		["/repo", "/repo/linked"],
	);
});

check("exact absent worktree passes the unregistration proof", () => {
	assert.doesNotThrow(() => assertWorktreeUnregistered(
		inventory(["worktree /repo", "HEAD 1"]),
		"/repo/retired",
	));
});

check("exact retained worktree fails the unregistration proof", () => {
	assert.throws(
		() => assertWorktreeUnregistered(
			inventory(["worktree /repo/retained", "HEAD 1"]),
			"/repo/retained",
		),
		/recorded worktree remains registered/,
	);
});

check("duplicate worktree paths fail closed", () => {
	assert.throws(
		() => parseWorktreeInventory(inventory(
			["worktree /repo/duplicate"],
			["worktree /repo/duplicate"],
		)),
		/duplicate paths/,
	);
});

check("relative worktree paths fail closed", () => {
	assert.throws(
		() => parseWorktreeInventory(inventory(["worktree relative/path"])),
		/non-absolute path/,
	);
});

check("unterminated records fail closed", () => {
	assert.throws(
		() => parseWorktreeInventory(Buffer.from("worktree /repo\0")),
		/final record/,
	);
});

check("invalid record starts fail closed", () => {
	assert.throws(
		() => parseWorktreeInventory(inventory(["HEAD 1"])),
		/did not begin with a worktree path/,
	);
});

check("non-UTF-8 paths fail closed", () => {
	assert.throws(
		() => parseWorktreeInventory(
			Buffer.concat([
				Buffer.from("worktree /repo/"),
				Buffer.from([0xff, 0, 0]),
			]),
		),
		/non-UTF-8 path/,
	);
});

console.log(`Results: ${passed} passed, 0 failed`);

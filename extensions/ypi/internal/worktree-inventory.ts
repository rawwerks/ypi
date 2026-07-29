import path from "node:path";

export const WORKTREE_INVENTORY_ARGUMENTS = [
	"worktree",
	"list",
	"--porcelain",
	"-z",
	"--expire=never",
] as const;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodePath(value: Uint8Array): string {
	try {
		return utf8.decode(value);
	} catch {
		throw new Error("Git worktree inventory returned a non-UTF-8 path");
	}
}

export function parseWorktreeInventory(value: Uint8Array): string[] {
	const output = Buffer.from(value);
	const prefix = Buffer.from("worktree ");
	const paths: string[] = [];
	let atRecordStart = true;
	let offset = 0;
	while (offset < output.length) {
		const terminator = output.indexOf(0, offset);
		if (terminator < 0) {
			throw new Error("Git worktree inventory was not NUL terminated");
		}
		const field = output.subarray(offset, terminator);
		offset = terminator + 1;
		if (field.length === 0) {
			atRecordStart = true;
			continue;
		}
		if (!atRecordStart) continue;
		if (
			field.length <= prefix.length
			|| !field.subarray(0, prefix.length).equals(prefix)
		) {
			throw new Error("Git worktree inventory did not begin with a worktree path");
		}
		const worktree = decodePath(field.subarray(prefix.length));
		if (!path.isAbsolute(worktree)) {
			throw new Error("Git worktree inventory returned a non-absolute path");
		}
		paths.push(path.resolve(worktree));
		atRecordStart = false;
	}
	if (!atRecordStart && output.length > 0) {
		throw new Error("Git worktree inventory did not terminate its final record");
	}
	if (new Set(paths).size !== paths.length) {
		throw new Error("Git worktree inventory returned duplicate paths");
	}
	return paths;
}

export function assertWorktreeUnregistered(
	inventory: Uint8Array,
	worktree: string,
): void {
	if (parseWorktreeInventory(inventory).includes(path.resolve(worktree))) {
		throw new Error(`recorded worktree remains registered: ${worktree}`);
	}
}

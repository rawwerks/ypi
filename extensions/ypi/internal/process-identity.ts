import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

let linuxBootId: string | undefined;

function linuxProcessIdentity(pid: number): string | undefined {
	try {
		linuxBootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (!linuxBootId || commandEnd < 0) return undefined;
		const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fieldsAfterCommand[19];
		if (!/^[0-9]+$/.test(startTicks || "")) return undefined;
		return `linux:${linuxBootId}:${startTicks}`;
	} catch {
		return undefined;
	}
}

function psProcessIdentity(pid: number): string | undefined {
	const executable = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
	const result = spawnSync(
		executable,
		["-o", "lstart=", "-p", String(pid)],
		{
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 4_096,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? `${process.platform}:ps:${started}` : undefined;
}

export function processStartIdentity(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	return process.platform === "linux"
		? linuxProcessIdentity(pid)
		: psProcessIdentity(pid);
}

export function currentProcessStartIdentity(): string {
	const identity = processStartIdentity(process.pid);
	if (!identity) {
		throw new Error(
			`Stable process identity is unavailable for PID ${process.pid}; recursive ownership cannot be proven.`,
		);
	}
	return identity;
}

export function processMatchesStartIdentity(
	pid: number | undefined,
	expected: string | undefined,
): boolean {
	if (!expected) return false;
	return processStartIdentity(Number(pid)) === expected;
}

export function processGroupId(pid: number): number | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd < 0) return undefined;
			const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
			const group = Number(fieldsAfterCommand[2]);
			return Number.isSafeInteger(group) && group > 0 ? group : undefined;
		} catch {
			return undefined;
		}
	}
	const executable = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
	const result = spawnSync(
		executable,
		["-o", "pgid=", "-p", String(pid)],
		{
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 4_096,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const group = Number(result.status === 0 ? result.stdout.trim() : "");
	return Number.isSafeInteger(group) && group > 0 ? group : undefined;
}

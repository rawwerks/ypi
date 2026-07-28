import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.ts";
import { processIsAlive } from "./process-liveness.ts";

export interface LaunchGateRequest {
	pidFile: string;
	readyFile: string;
	ownerPid: number;
	command: string[];
}

export class LaunchGateError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "LaunchGateError";
		this.exitCode = exitCode;
	}
}

const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value === "--") {
		throw new LaunchGateError(`${flag} requires a value`, 2);
	}
	return value;
}

export function parseLaunchGateArguments(args: string[]): LaunchGateRequest {
	let pidFile: string | undefined;
	let readyFile: string | undefined;
	let ownerPid: number | undefined;
	let command: string[] | undefined;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--") {
			command = args.slice(index + 1);
			break;
		}
		if (argument === "--pid-file") {
			pidFile = requireValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--ready-file") {
			readyFile = requireValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--owner-pid") {
			const value = requireValue(args, index, argument);
			if (!/^[1-9][0-9]*$/.test(value)) {
				throw new LaunchGateError("--owner-pid must be a positive decimal integer", 2);
			}
			ownerPid = Number(value);
			index++;
			continue;
		}
		throw new LaunchGateError(`unknown launch-gate argument: ${argument}`, 2);
	}
	if (!pidFile || !readyFile || ownerPid === undefined || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
		throw new LaunchGateError("--pid-file, --ready-file, and a positive --owner-pid are required", 2);
	}
	if (!command?.length) {
		throw new LaunchGateError("a child command is required after --", 2);
	}
	return { pidFile, readyFile, ownerPid, command };
}

function wait(milliseconds: number): void {
	Atomics.wait(WAIT_ARRAY, 0, 0, milliseconds);
}

function readReadyPid(readyFile: string): number {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(readyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
		const metadata = fstatSync(descriptor);
		if (!metadata.isFile()) {
			throw new LaunchGateError("recursive child launch gate is not a regular file", 126);
		}
		const value = readFileSync(descriptor, "utf8");
		if (!/^[1-9][0-9]*\n?$/.test(value)) {
			throw new LaunchGateError("recursive child launch gate contains an invalid PID", 126);
		}
		return Number(value.trim());
	} catch (error) {
		if (error instanceof LaunchGateError) throw error;
		throw new LaunchGateError(`recursive child launch gate cannot be read: ${(error as Error).message}`, 126);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): string {
	if (command.includes("/")) {
		const candidate = path.resolve(command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EACCES") {
				throw new LaunchGateError(`EACCES: executable is not permitted: ${command}`, 126);
			}
			throw new LaunchGateError(`ENOENT: executable not found: ${command}`, 127);
		}
	}
	let permissionDenied: string | undefined;
	for (const directory of (environment.PATH || "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES") permissionDenied = candidate;
			else if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new LaunchGateError(`cannot inspect executable ${candidate}: ${(error as Error).message}`, 126);
			}
		}
	}
	if (permissionDenied) {
		throw new LaunchGateError(`EACCES: executable is not permitted: ${permissionDenied}`, 126);
	}
	throw new LaunchGateError(`ENOENT: executable not found on PATH: ${command}`, 127);
}

export function runRecursiveChildLaunchGate(request: LaunchGateRequest): never | number {
	atomicWriteFile(request.pidFile, `${process.pid}\n`);
	while (!existsSync(request.readyFile)) {
		if (!processIsAlive(request.ownerPid)) return 125;
		wait(10);
	}
	if (readReadyPid(request.readyFile) !== process.pid) {
		throw new LaunchGateError("recursive child launch gate PID does not match this process", 126);
	}
	const execve = process.execve;
	if (!execve) {
		throw new LaunchGateError("Node.js >=22.15 with process.execve is required for recursive child launch", 126);
	}
	const executable = resolveExecutable(request.command[0], process.env);
	const envExecutable = resolveExecutable("env", process.env);
	try {
		// Node treats a failed process.execve as fatal rather than catchable on
		// supported releases. `env` performs the target exec in the already
		// registered process and returns conventional 126/127 classifications.
		execve(envExecutable, [envExecutable, executable, ...request.command.slice(1)], process.env);
		throw new LaunchGateError("recursive child launch returned without replacing the gate process", 126);
	} catch (error) {
		if (error instanceof LaunchGateError) throw error;
		throw new LaunchGateError(`recursive child launch failed: ${(error as Error).message}`, 126);
	}
}

export function runRecursiveChildLaunchGateCli(args: string[]): number {
	try {
		return runRecursiveChildLaunchGate(parseLaunchGateArguments(args));
	} catch (error) {
		const failure = error instanceof LaunchGateError
			? error
			: new LaunchGateError(error instanceof Error ? error.message : String(error), 126);
		process.stderr.write(`${failure.message}\n`);
		return failure.exitCode;
	}
}

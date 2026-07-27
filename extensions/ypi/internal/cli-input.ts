import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ContextSource {
	context?: string;
	contextPath?: string;
	cleanup?: () => void;
}

export interface ContextSourceOptions {
	signal?: AbortSignal;
	timeoutMilliseconds?: number;
}

export class CliInputError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "CliInputError";
		this.exitCode = exitCode;
	}
}

async function spoolStdin(options: ContextSourceOptions): Promise<{ path: string; bytes: number; cleanup(): void }> {
	const directory = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "ypi_cli_stdin_"));
	const contextPath = path.join(directory, "context.bin");
	const descriptor = openSync(contextPath, "wx", 0o600);
	let descriptorOpen = true;
	let bytes = 0;
	let timedOut = false;
	const abortInput = () => process.stdin.destroy(new CliInputError("Recursive input cancelled before completion", 130));
	const timeout = options.timeoutMilliseconds === undefined
		? undefined
		: setTimeout(() => {
			timedOut = true;
			process.stdin.destroy(new CliInputError("Timeout exceeded while reading recursive input under RLM_TIMEOUT", 124));
		}, Math.max(0, options.timeoutMilliseconds));
	options.signal?.addEventListener("abort", abortInput, { once: true });
	try {
		if (options.signal?.aborted) throw new CliInputError("Recursive input cancelled before completion", 130);
		for await (const chunk of process.stdin) {
			if (timedOut) throw new CliInputError("Timeout exceeded while reading recursive input under RLM_TIMEOUT", 124);
			if (options.signal?.aborted) throw new CliInputError("Recursive input cancelled before completion", 130);
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let offset = 0;
			while (offset < buffer.byteLength) offset += writeSync(descriptor, buffer, offset);
			bytes += buffer.byteLength;
		}
		if (timedOut) throw new CliInputError("Timeout exceeded while reading recursive input under RLM_TIMEOUT", 124);
	} catch (error) {
		if (descriptorOpen) {
			closeSync(descriptor);
			descriptorOpen = false;
		}
		rmSync(directory, { recursive: true, force: true });
		if (timedOut) throw new CliInputError("Timeout exceeded while reading recursive input under RLM_TIMEOUT", 124);
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortInput);
	}
	if (descriptorOpen) closeSync(descriptor);
	return { path: contextPath, bytes, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export async function resolveContextSource(options: ContextSourceOptions = {}): Promise<ContextSource> {
	const explicitStdin = Boolean(process.env.RLM_STDIN);
	const shouldReadStdin = explicitStdin || !process.stdin.isTTY;
	if (shouldReadStdin) {
		const spooled = await spoolStdin(options);
		if (spooled.bytes > 0 || explicitStdin) return { contextPath: spooled.path, cleanup: spooled.cleanup };
		spooled.cleanup();
	}
	if (process.env.CONTEXT && existsSync(process.env.CONTEXT)) {
		return { contextPath: process.env.CONTEXT };
	}
	return {};
}

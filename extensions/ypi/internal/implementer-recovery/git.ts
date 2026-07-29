import { spawnSync } from "node:child_process";
import { withPrivateUmask } from "../private-path.ts";

const INTERNAL_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;
const PATH_DECODER = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});

export interface RecoveryGit {
	run(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Buffer;
	text(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): string;
	optionalText(cwd: string, args: string[]): string | undefined;
}

function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) environment[key] = value;
	}
	return { ...environment, ...overrides };
}

export function createRecoveryGit(
	timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
): RecoveryGit {
	const run = (cwd: string, args: string[], environment: NodeJS.ProcessEnv = {}): Buffer => {
		const result = withPrivateUmask(() => spawnSync("git", [...INTERNAL_GIT_CONFIG, ...args], {
			cwd,
			env: gitEnvironment(environment),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMilliseconds,
			maxBuffer: Infinity,
		}));
		if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
			throw new Error(`git ${args.join(" ")} exceeded ${timeoutMilliseconds}ms`);
		}
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const diagnostics = Buffer.from(result.stderr || "").toString("utf8").trim();
			throw new Error(`git ${args.join(" ")} failed${diagnostics ? `: ${diagnostics}` : ""}`);
		}
		return Buffer.from(result.stdout || "");
	};
	return {
		run,
		text(cwd, args, environment) {
			return decodeGitTextOutput(run(cwd, args, environment));
		},
		optionalText(cwd, args) {
			let output: Buffer;
			try {
				output = run(cwd, args);
			} catch (error) {
				if (error instanceof Error && /^git .* failed(?:$|:)/.test(error.message)) {
					return undefined;
				}
				throw error;
			}
			return decodeGitTextOutput(output);
		},
	};
}

export function decodeGitTextOutput(value: Uint8Array): string {
	const bytes = Buffer.from(value);
	if (bytes.length === 0) return "";
	if (bytes[bytes.length - 1] !== 0x0a) {
		throw new Error("Git returned unterminated text/path output; recovery preserved the workspace for manual inspection");
	}
	return decodeGitPath(bytes.subarray(0, bytes.length - 1));
}

export function decodeGitPath(value: Uint8Array): string {
	try {
		return PATH_DECODER.decode(value);
	} catch {
		throw new Error("Git returned a path that is not valid UTF-8; recovery preserved the workspace for manual inspection");
	}
}

export function decodeNulPaths(value: Uint8Array): string[] {
	const buffer = Buffer.from(value);
	if (buffer.length > 0 && buffer[buffer.length - 1] !== 0) {
		throw new Error("Git returned an unterminated NUL path inventory; recovery preserved the workspace for manual inspection");
	}
	const paths: string[] = [];
	let start = 0;
	for (let index = 0; index < buffer.length; index++) {
		if (buffer[index] !== 0) continue;
		if (index > start) paths.push(decodeGitPath(buffer.subarray(start, index)));
		start = index + 1;
	}
	return paths;
}

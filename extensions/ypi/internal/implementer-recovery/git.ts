import { spawnSync } from "node:child_process";
import { withPrivateUmask } from "../private-path.ts";

const INTERNAL_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;
const PATH_DECODER = new TextDecoder("utf-8", { fatal: true });

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
			return run(cwd, args, environment).toString("utf8").trim();
		},
		optionalText(cwd, args) {
			try {
				return run(cwd, args).toString("utf8").trim();
			} catch {
				return undefined;
			}
		},
	};
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
	const paths: string[] = [];
	let start = 0;
	for (let index = 0; index <= buffer.length; index++) {
		if (index !== buffer.length && buffer[index] !== 0) continue;
		if (index > start) paths.push(decodeGitPath(buffer.subarray(start, index)));
		start = index + 1;
	}
	return paths;
}

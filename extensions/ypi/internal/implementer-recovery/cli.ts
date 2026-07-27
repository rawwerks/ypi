import {
	recoverImplementerWorkspaces,
	type ImplementerRecoveryOptions,
} from "./service.ts";

export class RecoveryCliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryCliUsageError";
	}
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new RecoveryCliUsageError(`${flag} requires a value`);
	}
	return value;
}

export function parseImplementerRecoveryArguments(
	args: string[],
): ImplementerRecoveryOptions {
	let repo: string | undefined;
	let ageMinutes: number | undefined;
	let force = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--repo") {
			repo = requireValue(args, index, argument);
			index++;
			continue;
		}
		if (argument === "--age") {
			const value = requireValue(args, index, argument);
			if (!/^[0-9]+$/.test(value)) {
				throw new RecoveryCliUsageError("--age must be a non-negative decimal integer");
			}
			ageMinutes = Number(value);
			index++;
			continue;
		}
		if (argument === "--force") {
			force = true;
			continue;
		}
		throw new RecoveryCliUsageError(`unknown implementer recovery argument: ${argument}`);
	}
	if (
		!repo
		|| !Number.isSafeInteger(ageMinutes)
		|| Number(ageMinutes) < 0
		|| Number(ageMinutes) > Math.floor(Number.MAX_SAFE_INTEGER / 60)
	) {
		throw new RecoveryCliUsageError("--repo and a non-negative integer --age are required");
	}
	return { repo, ageMinutes: ageMinutes as number, force };
}

export function runImplementerRecoveryCli(args: string[]): number {
	try {
		const report = recoverImplementerWorkspaces(
			parseImplementerRecoveryArguments(args),
		);
		if (report.stdout.length) process.stdout.write(`${report.stdout.join("\n")}\n`);
		if (report.stderr.length) process.stderr.write(`${report.stderr.join("\n")}\n`);
		return report.exitCode;
	} catch (error) {
		const usage = error instanceof RecoveryCliUsageError;
		process.stderr.write(
			`${usage ? "implementer recovery usage error" : "implementer recovery failed"}: `
			+ `${error instanceof Error ? error.message : String(error)}\n`,
		);
		return usage ? 2 : 1;
	}
}

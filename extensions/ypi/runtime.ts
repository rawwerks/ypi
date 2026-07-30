import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface YpiRuntime {
	extensionPath: string;
	extensionDir: string;
	root: string;
	systemPromptPath: string;
	rlmQueryPath: string;
	runtimeCorePath: string;
	runtimeInternalDir: string;
	cliAdapterPath: string;
}

function normalizedPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function resolveRuntime(importMetaUrl: string): YpiRuntime {
	const extensionPath = fileURLToPath(importMetaUrl);
	const extensionDir = path.dirname(extensionPath);
	const defaultRoot = path.resolve(extensionDir, "..");
	const configuredRoot = process.env.YPI_EXTENSION_ROOT;
	const configuredExtension = process.env.YPI_EXTENSION_PATH;
	const configuredExtensionMatches = Boolean(configuredExtension)
		&& normalizedPath(configuredExtension!) === normalizedPath(extensionPath);
	// A long-lived parent ypi can leave root/path hints in the ambient environment.
	// Honor them only when they describe this exact loaded extension; an explicit
	// `pi -e /other/package/extensions/recursive.ts` must own its package root.
	const root = path.resolve(configuredRoot && configuredExtensionMatches ? configuredRoot : defaultRoot);

	return {
		extensionPath,
		extensionDir,
		root,
		systemPromptPath: path.join(root, "SYSTEM_PROMPT.md"),
		rlmQueryPath: path.join(root, "rlm_query"),
		runtimeCorePath: path.join(root, "extensions", "ypi", "runtime-core.ts"),
		runtimeInternalDir: path.join(root, "extensions", "ypi", "internal"),
		cliAdapterPath: path.join(root, "extensions", "ypi", "cli.ts"),
	};
}

export function debug(message: string): void {
	if (process.env.YPI_EXTENSION_DEBUG === "1") {
		console.error(message);
	}
}

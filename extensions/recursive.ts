/**
 * ypi recursive Pi extension.
 *
 * Load directly with:
 *   pi -e ./extensions/recursive.ts
 *
 * The extension is the canonical integration point. The ypi launcher and the
 * shell-compatible rlm_query command are convenience layers around this path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureEnvironment, shouldExposeRecursion } from "./ypi/env.ts";
import { registerNativeRlmQueryTool } from "./ypi/native-tool.ts";
import { createRootPromptLease } from "./ypi/internal/root-prompt.ts";
import { registerRootImplementerBatchPolicy } from "./ypi/internal/root-batch-policy.ts";
import { registerImplementWriteScope } from "./ypi/internal/write-scope.ts";
import { patchSystemPrompt } from "./ypi/prompt.ts";
import { debug, resolveRuntime } from "./ypi/runtime.ts";
import { updateStatus } from "./ypi/status.ts";

const runtime = resolveRuntime(import.meta.url);
const ACTIVE_EXTENSION = Symbol.for("ypi.active-recursive-extension.v1");

interface ActiveExtensionRecord {
	extensionPath: string;
	token: object;
}

export default function (pi: ExtensionAPI) {
	const registry = globalThis as typeof globalThis & { [ACTIVE_EXTENSION]?: ActiveExtensionRecord };
	if (registry[ACTIVE_EXTENSION]) {
		debug(`__YPI_DUPLICATE_EXTENSION_SKIPPED__ active=${registry[ACTIVE_EXTENSION].extensionPath} skipped=${runtime.extensionPath}`);
		return;
	}
	const token = {};
	registry[ACTIVE_EXTENSION] = { extensionPath: runtime.extensionPath, token };
	const rootPrompt = createRootPromptLease();
	ensureEnvironment(runtime);
	registerRootImplementerBatchPolicy(pi);
	registerImplementWriteScope(pi);
	if (shouldExposeRecursion()) {
		registerNativeRlmQueryTool(pi, runtime);
	}
	debug(`__YPI_EXTENSION_LOADED__ root=${runtime.root}`);

	pi.on("session_start", (_event, ctx) => {
		ensureEnvironment(runtime, ctx, pi);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		rootPrompt.capture(event.prompt);
		ensureEnvironment(runtime, ctx, pi);
		debug("__YPI_EXTENSION_PROMPT_PATCHED__");
		return { systemPrompt: patchSystemPrompt(runtime, event) };
	});

	pi.on("session_shutdown", () => {
		rootPrompt.cleanup();
		if (registry[ACTIVE_EXTENSION]?.token === token) delete registry[ACTIVE_EXTENSION];
	});
}

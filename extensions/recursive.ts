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
import { patchSystemPrompt } from "./ypi/prompt.ts";
import { debug, resolveRuntime } from "./ypi/runtime.ts";
import { updateStatus } from "./ypi/status.ts";

const runtime = resolveRuntime(import.meta.url);

export default function (pi: ExtensionAPI) {
	ensureEnvironment(runtime);
	if (shouldExposeRecursion()) {
		registerNativeRlmQueryTool(pi, runtime);
	}
	debug(`__YPI_EXTENSION_LOADED__ root=${runtime.root}`);

	pi.on("session_start", (_event, ctx) => {
		ensureEnvironment(runtime, ctx, pi);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		ensureEnvironment(runtime, ctx, pi);
		debug("__YPI_EXTENSION_PROMPT_PATCHED__");
		return { systemPrompt: patchSystemPrompt(runtime, event) };
	});
}

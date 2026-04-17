/**
 * ypi Status Extension
 *
 * Shows that this is ypi (recursive Pi), not vanilla Pi.
 * Displays recursion depth info in the footer status bar,
 * sets the terminal title to "ypi", and keeps the subprocess
 * environment aligned with Pi's live session/model state.
 *
 * Reads configuration from environment variables set by the ypi launcher:
 *   RLM_DEPTH      — current recursion depth (default: 0)
 *   RLM_MAX_DEPTH  — maximum recursion depth (default: 3)
 */

import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "@mariozechner/pi-coding-agent";

function setEnv(name: string, value: string | undefined) {
	if (value) process.env[name] = value;
	else delete process.env[name];
}

function syncRlmEnv(ctx: ExtensionContext, model = ctx.model, options?: { preserveExistingModel?: boolean }) {
	// Bash tool executions inherit process.env, so keep these values current
	// when the user switches models or sessions.
	if (model) {
		setEnv("RLM_PROVIDER", model.provider);
		setEnv("RLM_MODEL", model.id);
	} else if (!options?.preserveExistingModel) {
		delete process.env.RLM_PROVIDER;
		delete process.env.RLM_MODEL;
	}
	setEnv("RLM_SESSION_FILE", ctx.sessionManager.getSessionFile());
}

function updateUi(ctx: ExtensionContext, depth: number, maxDepth: number) {
	const theme = ctx.ui.theme;

	// Footer status: ypi with depth info
	const label = theme.fg("accent", "ypi");
	const depthInfo = theme.fg("dim", ` ∞ depth ${depth}/${maxDepth}`);
	ctx.ui.setStatus("ypi", label + depthInfo);

	// Terminal tab/window title
	ctx.ui.setTitle("ypi");
}

export default function (pi: ExtensionAPI) {
	const depth = parseInt(process.env.RLM_DEPTH || "0", 10);
	const maxDepth = parseInt(process.env.RLM_MAX_DEPTH || "3", 10);

	pi.on("session_start", (_event, ctx) => {
		syncRlmEnv(ctx, ctx.model, { preserveExistingModel: true });
		updateUi(ctx, depth, maxDepth);
	});

	pi.on("model_select", (event: ModelSelectEvent, ctx) => {
		syncRlmEnv(ctx, event.model);
	});
}

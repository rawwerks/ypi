/**
 * ypi Status Extension
 *
 * Shows that this is ypi (recursive Pi), not vanilla Pi.
 * Displays recursion depth info in the footer status bar
 * and sets the terminal title to "ypi".
 *
 * Reads configuration from environment variables set by the ypi launcher:
 *   RLM_DEPTH      — current recursion depth (default: 0)
 *   RLM_MAX_DEPTH  — maximum recursion depth (default: 3)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const depth = parseInt(process.env.RLM_DEPTH || "0", 10);
	const maxDepth = parseInt(process.env.RLM_MAX_DEPTH || "3", 10);

	pi.on("session_start", async (_event, ctx) => {
		const theme = ctx.ui.theme;

		// Footer status: ypi with depth info
		const label = theme.fg("accent", "ypi");
		const depthInfo = theme.fg("dim", ` ∞ depth ${depth}/${maxDepth}`);
		ctx.ui.setStatus("ypi", label + depthInfo);

		// Terminal tab/window title
		ctx.ui.setTitle("ypi");
	});

	// Update on session switch (new session resets UI)
	pi.on("session_switch", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "ypi");
		const depthInfo = theme.fg("dim", ` ∞ depth ${depth}/${maxDepth}`);
		ctx.ui.setStatus("ypi", label + depthInfo);
		ctx.ui.setTitle("ypi");
	});
}

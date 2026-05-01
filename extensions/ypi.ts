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

interface StatusCtx {
	ui: {
		theme: { fg: (kind: string, text: string) => string };
		setStatus: (key: string, value: string) => void;
		setTitle: (title: string) => void;
	};
}

export default function (pi: ExtensionAPI) {
	// Track recursive calls made from this process
	let rlmCalls = 0;

	function getDepth(): number {
		return parseInt(process.env.RLM_DEPTH || "0", 10);
	}

	function getMaxDepth(): number {
		return parseInt(process.env.RLM_MAX_DEPTH || "3", 10);
	}

	function updateStatus(ctx: StatusCtx) {
		const theme = ctx.ui.theme;
		const depth = getDepth();
		const maxDepth = getMaxDepth();
		const label = theme.fg("accent", "ypi");

		let suffix: string;
		if (rlmCalls > 0) {
			const callStr = rlmCalls === 1 ? "1 call" : `${rlmCalls} calls`;
			suffix = ` ∞ d${depth}/${maxDepth} · ${callStr}`;
		} else {
			suffix = ` ∞ d${depth}/${maxDepth}`;
		}

		ctx.ui.setStatus("ypi", label + theme.fg("dim", suffix));
		ctx.ui.setTitle(`ypi d${depth}`);
	}

	// Detect rlm_query invocations from bash tool results
	pi.on("tool_result", async (event, _ctx) => {
		if (event.isError) return;
		if (event.toolName !== "bash") return;

		const input = event.input as Record<string, unknown> | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		if (/\brlm_query\b/.test(command)) {
			rlmCalls++;
		}
	});

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("session_switch", async (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));
}

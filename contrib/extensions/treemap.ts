/**
 * Treemap Extension for Pi
 *
 * Appends a repository tree overview to the system prompt on each turn,
 * so the agent always has a map of the codebase. Uses `eza --tree` if
 * available, falls back to `find`.
 *
 * Some people "prime" their agents by pasting `eza --tree` output before
 * starting work. This extension automates that.
 *
 * Configuration via environment variables:
 *   TREEMAP_DEPTH    — tree depth (default: 3)
 *   TREEMAP_CMD      — custom command override (default: auto-detect eza/find)
 *   TREEMAP_DISABLE  — set to "1" to disable
 *
 * Usage:
 *   pi -e ./contrib/extensions/treemap.ts
 *   # or symlink into ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";

export default function (pi: ExtensionAPI) {
	if (process.env.TREEMAP_DISABLE === "1") return;

	const depth = process.env.TREEMAP_DEPTH || "3";

	function getTree(cwd: string): string {
		const customCmd = process.env.TREEMAP_CMD;
		if (customCmd) {
			try {
				return execSync(customCmd, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
			} catch {
				return "";
			}
		}

		// Try eza first (respects .gitignore by default)
		try {
			return execSync(
				`eza --tree --level=${depth} --git-ignore --no-permissions --no-user --no-time --no-filesize`,
				{ cwd, encoding: "utf-8", timeout: 5000 },
			).trim();
		} catch {
			// eza not available
		}

		// Fall back to find (skip hidden dirs and node_modules)
		try {
			return execSync(
				`find . -maxdepth ${depth} -not -path '*/.*' -not -path '*/node_modules/*' | sort`,
				{ cwd, encoding: "utf-8", timeout: 5000 },
			).trim();
		} catch {
			return "";
		}
	}

	// Cache the tree per session to avoid re-running on every turn
	let cachedTree: string | null = null;
	let cachedCwd: string | null = null;

	pi.on("session_start", async (_event, ctx) => {
		cachedTree = getTree(ctx.cwd);
		cachedCwd = ctx.cwd;
	});

	pi.on("session_switch", async (_event, ctx) => {
		cachedTree = getTree(ctx.cwd);
		cachedCwd = ctx.cwd;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Refresh if cwd changed
		if (ctx.cwd !== cachedCwd) {
			cachedTree = getTree(ctx.cwd);
			cachedCwd = ctx.cwd;
		}

		if (!cachedTree) return;

		const treeBlock = `\n\n## Repository Tree\n\n\`\`\`\n${cachedTree}\n\`\`\`\n`;

		return {
			systemPrompt: event.systemPrompt + treeBlock,
		};
	});
}

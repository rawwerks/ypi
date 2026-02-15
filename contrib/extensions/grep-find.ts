/**
 * grep-find — Activate Pi's built-in Grep (ripgrep) and Find (fd) tools.
 *
 * Pi ships with grep and find tools but only activates read, bash, edit,
 * and write by default. This extension adds them to the active tool set
 * so the agent can use structured ripgrep/fd search instead of raw bash.
 *
 * Install:
 *   cp contrib/extensions/grep-find.ts ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function grepFind(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const active = new Set(pi.getActiveTools());
    const all = pi.getAllTools().map((t) => t.name);

    let added: string[] = [];
    for (const tool of ["grep", "find"] as const) {
      if (all.includes(tool) && !active.has(tool)) {
        active.add(tool);
        added.push(tool);
      }
    }

    if (added.length > 0) {
      pi.setActiveTools([...active]);
      ctx.ui.notify(`grep-find: activated ${added.join(", ")} ✓`, "info");
    }
  });
}

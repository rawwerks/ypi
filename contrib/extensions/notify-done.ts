/**
 * notify-done — Watches for sentinel files and wakes the agent when background tasks complete.
 *
 * Usage:
 *   1. Launch a background task with a sentinel targeted at THIS instance:
 *      tmux send-keys -t eval:land 'command; echo done > /tmp/ypi-signal-INSTANCE_ID-land' Enter
 *
 *   2. This extension polls /tmp/ypi-signal-* every 5 seconds.
 *      Only picks up sentinels matching this instance's ID.
 *      Broadcasts (no instance ID) are BLOCKED and deleted — use the instance ID.
 *      When a sentinel appears, it injects a notification:
 *      - If idle: triggers a new turn immediately (triggerTurn)
 *      - If streaming: steers the agent (delivered after current tool finishes)
 *
 * Sentinel format:
 *   /tmp/ypi-signal-{instanceId}-{name}  — targeted to a specific instance (REQUIRED)
 *   /tmp/ypi-signal-{name}               — BLOCKED. Will be deleted without delivery.
 *
 * Instance ID is generated at startup and exposed as $YPI_INSTANCE_ID in child processes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";

const SIGNAL_DIR = "/tmp";
const SIGNAL_PREFIX = "ypi-signal-";
const POLL_INTERVAL = 5000; // 5 seconds

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	const instanceId = randomBytes(4).toString("hex");

	// Expose instance ID to child processes (bash tool calls, rlm_query, etc.)
	process.env.YPI_INSTANCE_ID = instanceId;

	pi.on("session_start", async () => {
		// Start polling for sentinels
		timer = setInterval(() => {
			try {
				const files = readdirSync(SIGNAL_DIR).filter((f) => f.startsWith(SIGNAL_PREFIX));
				for (const file of files) {
					const rest = file.slice(SIGNAL_PREFIX.length);

					// Check if this sentinel is targeted at a specific instance
					// Format: ypi-signal-{8-hex-instanceId}-{name} vs ypi-signal-{name}
					const instanceMatch = rest.match(/^([0-9a-f]{8})-(.+)$/);

					if (instanceMatch) {
						// Targeted sentinel — only pick up if it's for us
						const [, targetId, name] = instanceMatch;
						if (targetId !== instanceId) continue;
						deliverSignal(pi, `${SIGNAL_DIR}/${file}`, name);
					} else {
						// No instance ID — block it. Delete to prevent /tmp clutter.
						// The originating agent forgot to include its instance ID.
						try { unlinkSync(`${SIGNAL_DIR}/${file}`); } catch {}
					}
				}
			} catch {
				// /tmp not readable
			}
		}, POLL_INTERVAL);
	});

	pi.on("session_shutdown", async () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	});
}

function deliverSignal(pi: ExtensionAPI, path: string, name: string) {
	try {
		const content = readFileSync(path, "utf-8").trim();
		unlinkSync(path);
		pi.sendMessage(
			{
				customType: "notify-done",
				content: `⚡ Background task "${name}" completed: ${content}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	} catch {
		// race condition — file disappeared between readdir and read
	}
}

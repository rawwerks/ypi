/**
 * notify-done — Watches for sentinel files and wakes the agent when background tasks complete.
 *
 * Usage:
 *   1. Launch a background task with a sentinel:
 *      tmux send-keys -t eval:land 'rp ypi .prose/land.prose; echo "72/72 passed" > /tmp/ypi-signal-land' Enter
 *
 *   2. This extension polls /tmp/ypi-signal-* every 5 seconds.
 *      When a sentinel appears, it injects a notification:
 *      - If idle: triggers a new turn immediately (triggerTurn)
 *      - If streaming: steers the agent (delivered after current tool finishes)
 *
 * Sentinel format: /tmp/ypi-signal-{name}
 *   File contents become the notification body.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, unlinkSync } from "fs";

const SIGNAL_DIR = "/tmp";
const SIGNAL_PREFIX = "ypi-signal-";
const POLL_INTERVAL = 5000; // 5 seconds

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", async () => {
		// Start polling for sentinels
		timer = setInterval(() => {
			try {
				const files = readdirSync(SIGNAL_DIR).filter((f) => f.startsWith(SIGNAL_PREFIX));
				for (const file of files) {
					const path = `${SIGNAL_DIR}/${file}`;
					const name = file.slice(SIGNAL_PREFIX.length);
					try {
						const content = readFileSync(path, "utf-8").trim();
						unlinkSync(path);
						// Inject notification and wake the agent
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

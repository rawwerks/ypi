/**
 * timestamps — gives agents awareness of time.
 *
 * Status bar shows current time, session uptime, and turn duration.
 * `clock` tool returns structured time info on demand.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function fmt(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function timeStr(): string {
	return new Date().toLocaleTimeString("en-US", {
		hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
		timeZoneName: "short",
	});
}

export default function timestamps(pi: ExtensionAPI) {
	let sessionStart = Date.now();
	let turnStart = Date.now();
	let lastTurnEnd = Date.now();

	function updateStatus(ctx: { ui: { setStatus(k: string, v: string): void } }) {
		const now = Date.now();
		ctx.ui.setStatus("⏱", `${timeStr()} | session: ${fmt(now - sessionStart)} | turn: ${fmt(now - turnStart)}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionStart = Date.now();
		turnStart = sessionStart;
		lastTurnEnd = sessionStart;
		ctx.ui.setStatus("⏱", `${timeStr()} | session start`);
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		turnStart = Date.now();
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastTurnEnd = Date.now();
		updateStatus(ctx);
	});

	pi.registerTool({
		name: "clock",
		label: "Current time & session timing",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			const now = Date.now();
			return {
				result: JSON.stringify({
					now_iso: new Date(now).toISOString(),
					now_human: timeStr(),
					session_start_iso: new Date(sessionStart).toISOString(),
					session_uptime: fmt(now - sessionStart),
					turn_started: fmt(now - turnStart) + " ago",
					last_turn_ended: fmt(now - lastTurnEnd) + " ago",
				}, null, 2),
			};
		},
	});
}

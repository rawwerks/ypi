/**
 * find-the-others — Discover all active pi/ypi instances on this machine.
 *
 * Scans /proc for running `pi` processes, extracts metadata from their
 * environment and cwd, and maps out the full process tree including
 * recursive rlm_query children.
 *
 * Exposes:
 *   - /peers command — interactive list with tree visualization
 *   - "peers" tool — LLM-callable, returns structured peer data
 *   - Status bar — peer count (e.g., "👥 14")
 *
 * Detection method:
 *   1. `pgrep -x pi` finds all processes named exactly "pi"
 *   2. For each PID, read /proc/{pid}/{cwd,environ,stat}
 *   3. Classify as ypi (has RLM_SYSTEM_PROMPT) or plain pi
 *   4. Build tree from RLM_TRACE_ID + RLM_DEPTH + process parentage
 *   5. Detect "me" via process.pid ancestry
 *
 * Tree structure:
 *   - Root instances (depth 0) are top-level agents launched by a human
 *   - Children (depth > 0) are rlm_query sub-agents with the same trace ID
 *   - Pi may also fork internal child processes (compaction, etc.) — these
 *     share trace ID and depth 0, distinguished by ppid being another pi
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import { readFileSync, readlinkSync, statSync } from "fs";

interface PeerInstance {
	pid: number;
	ppid: number;
	isMe: boolean;
	cwd: string;
	project: string;
	type: "ypi" | "pi";
	depth: number;
	maxDepth: number;
	tty: string;
	age: string;
	sessionDir: string | null;
	traceId: string | null;
	startTime: Date | null;
	isInternalChild: boolean; // pi's own subprocess (same depth, ppid is pi)
}

interface PeerTree {
	root: PeerInstance;
	children: PeerTree[];
}

function readProcEnv(pid: number): Map<string, string> {
	const envVars = new Map<string, string>();
	try {
		const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
		for (const entry of raw.split("\0")) {
			const eq = entry.indexOf("=");
			if (eq > 0) envVars.set(entry.slice(0, eq), entry.slice(eq + 1));
		}
	} catch {}
	return envVars;
}

function psField(pid: number, field: string): string {
	try {
		return execSync(`ps -o ${field}= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
	} catch {
		return "?";
	}
}

function discoverPeers(): PeerInstance[] {
	const peers: PeerInstance[] = [];

	let pids: number[];
	try {
		const out = execSync("pgrep -x pi", { encoding: "utf-8", timeout: 5000 });
		pids = out
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number)
			.filter((n) => !isNaN(n));
	} catch {
		return peers;
	}

	const piPidSet = new Set(pids);

	for (const pid of pids) {
		try {
			const cwd = readlinkSync(`/proc/${pid}/cwd`);
			const project = cwd.split("/").pop() || cwd;
			const env = readProcEnv(pid);

			const isYpi = env.has("RLM_SYSTEM_PROMPT");
			const depth = parseInt(env.get("RLM_DEPTH") || "0", 10);
			const maxDepth = parseInt(env.get("RLM_MAX_DEPTH") || "3", 10);
			const sessionDir = env.get("RLM_SESSION_DIR") || null;
			const traceId = env.get("RLM_TRACE_ID") || null;

			const ppid = parseInt(psField(pid, "ppid"), 10) || 0;
			const tty = psField(pid, "tty");
			const age = psField(pid, "etime");

			let startTime: Date | null = null;
			try {
				const stat = statSync(`/proc/${pid}`);
				startTime = stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime;
			} catch {}

			// Internal child: parent is another pi process AND same depth
			// (rlm_query children have depth+1, pi's internal forks keep depth 0)
			const isInternalChild = piPidSet.has(ppid) && isParentSameDepth(ppid, depth);

			const isMe = pid === process.pid || isAncestor(pid, process.pid);

			peers.push({
				pid,
				ppid,
				isMe,
				cwd,
				project,
				type: isYpi ? "ypi" : "pi",
				depth,
				maxDepth,
				tty,
				age,
				sessionDir,
				traceId,
				startTime,
				isInternalChild,
			});
		} catch {
			continue;
		}
	}

	return peers;
}

function isParentSameDepth(ppid: number, childDepth: number): boolean {
	try {
		const env = readProcEnv(ppid);
		const parentDepth = parseInt(env.get("RLM_DEPTH") || "0", 10);
		return parentDepth === childDepth;
	} catch {
		return false;
	}
}

function isAncestor(ancestor: number, child: number): boolean {
	let current = child;
	for (let i = 0; i < 10; i++) {
		const ppid = parseInt(psField(current, "ppid"), 10);
		if (ppid === ancestor) return true;
		if (ppid <= 1) return false;
		current = ppid;
	}
	return false;
}

/**
 * Build a forest of peer trees grouped by trace ID.
 * Within a trace, depth determines parent-child relationship.
 * Instances without a trace are standalone roots.
 */
function buildForest(peers: PeerInstance[]): PeerTree[] {
	// Filter out pi-internal children (compaction forks etc.)
	const agents = peers.filter((p) => !p.isInternalChild);

	// Group by traceId
	const byTrace = new Map<string, PeerInstance[]>();
	const noTrace: PeerInstance[] = [];

	for (const p of agents) {
		if (p.traceId) {
			const group = byTrace.get(p.traceId) || [];
			group.push(p);
			byTrace.set(p.traceId, group);
		} else {
			noTrace.push(p);
		}
	}

	const forest: PeerTree[] = [];

	// For each trace group, build a tree by depth
	for (const [, group] of byTrace) {
		group.sort((a, b) => a.depth - b.depth);

		// Depth 0 is the root; depth N are children of depth N-1
		const byDepth = new Map<number, PeerInstance[]>();
		for (const p of group) {
			const arr = byDepth.get(p.depth) || [];
			arr.push(p);
			byDepth.set(p.depth, arr);
		}

		const roots = byDepth.get(0) || [];
		if (roots.length === 0) {
			// Orphan children — just list them flat
			for (const p of group) forest.push({ root: p, children: [] });
			continue;
		}

		for (const root of roots) {
			const tree = buildSubtree(root, byDepth, root.depth + 1);
			forest.push(tree);
		}
	}

	// Standalone instances (no trace)
	for (const p of noTrace) {
		forest.push({ root: p, children: [] });
	}

	// Sort: "me" trees first, then by start time (newest first)
	forest.sort((a, b) => {
		const aHasMe = treeContainsMe(a);
		const bHasMe = treeContainsMe(b);
		if (aHasMe !== bHasMe) return aHasMe ? -1 : 1;
		const aTime = a.root.startTime?.getTime() || 0;
		const bTime = b.root.startTime?.getTime() || 0;
		return bTime - aTime;
	});

	return forest;
}

function buildSubtree(node: PeerInstance, byDepth: Map<number, PeerInstance[]>, nextDepth: number): PeerTree {
	const childInstances = byDepth.get(nextDepth) || [];
	const children = childInstances.map((c) => buildSubtree(c, byDepth, nextDepth + 1));
	return { root: node, children };
}

function treeContainsMe(tree: PeerTree): boolean {
	if (tree.root.isMe) return true;
	return tree.children.some(treeContainsMe);
}

function countInstances(peers: PeerInstance[]): { total: number; ypi: number; pi: number; internal: number } {
	const agents = peers.filter((p) => !p.isInternalChild);
	return {
		total: agents.length,
		ypi: agents.filter((p) => p.type === "ypi").length,
		pi: agents.filter((p) => p.type === "pi").length,
		internal: peers.filter((p) => p.isInternalChild).length,
	};
}

function formatTree(forest: PeerTree[], peers: PeerInstance[]): string {
	const counts = countInstances(peers);
	const lines: string[] = [];

	lines.push(
		`Found ${counts.total} active instance${counts.total === 1 ? "" : "s"}` +
			` (${counts.ypi} ypi, ${counts.pi} pi` +
			(counts.internal > 0 ? `, ${counts.internal} internal` : "") +
			`)`,
	);
	lines.push("");

	for (let i = 0; i < forest.length; i++) {
		renderTree(forest[i], lines, "", i === forest.length - 1);
	}

	return lines.join("\n");
}

function renderTree(tree: PeerTree, lines: string[], prefix: string, isLast: boolean): void {
	const p = tree.root;
	const me = p.isMe ? " ← YOU" : "";
	const connector = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
	const depthLabel = p.depth > 0 ? `d${p.depth} ` : "";

	lines.push(
		`${prefix}${connector}${depthLabel}${p.type} [${p.pid}] ${p.project}  (${p.age})  tty=${p.tty}${me}`,
	);

	const childPrefix = prefix === "" ? "" : prefix + (isLast ? "   " : "│  ");
	for (let i = 0; i < tree.children.length; i++) {
		renderTree(tree.children[i], lines, childPrefix, i === tree.children.length - 1);
	}
}

function formatJSON(forest: PeerTree[], peers: PeerInstance[]): object {
	const counts = countInstances(peers);

	function serializeTree(tree: PeerTree): object {
		const p = tree.root;
		return {
			pid: p.pid,
			is_me: p.isMe,
			type: p.type,
			depth: p.depth,
			project: p.project,
			cwd: p.cwd,
			age: p.age,
			tty: p.tty,
			trace_id: p.traceId,
			session_dir: p.sessionDir,
			children: tree.children.map(serializeTree),
		};
	}

	return {
		counts,
		trees: forest.map(serializeTree),
	};
}

export default function findTheOthers(pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext) {
		try {
			const peers = discoverPeers();
			const counts = countInstances(peers);
			const theme = ctx.ui.theme;
			if (counts.total > 1) {
				ctx.ui.setStatus("peers", theme.fg("dim", `👥 ${counts.total}`));
			} else {
				ctx.ui.setStatus("peers", undefined);
			}
		} catch {}
	}

	pi.on("session_start", async (_event, ctx) => updateStatus(ctx));
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// Inject live peer snapshot into system prompt
	pi.on("before_agent_start", async (_event) => {
		const peers = discoverPeers();
		const counts = countInstances(peers);
		if (counts.total <= 1) return;

		const forest = buildForest(peers);
		const tree = formatTree(forest, peers);

		return {
			systemPrompt: _event.systemPrompt + `\n\n## Active Peers\n\nYou are one of ${counts.total} active pi/ypi instances on this machine. Use the \`peers\` tool for full details.\n\n\`\`\`\n${tree}\n\`\`\`\n`,
		};
	});

	// /peers command
	pi.registerCommand("peers", {
		description: "List all active pi/ypi instances with tree visualization",
		handler: async (_args, ctx) => {
			const peers = discoverPeers();
			const forest = buildForest(peers);
			ctx.ui.notify(formatTree(forest, peers), "info");
		},
	});

	// LLM-callable tool
	const { Type } = require("@sinclair/typebox");

	pi.registerTool({
		name: "peers",
		label: "List active peers",
		description:
			"Discover all active pi/ypi instances running on this machine. " +
			"Shows a tree of instances grouped by trace ID, with recursive " +
			"rlm_query children nested under their parents. " +
			"Reports PID, project directory, uptime, terminal, depth, and type. " +
			"Marks which instance is 'me' (this agent).",
		parameters: Type.Object({
			format: Type.Optional(
				Type.Union([Type.Literal("table"), Type.Literal("json")], {
					description: 'Output format: "table" (tree view) or "json" (structured)',
					default: "table",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const peers = discoverPeers();
			const forest = buildForest(peers);
			const format = params.format || "table";

			const content =
				format === "json"
					? JSON.stringify(formatJSON(forest, peers), null, 2)
					: formatTree(forest, peers);

			return { content: [{ type: "text", text: content }] };
		},
	});
}

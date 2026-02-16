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
import { execSync, spawn } from "child_process";
import {
	readFileSync,
	readlinkSync,
	statSync,
	readdirSync,
	existsSync,
	mkdirSync,
	appendFileSync,
	writeFileSync,
	unlinkSync,
	watchFile,
	unwatchFile,
} from "fs";
import { join, basename } from "path";
import { randomUUID } from "crypto";

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

/**
 * Find the latest session file in a directory.
 * Session files are named: <timestamp>_<uuid>.jsonl
 */
function findLatestSession(sessionDir: string): string | null {
	if (!existsSync(sessionDir)) return null;

	const files = readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => ({
			name: f,
			path: join(sessionDir, f),
			mtime: statSync(join(sessionDir, f)).mtime.getTime(),
		}))
		.sort((a, b) => b.mtime - a.mtime);

	return files.length > 0 ? files[0].path : null;
}

/**
 * Find a peer by PID or project name (fuzzy match).
 */
function findPeer(peers: PeerInstance[], target: string): PeerInstance | null {
	// Filter out internal children
	const agents = peers.filter((p) => !p.isInternalChild);

	// Try PID match first
	const pid = parseInt(target, 10);
	if (!isNaN(pid)) {
		const byPid = agents.find((p) => p.pid === pid);
		if (byPid) return byPid;
	}

	// Try exact project name match
	const exactMatch = agents.find((p) => p.project === target);
	if (exactMatch) return exactMatch;

	// Try fuzzy project match (case-insensitive contains)
	const lower = target.toLowerCase();
	const fuzzy = agents.filter((p) => p.project.toLowerCase().includes(lower));
	if (fuzzy.length === 1) return fuzzy[0];

	// Try cwd match
	const cwdMatch = agents.find((p) => p.cwd === target || p.cwd.endsWith(`/${target}`));
	if (cwdMatch) return cwdMatch;

	return null;
}

interface ForkResult {
	success: boolean;
	sourceSession: string | null;
	forkedSession: string | null;
	forkedSessionId?: string;
	sourceSessionId?: string;
	peer: PeerInstance | null;
	spawnedPid?: number;
	error?: string;
}

/**
 * Fork a peer's session context.
 *
 * @param target - PID or project name to identify the peer
 * @param options - Fork options
 * @returns Fork result with paths and status
 */
function forkPeerSession(
	peers: PeerInstance[],
	target: string,
	options: {
		outputDir?: string;
		prompt?: string;
		spawn?: boolean;
		model?: string;
		provider?: string;
	} = {},
): ForkResult {
	const peer = findPeer(peers, target);
	if (!peer) {
		return {
			success: false,
			sourceSession: null,
			forkedSession: null,
			peer: null,
			error: `No peer found matching "${target}". Use \`peers\` to list available instances.`,
		};
	}

	if (!peer.sessionDir) {
		return {
			success: false,
			sourceSession: null,
			forkedSession: null,
			peer,
			error: `Peer ${peer.pid} (${peer.project}) has no session directory.`,
		};
	}

	const sourceSession = findLatestSession(peer.sessionDir);
	if (!sourceSession) {
		return {
			success: false,
			sourceSession: null,
			forkedSession: null,
			peer,
			error: `No session files found in ${peer.sessionDir}`,
		};
	}

	// Generate new session with proper fork semantics
	// - New session ID (not a copy of the original)
	// - parentSession field pointing to source
	// - Updated cwd if needed
	const newSessionId = randomUUID();
	const timestamp = new Date().toISOString();
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	const forkName = `${fileTimestamp}_${newSessionId}.jsonl`;

	// Use output dir or default to source peer's session dir
	const outputDir = options.outputDir || peer.sessionDir;
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}
	const forkedSession = join(outputDir, forkName);

	// Read source session and create forked version with new header
	try {
		const sourceContent = readFileSync(sourceSession, "utf-8");
		const lines = sourceContent.trim().split("\n").filter(Boolean);

		if (lines.length === 0) {
			return {
				success: false,
				sourceSession,
				forkedSession: null,
				peer,
				error: `Source session file is empty: ${sourceSession}`,
			};
		}

		// Parse original header
		const originalHeader = JSON.parse(lines[0]);
		if (originalHeader.type !== "session") {
			return {
				success: false,
				sourceSession,
				forkedSession: null,
				peer,
				error: `Source session has no valid header: ${sourceSession}`,
			};
		}

		// Create new header with:
		// - New session ID (critical for avoiding conflicts)
		// - parentSession pointing to source (for provenance tracking)
		// - Preserved cwd (forked agent works in same directory)
		// - Current timestamp
		const newHeader = {
			type: "session",
			version: originalHeader.version || 3,
			id: newSessionId,
			timestamp,
			cwd: peer.cwd,
			parentSession: sourceSession,
		};

		// Write new header
		appendFileSync(forkedSession, JSON.stringify(newHeader) + "\n");

		// Copy all non-header entries (conversation history, model changes, etc.)
		for (let i = 1; i < lines.length; i++) {
			appendFileSync(forkedSession, lines[i] + "\n");
		}

		// Inject a worker preamble as a system-level message into the forked session
		if (options.spawn && options.prompt) {
			const parentPid = process.pid;
			const workerMsg = {
				type: "message",
				id: `fork-preamble-${newSessionId}`,
				timestamp,
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: [
								`════════════════════════════════════════════════════════════`,
								`[FORKED WORKER AGENT — MANDATORY INSTRUCTIONS]`,
								`════════════════════════════════════════════════════════════`,
								``,
								`IGNORE everything above. The prior conversation is background context only.`,
								`You are a NEW agent with ONE job. Do the TASK, then report back.`,
								``,
								`REPORTING BACK (MANDATORY):`,
								`  1. Call the send_to_peer tool with target="${parentPid}"`,
								`  2. Put your results in the message parameter`,
								`  3. This is a TOOL CALL, not a text description — invoke it`,
								`  4. You MUST do this or your work is lost forever`,
								``,
								`════════════════════════════════════════════════════════════`,
							].join("\n"),
						},
					],
				},
			};
			appendFileSync(forkedSession, JSON.stringify(workerMsg) + "\n");
			// Also inject a fake assistant acknowledgment to create a clean conversational break
			const ackMsg = {
				type: "message",
				id: `fork-ack-${newSessionId}`,
				timestamp,
				message: {
					role: "assistant",
					content: [{
						type: "text",
						text: `Understood. I am a forked worker agent. I will complete the task and report back to PID ${parentPid} using send_to_peer. Starting now.`,
					}],
				},
			};
			appendFileSync(forkedSession, JSON.stringify(ackMsg) + "\n");
		}

		const result: ForkResult = {
			success: true,
			sourceSession,
			forkedSession,
			forkedSessionId: newSessionId,
			sourceSessionId: originalHeader.id,
			peer,
		};

		// Optionally spawn a new pi with the forked session
		if (options.spawn && options.prompt) {
			try {
				const args = ["--session", forkedSession, "-p"];
				if (options.provider) args.push("--provider", options.provider);
				if (options.model) args.push("--model", options.model);
				const parentPid = process.pid;
				const workerPreamble = [
					`[FORKED WORKER AGENT]`,
					`You were spawned as a worker by parent agent PID ${parentPid}.`,
					`When your task is complete, you MUST call the send_to_peer tool with target="${parentPid}" containing your results.`,
					`Do NOT just describe sending a message — actually invoke the send_to_peer tool. This is MANDATORY.`,
					`Your process will exit when you finish, so send_to_peer is your only way to report back.`,
					``,
					`TASK: ${options.prompt}`,
				].join("\n");
				args.push(workerPreamble);

				const child = spawn(SPAWN_BINARY, args, {
					cwd: peer.cwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();
				result.spawnedPid = child.pid;
			} catch (err) {
				result.error = `Session forked but spawn failed: ${err}`;
			}
		}

		return result;
	} catch (err) {
		return {
			success: false,
			sourceSession,
			forkedSession: null,
			peer,
			error: `Failed to fork session: ${err}`,
		};
	}
}

// ============================================================================
// PEER REGISTRY + MESSAGING
//
// Each agent registers itself at startup in /tmp/ypi-peers/{PID}.json.
// The registry provides instant discovery without /proc scanning, and
// each registration includes the agent's inbox path for messaging.
//
// Only agents launched with this extension are registered. Older/external
// pi instances can still be found via /proc scanning (discoverPeers).
//
// Registry:
//   - /tmp/ypi-peers/{PID}.json — one file per registered agent
//   - Created on session_start, removed on session_shutdown
//   - Stale entries (dead PIDs) cleaned on read
//
// Messaging:
//   - Inbox: /tmp/ypi-peers/{PID}.inbox.jsonl (co-located with registration)
//   - Sender looks up target in registry → writes to their inbox
//   - Receiver polls inbox on turn_end → injects via sendUserMessage
//   - Messages also auto-delivered via fs.watchFile for near-instant delivery
// ============================================================================

const PEERS_DIR = "/tmp/ypi-peers";
const INBOX_SUFFIX = ".inbox.jsonl";
const SPAWN_BINARY = (() => {
	try { execSync("which ypi", { timeout: 2000, stdio: "ignore" }); return "ypi"; } catch { return "pi"; }
})();

/** Registration entry — what each agent writes to the registry */
interface PeerRegistration {
	pid: number;
	project: string;
	cwd: string;
	type: "ypi" | "pi";
	sessionDir: string | null;
	traceId: string | null;
	inboxPath: string;
	startTime: number; // epoch ms
	registeredAt: number; // epoch ms
}

interface PeerMessage {
	id: string; // unique message ID
	from_pid: number;
	from_project: string;
	to_pid: number;
	timestamp: number; // epoch ms
	message: string;
	reply_to?: string; // message ID this is replying to
}

/** Ensure the peers directory exists */
function ensurePeersDir(): void {
	if (!existsSync(PEERS_DIR)) {
		mkdirSync(PEERS_DIR, { recursive: true, mode: 0o777 });
	}
}

/** Get the registration file path for a PID */
function getRegistrationPath(pid: number): string {
	return join(PEERS_DIR, `${pid}.json`);
}

/** Get the inbox path for a PID */
function getInboxPath(pid: number): string {
	return join(PEERS_DIR, `${pid}${INBOX_SUFFIX}`);
}

/** Register this agent in the peer registry */
function registerSelf(pid: number, project: string, cwd: string, sessionDir: string | null, traceId: string | null): PeerRegistration {
	ensurePeersDir();

	const registration: PeerRegistration = {
		pid,
		project,
		cwd,
		type: process.env.RLM_SYSTEM_PROMPT ? "ypi" : "pi",
		sessionDir,
		traceId,
		inboxPath: getInboxPath(pid),
		startTime: Date.now(),
		registeredAt: Date.now(),
	};

	writeFileSync(getRegistrationPath(pid), JSON.stringify(registration, null, 2));
	// Create empty inbox
	writeFileSync(getInboxPath(pid), "");

	return registration;
}

/** Unregister this agent (cleanup) */
function unregisterSelf(pid: number): void {
	try {
		const regPath = getRegistrationPath(pid);
		if (existsSync(regPath)) unlinkSync(regPath);
	} catch {}
	try {
		const inboxPath = getInboxPath(pid);
		if (existsSync(inboxPath)) unlinkSync(inboxPath);
	} catch {}
}

/** Check if a PID is alive */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** List all registered peers, cleaning up stale entries */
function listRegisteredPeers(): PeerRegistration[] {
	ensurePeersDir();
	const peers: PeerRegistration[] = [];

	try {
		const files = readdirSync(PEERS_DIR).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const content = readFileSync(join(PEERS_DIR, file), "utf-8");
				const reg: PeerRegistration = JSON.parse(content);

				if (isPidAlive(reg.pid)) {
					peers.push(reg);
				} else {
					// Clean up stale registration + inbox
					try { unlinkSync(join(PEERS_DIR, file)); } catch {}
					try { unlinkSync(getInboxPath(reg.pid)); } catch {}
				}
			} catch {
				// Skip malformed files
			}
		}
	} catch {}

	return peers;
}

/** Find a registered peer by PID or project name */
function findRegisteredPeer(target: string): PeerRegistration | null {
	const peers = listRegisteredPeers();

	// Try PID match
	const pid = parseInt(target, 10);
	if (!isNaN(pid)) {
		const byPid = peers.find((p) => p.pid === pid);
		if (byPid) return byPid;
	}

	// Exact project name
	const exact = peers.find((p) => p.project === target);
	if (exact) return exact;

	// Fuzzy project match
	const lower = target.toLowerCase();
	const fuzzy = peers.filter((p) => p.project.toLowerCase().includes(lower));
	if (fuzzy.length === 1) return fuzzy[0];

	// CWD match
	const cwdMatch = peers.find((p) => p.cwd === target || p.cwd.endsWith(`/${target}`));
	if (cwdMatch) return cwdMatch;

	return null;
}

/** Read all messages from an inbox, then clear it (atomic read-and-clear) */
function drainInbox(pid: number): PeerMessage[] {
	const inboxPath = getInboxPath(pid);
	if (!existsSync(inboxPath)) return [];

	try {
		const content = readFileSync(inboxPath, "utf-8");
		const messages: PeerMessage[] = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				messages.push(JSON.parse(line));
			} catch {
				// skip malformed lines
			}
		}

		// Clear inbox after reading
		if (messages.length > 0) {
			writeFileSync(inboxPath, "");
		}

		return messages;
	} catch {
		return [];
	}
}

/** Send a message to another agent's inbox */
function sendToPeerInbox(
	fromPid: number,
	fromProject: string,
	toPid: number,
	message: string,
	replyTo?: string,
): { success: boolean; messageId: string; error?: string } {
	const messageId = randomUUID().slice(0, 8);

	// First try to find target in registry
	const reg = listRegisteredPeers().find((p) => p.pid === toPid);
	const inboxPath = reg ? reg.inboxPath : getInboxPath(toPid);

	// Verify target PID is alive
	if (!isPidAlive(toPid)) {
		return {
			success: false,
			messageId,
			error: `Target PID ${toPid} is not running`,
		};
	}

	// Verify target is registered (only registered peers can receive messages)
	if (!reg) {
		return {
			success: false,
			messageId,
			error: `PID ${toPid} is running but not registered. Only agents with find-the-others extension can receive messages.`,
		};
	}

	const peerMsg: PeerMessage = {
		id: messageId,
		from_pid: fromPid,
		from_project: fromProject,
		to_pid: toPid,
		timestamp: Date.now(),
		message,
		reply_to: replyTo,
	};

	try {
		appendFileSync(inboxPath, JSON.stringify(peerMsg) + "\n");
		return { success: true, messageId };
	} catch (err) {
		return {
			success: false,
			messageId,
			error: `Failed to write to inbox: ${err}`,
		};
	}
}

/** Format incoming messages for display to the agent */
function formatIncomingMessage(msg: PeerMessage): string {
	const replyLine = msg.reply_to ? `reply_to: ${msg.reply_to}\n` : "";
	return (
		`<peer_message>\n` +
		`from: ${msg.from_project} (PID ${msg.from_pid})\n` +
		`id: ${msg.id}\n` +
		`${replyLine}` +
		`---\n` +
		`${msg.message}\n` +
		`</peer_message>`
	);
}

export default function findTheOthers(pi: ExtensionAPI) {
	function updateStatus(ctx: ExtensionContext) {
		try {
			const peers = discoverPeers();
			const counts = countInstances(peers);
			const registered = listRegisteredPeers();
			const theme = ctx.ui.theme;
			if (counts.total > 1) {
				const regCount = registered.filter((r) => r.pid !== myPid).length;
				const label = regCount > 0
					? `👥 ${counts.total} (${regCount} 💬)`
					: `👥 ${counts.total}`;
				ctx.ui.setStatus("peers", theme.fg("dim", label));
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

	// /fork-peer command
	pi.registerCommand("fork-peer", {
		description: "Fork a peer's session to continue from their context",
		parameters: [
			{ name: "target", description: "PID or project name of peer to fork" },
			{ name: "prompt", description: "Initial prompt for the forked session (optional)" },
		],
		handler: async (args, ctx) => {
			const [target, ...promptParts] = args.trim().split(/\s+/);
			const prompt = promptParts.join(" ") || undefined;

			if (!target) {
				ctx.ui.notify("Usage: /fork-peer <pid|project> [prompt]", "error");
				return;
			}

			const peers = discoverPeers();
			const result = forkPeerSession(peers, target, { prompt, spawn: !!prompt });

			if (!result.success) {
				ctx.ui.notify(result.error || "Fork failed", "error");
				return;
			}

			const lines = [
				`✓ Forked session from ${result.peer?.project} (PID ${result.peer?.pid})`,
				`  Source: ${result.sourceSession}`,
				`  Forked: ${result.forkedSession}`,
			];

			if (result.spawnedPid) {
				lines.push(`  Spawned new pi (PID ${result.spawnedPid})`);
			} else if (!prompt) {
				lines.push(`  To use: pi --session "${result.forkedSession}" -c "your prompt"`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// fork_peer tool for LLM
	pi.registerTool({
		name: "fork_peer",
		label: "Fork peer session",
		description:
			"Fork another pi/ypi agent's session to create a new agent with their full conversation context. " +
			"Use this to spawn a helper that continues from where another agent left off, or to branch " +
			"an agent's work in a new direction. The forked session includes the complete history " +
			"(messages, tool calls, thinking) from the source agent.",
		parameters: Type.Object({
			target: Type.String({
				description: "PID or project name of the peer to fork (use `peers` tool to find available targets)",
			}),
			prompt: Type.Optional(
				Type.String({
					description: "Initial prompt for the forked session. If provided, spawns a new pi process.",
				}),
			),
			spawn: Type.Optional(
				Type.Boolean({
					description: "Whether to spawn a new pi process with the forked session (default: true if prompt provided)",
					default: true,
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Model to use for the spawned pi (e.g., 'claude-sonnet-4-5')",
				}),
			),
			provider: Type.Optional(
				Type.String({
					description: "Provider for the spawned pi (e.g., 'anthropic', 'openai')",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const peers = discoverPeers();
			const shouldSpawn = params.spawn !== false && !!params.prompt;

			const result = forkPeerSession(peers, params.target, {
				prompt: params.prompt,
				spawn: shouldSpawn,
				model: params.model,
				provider: params.provider,
			});

			if (!result.success) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					isError: true,
				};
			}

			const info: Record<string, unknown> = {
				success: true,
				source_peer: {
					pid: result.peer?.pid,
					project: result.peer?.project,
					cwd: result.peer?.cwd,
					type: result.peer?.type,
				},
				source_session: result.sourceSession,
				source_session_id: result.sourceSessionId,
				forked_session: result.forkedSession,
				forked_session_id: result.forkedSessionId,
			};

			if (result.spawnedPid) {
				info.spawned_pid = result.spawnedPid;
				info.message = `Spawned new pi (PID ${result.spawnedPid}) with forked context from ${result.peer?.project}`;
			} else {
				info.message = `Session forked. Use: pi --session "${result.forkedSession}" -c "your prompt"`;
			}

			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
			};
		},
	});

	// =========================================================================
	// FRESH_PEER: Spawn a new agent with empty context + messaging
	// =========================================================================

	pi.registerTool({
		name: "fresh_peer",
		label: "Spawn fresh peer",
		description:
			"Spawn a new pi agent with a FRESH context window (no conversation history) that can message back via send_to_peer. " +
			"Cheaper than fork_peer since it doesn't copy your full session. Use when the task is self-contained " +
			"and all needed context can be described in the prompt.",
		parameters: Type.Object({
			prompt: Type.String({
				description: "Task description for the new agent",
			}),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for the child (default: parent's cwd)",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Model to use (e.g., 'claude-sonnet-4-5')",
				}),
			),
			provider: Type.Optional(
				Type.String({
					description: "Provider (e.g., 'anthropic', 'openai')",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			try {
				const parentPid = process.pid;
				const childCwd = params.cwd || process.cwd();
				const parentProject = childCwd.split("/").pop() || childCwd;

				const workerPreamble = [
					`[FRESH WORKER AGENT — MANDATORY INSTRUCTIONS]`,
					`You were spawned as a fresh worker by parent agent PID ${parentPid} in project "${parentProject}".`,
					`You have NO prior conversation history — all context is in this prompt and on disk.`,
					``,
					`REPORTING BACK (MANDATORY):`,
					`  1. When done, call the send_to_peer tool with target="${parentPid}"`,
					`  2. Put your results in the message parameter`,
					`  3. This is a TOOL CALL, not a text description — actually invoke it`,
					`  4. You MUST do this or your work is lost forever`,
					`  5. Your process will exit when you finish — send_to_peer is your only way to report back`,
					``,
					`TASK: ${params.prompt}`,
				].join("\n");

				const args = ["-p", workerPreamble];
				if (params.provider) args.unshift("--provider", params.provider);
				if (params.model) args.unshift("--model", params.model);

				const child = spawn(SPAWN_BINARY, args, {
					cwd: childCwd,
					detached: true,
					stdio: "ignore",
				});
				child.unref();

				const info = {
					success: true,
					spawned_pid: child.pid,
					cwd: childCwd,
					project: parentProject,
					parent_pid: parentPid,
					message: `Spawned fresh peer (PID ${child.pid}) in ${parentProject}. It will send_to_peer ${parentPid} when done.`,
				};

				return {
					content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error spawning fresh peer: ${err}` }],
					isError: true,
				};
			}
		},
	});

	// =========================================================================
	// STEER-AS-RPC: Inter-agent messaging
	// =========================================================================

	const myPid = process.pid;
	const myCwd = process.cwd();
	const myProject = myCwd.split("/").pop() || myCwd;
	const mySessionDir = process.env.RLM_SESSION_DIR || null;
	const myTraceId = process.env.RLM_TRACE_ID || null;

	// Register this agent in the peer registry
	const myRegistration = registerSelf(myPid, myProject, myCwd, mySessionDir, myTraceId);

	// Watch inbox for near-instant message delivery via fs.watchFile
	let inboxWatcherCtx: ExtensionContext | null = null;
	watchFile(myRegistration.inboxPath, { interval: 1000 }, (curr, prev) => {
		if (curr.size > prev.size && inboxWatcherCtx) {
			// New data written to inbox — deliver immediately
			checkAndDeliverMessages(inboxWatcherCtx);
		}
	});

	/** Check inbox and inject any new messages */
	function checkAndDeliverMessages(ctx: ExtensionContext): void {
		const messages = drainInbox(myPid);
		if (messages.length === 0) return;

		for (const msg of messages) {
			const formatted = formatIncomingMessage(msg);
			// Inject as a user message that triggers a turn
			// NOTE: sendUserMessage is on pi (ExtensionAPI), not ctx (ExtensionContext)
			pi.sendUserMessage(formatted, { deliverAs: "followUp" });
		}

		const count = messages.length;
		const sources = [...new Set(messages.map((m) => m.from_project))].join(", ");
		ctx.ui.notify(`📨 ${count} message${count > 1 ? "s" : ""} from: ${sources}`, "info");
	}

	// Poll for messages on turn_end (after agent finishes a response)
	pi.on("turn_end", async (_event, ctx) => {
		checkAndDeliverMessages(ctx);
	});

	// Capture context for the file watcher and check on session_start
	pi.on("session_start", async (_event, ctx) => {
		inboxWatcherCtx = ctx;
		setTimeout(() => checkAndDeliverMessages(ctx), 1000);
	});

	// Unregister and clean up on shutdown
	pi.on("session_shutdown", async () => {
		unwatchFile(myRegistration.inboxPath);
		unregisterSelf(myPid);
	});

	// /send command — interactive message sending
	pi.registerCommand("send", {
		description: "Send a message to another agent: /send <pid|project> <message>",
		parameters: [
			{ name: "target", description: "PID or project name of peer" },
			{ name: "message", description: "Message to send" },
		],
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)\s+(.+)$/s);
			if (!match) {
				ctx.ui.notify("Usage: /send <pid|project> <message>", "error");
				return;
			}

			const [, target, message] = match;

			// Try registry first, fall back to /proc discovery
			const regPeer = findRegisteredPeer(target);
			if (regPeer) {
				const result = sendToPeerInbox(myPid, myProject, regPeer.pid, message);
				if (result.success) {
					ctx.ui.notify(
						`📤 Sent to ${regPeer.project} (PID ${regPeer.pid}) [msg:${result.messageId}]`,
						"info",
					);
				} else {
					ctx.ui.notify(`Failed: ${result.error}`, "error");
				}
				return;
			}

			// Fall back to /proc — but warn that messaging requires registration
			const peers = discoverPeers();
			const peer = findPeer(peers, target);
			if (peer) {
				ctx.ui.notify(
					`Found ${peer.project} (PID ${peer.pid}) via /proc, but it's not registered.\n` +
					`Only agents with find-the-others extension can receive messages.`,
					"warning",
				);
			} else {
				ctx.ui.notify(`No peer found matching "${target}"`, "error");
			}
		},
	});

	// /registry command — show registered peers
	pi.registerCommand("registry", {
		description: "Show all registered peers (agents with messaging enabled)",
		handler: async (_args, ctx) => {
			const peers = listRegisteredPeers();
			if (peers.length === 0) {
				ctx.ui.notify("📭 No registered peers", "info");
				return;
			}

			const lines = peers.map((p) => {
				const me = p.pid === myPid ? " ← YOU" : "";
				const age = Math.round((Date.now() - p.startTime) / 60000);
				return `  ${p.type} [${p.pid}] ${p.project} (${age}min)${me}`;
			});
			ctx.ui.notify(`Registered peers (${peers.length}):\n${lines.join("\n")}`, "info");
		},
	});

	// /inbox command — check for messages manually
	pi.registerCommand("inbox", {
		description: "Check inbox for messages from other agents",
		handler: async (_args, ctx) => {
			const messages = drainInbox(myPid);
			if (messages.length === 0) {
				ctx.ui.notify("📭 No messages", "info");
				return;
			}

			const lines = messages.map(
				(m) => `📨 [${m.id}] from ${m.from_project} (${m.from_pid}): ${m.message.slice(0, 100)}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");

			// Also inject as messages
			for (const msg of messages) {
				const formatted = formatIncomingMessage(msg);
				pi.sendUserMessage(formatted, { deliverAs: "followUp" });
			}
		},
	});

	// send_to_peer tool — LLM-callable
	pi.registerTool({
		name: "send_to_peer",
		label: "Send message to peer",
		description:
			"Send a message to another running pi/ypi agent. The message will appear in their " +
			"conversation as an incoming message. Use `peers` tool first to find the target's PID. " +
			"The receiving agent will see the message after their current turn completes. " +
			"Use reply_to to reference a previous message ID for threaded conversation.",
		parameters: Type.Object({
			target: Type.String({
				description: "PID or project name of the peer to message (use `peers` to find)",
			}),
			message: Type.String({
				description: "Message to send to the peer agent",
			}),
			reply_to: Type.Optional(
				Type.String({
					description: "Message ID to reply to (for threaded conversation)",
				}),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			// Try registry first
			const regPeer = findRegisteredPeer(params.target);
			if (regPeer) {
				const result = sendToPeerInbox(
					myPid,
					myProject,
					regPeer.pid,
					params.message,
					params.reply_to,
				);

				if (!result.success) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									success: true,
									message_id: result.messageId,
									to_pid: regPeer.pid,
									to_project: regPeer.project,
									registered: true,
									message: `Message sent to ${regPeer.project} (PID ${regPeer.pid})`,
								},
								null,
								2,
							),
						},
					],
				};
			}

			// Fall back to /proc discovery — but can't send without registration
			const peers = discoverPeers();
			const peer = findPeer(peers, params.target);

			if (peer) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Found ${peer.project} (PID ${peer.pid}) via /proc, but it's not registered. ` +
								`Only agents with find-the-others extension can receive messages. ` +
								`The target agent must be launched with this extension loaded.`,
						},
					],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Error: No peer found matching "${params.target}". Use \`peers\` tool to list available instances.`,
					},
				],
				isError: true,
			};
		},
	});

	// check_inbox tool — LLM-callable
	pi.registerTool({
		name: "check_inbox",
		label: "Check inbox",
		description:
			"Check for messages from other pi/ypi agents. Returns any pending messages " +
			"and clears the inbox. Messages are also automatically delivered after each turn.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
			const messages = drainInbox(myPid);

			if (messages.length === 0) {
				return {
					content: [{ type: "text", text: "📭 No messages in inbox." }],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								count: messages.length,
								messages: messages.map((m) => ({
									id: m.id,
									from_pid: m.from_pid,
									from_project: m.from_project,
									timestamp: new Date(m.timestamp).toISOString(),
									message: m.message,
									reply_to: m.reply_to,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		},
	});
}

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
} from "node:fs";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import path from "node:path";
import {
	atomicConditionalReplaceFile,
	atomicCreateFile,
	type AtomicFileIdentity,
} from "./atomic-file.ts";
import {
	appendOwnedPrivateFile,
	capturePrivateFileIdentity,
	createOwnedPrivateTempDirectory,
	ensurePrivateDirectory,
	parsePrivateFileIdentity,
	retireOwnedPrivateTree,
	sealOwnedPrivateDirectory,
	type OwnedPrivateDirectory,
	type PrivatePathIdentity,
	readOwnedPrivateFile,
} from "./private-path.ts";
import {
	currentProcessStartIdentity,
	processGroupId,
	processMatchesStartIdentity,
	processStartIdentity,
} from "./process-identity.ts";

const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024;
const SLOT_TOKEN = /^[0-9a-f]{32}$/;
const GENERATION_TOKEN = /^[0-9a-f]{32}$/;
const SECRET_TOKEN = /^[0-9a-f]{64}$/;
const TERMINATION_GRACE_MILLISECONDS = 1_500;
const MAX_COUNTER_BYTES = 32;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export interface CoordinatorWaitOptions {
	deadlineMilliseconds?: number;
	signal?: AbortSignal;
}

interface AuthorityManifest {
	schemaVersion: 1;
	generation: string;
	rootPid: number;
	rootProcessIdentity: string;
	socketPath: string;
	status: "starting" | "active" | "terminal";
	createdAtEpochMilliseconds: number;
	terminalAtEpochMilliseconds?: number;
	terminalReason?: string;
}

interface CoordinatorRequest {
	schemaVersion: 1;
	generation: string;
	secret: string;
	operation:
		| "check"
		| "allocate-call"
		| "acquire-slot"
		| "release-slot"
		| "suspend-slot"
		| "resume-slot"
		| "register-launch";
	pid: number;
	processIdentity: string;
	token?: string;
	childPid?: number;
	childProcessIdentity?: string;
	maximum?: number;
	seedCallCount?: number;
	counterFile?: string;
}

interface CoordinatorResponse {
	schemaVersion: 1;
	ok: boolean;
	value?: number;
	message?: string;
	exitCode?: number;
	phase?: "grant" | "confirmed";
}

interface ActiveSlot {
	token: string;
	ownerPid: number;
	ownerProcessIdentity: string;
	childPid?: number;
	childProcessIdentity?: string;
}

interface QueuedSlot {
	socket: Socket;
	request: CoordinatorRequest;
	resume: boolean;
}

interface LocalCoordinator {
	generation: string;
	secret: string;
	socketPath: string;
	manifestPath: string;
	manifestIdentity: PrivatePathIdentity;
	manifestAtomicIdentity: AtomicFileIdentity;
	manifestRaw: string;
	manifest: AuthorityManifest;
	server: Server;
	ready: Promise<void>;
	status: "starting" | "active" | "terminal";
	socketOwner?: OwnedPrivateDirectory;
	socketRetirement?: Promise<void>;
	activeSlots: Map<string, ActiveSlot>;
	suspendedSlots: Map<string, ActiveSlot>;
	queue: QueuedSlot[];
	maximum?: number;
	maxCalls?: number;
	callCount: number;
	counterFile?: string;
	counterIdentity?: AtomicFileIdentity;
	counterRaw?: string;
	termination?: Promise<void>;
}

export class TreeCoordinatorError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "TreeCoordinatorError";
		this.exitCode = exitCode;
	}
}

let localCoordinator: LocalCoordinator | undefined;

function exactNonNegativeInteger(name: string, value: unknown): number {
	if (
		typeof value !== "number"
		|| !Number.isSafeInteger(value)
		|| value < 0
	) {
		throw new TreeCoordinatorError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

function exactPositiveInteger(name: string, value: unknown): number {
	const parsed = exactNonNegativeInteger(name, value);
	if (parsed < 1) throw new TreeCoordinatorError(`${name} must be positive.`);
	return parsed;
}

function atomicIdentityFromPrivate(
	identity: PrivatePathIdentity,
): AtomicFileIdentity {
	return {
		device: identity.device,
		inode: identity.inode,
		mode: identity.mode,
		links: identity.links,
		owner: process.getuid?.(),
	};
}

function manifestText(manifest: AuthorityManifest): string {
	return `${JSON.stringify(manifest)}\n`;
}

function updateManifest(
	state: LocalCoordinator,
	manifest: AuthorityManifest,
): void {
	const next = manifestText(manifest);
	state.manifestAtomicIdentity = atomicConditionalReplaceFile(
		state.manifestPath,
		state.manifestAtomicIdentity,
		next,
		{
			mode: 0o600,
			expectedContent: state.manifestRaw,
		},
	);
	state.manifest = manifest;
	state.manifestRaw = next;
}

function appendCoordinatorTrace(event: string): void {
	const trace = process.env.PI_TRACE_FILE;
	const identity = process.env.YPI_TRACE_FILE_IDENTITY;
	if (!trace || !identity) return;
	try {
		appendOwnedPrivateFile(
			trace,
			parsePrivateFileIdentity(identity),
			`[${new Date().toISOString()}] ${event}\n`,
		);
	} catch {
		delete process.env.PI_TRACE_FILE;
		delete process.env.YPI_TRACE_FILE_IDENTITY;
	}
}

function response(
	socket: Socket,
	value: Omit<CoordinatorResponse, "schemaVersion">,
	end = true,
): void {
	if (socket.destroyed) return;
	const payload = `${JSON.stringify({ schemaVersion: PROTOCOL_VERSION, ...value })}\n`;
	if (end) socket.end(payload, () => socket.destroy());
	else socket.write(payload);
}

function failureResponse(socket: Socket, error: unknown): void {
	const exitCode = error instanceof TreeCoordinatorError
		? error.exitCode
		: (error as Error & { exitCode?: number })?.exitCode || 1;
	response(socket, {
		ok: false,
		message: error instanceof Error ? error.message : String(error),
		exitCode,
	});
}

function authenticateRequest(
	state: LocalCoordinator,
	value: unknown,
): CoordinatorRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TreeCoordinatorError("Tree coordinator request must be an object.");
	}
	const request = value as Partial<CoordinatorRequest>;
	if (
		request.schemaVersion !== PROTOCOL_VERSION
		|| request.generation !== state.generation
		|| request.secret !== state.secret
		|| typeof request.operation !== "string"
		|| !Number.isSafeInteger(request.pid)
		|| Number(request.pid) <= 0
		|| typeof request.processIdentity !== "string"
		|| !processMatchesStartIdentity(
			Number(request.pid),
			request.processIdentity,
		)
	) {
		throw new TreeCoordinatorError(
			"Tree coordinator request identity or generation is invalid.",
			130,
		);
	}
	if (state.status !== "active") {
		throw new TreeCoordinatorError("Recursive tree authority is terminal.", 130);
	}
	return request as CoordinatorRequest;
}

function slotProcessAlive(slot: ActiveSlot): boolean {
	return processMatchesStartIdentity(slot.ownerPid, slot.ownerProcessIdentity)
		|| processMatchesStartIdentity(slot.childPid, slot.childProcessIdentity);
}

function pruneDeadSlots(state: LocalCoordinator): void {
	for (const [token, slot] of state.activeSlots) {
		if (!slotProcessAlive(slot)) state.activeSlots.delete(token);
	}
	for (const [token, slot] of state.suspendedSlots) {
		if (!slotProcessAlive(slot)) state.suspendedSlots.delete(token);
	}
}

function controlledSlots(state: LocalCoordinator): ActiveSlot[] {
	return [
		...state.activeSlots.values(),
		...state.suspendedSlots.values(),
	];
}

function bindMaximum(state: LocalCoordinator, request: CoordinatorRequest): number {
	const maximum = exactPositiveInteger(
		"RLM_MAX_CONCURRENT_CALLS",
		request.maximum,
	);
	if (state.maximum === undefined) state.maximum = maximum;
	if (state.maximum !== maximum) {
		throw new TreeCoordinatorError(
			`RLM_MAX_CONCURRENT_CALLS changed within one recursion tree: coordinator=${state.maximum} caller=${maximum}.`,
		);
	}
	return maximum;
}

function requireSlotToken(request: CoordinatorRequest): string {
	if (!request.token || !SLOT_TOKEN.test(request.token)) {
		throw new TreeCoordinatorError("Recursive concurrency slot token is invalid.");
	}
	return request.token;
}

function grantSlot(
	state: LocalCoordinator,
	socket: Socket,
	request: CoordinatorRequest,
	resume: boolean,
): void {
	const token = requireSlotToken(request);
	if (state.activeSlots.has(token)) {
		throw new TreeCoordinatorError(`Recursive concurrency slot already exists: ${token}`);
	}
	if (resume && !state.suspendedSlots.has(token)) {
		throw new TreeCoordinatorError(`Recursive concurrency suspension is unavailable: ${token}`);
	}
	const suspended = resume ? state.suspendedSlots.get(token) : undefined;
	if (resume) state.suspendedSlots.delete(token);
	const slot = {
		token,
		ownerPid: request.pid,
		ownerProcessIdentity: request.processIdentity,
		...(resume
			? {
				childPid: request.pid,
				childProcessIdentity: request.processIdentity,
			}
			: {}),
	};
	state.activeSlots.set(token, slot);

	let acknowledged = false;
	let ackInput = "";
	const rollback = () => {
		if (acknowledged) return;
		const current = state.activeSlots.get(token);
		if (current === slot) state.activeSlots.delete(token);
		if (resume && suspended && !state.suspendedSlots.has(token)) {
			state.suspendedSlots.set(token, suspended);
		}
		drainQueue(state);
	};
	const ackTimer = setTimeout(() => {
		rollback();
		socket.destroy();
	}, 5_000);
	ackTimer.unref();
	socket.removeAllListeners("data");
	socket.once("close", () => {
		clearTimeout(ackTimer);
		rollback();
	});
	socket.on("data", (chunk: string) => {
		ackInput += chunk;
		if (Buffer.byteLength(ackInput) > MAX_PROTOCOL_BYTES) {
			clearTimeout(ackTimer);
			rollback();
			socket.destroy();
			return;
		}
		const newline = ackInput.indexOf("\n");
		if (newline < 0) return;
		try {
			const ack = JSON.parse(ackInput.slice(0, newline)) as {
				schemaVersion?: unknown;
				ack?: unknown;
				token?: unknown;
			};
			if (
				ack.schemaVersion !== PROTOCOL_VERSION
				|| ack.ack !== true
				|| ack.token !== token
			) {
				throw new Error("invalid slot acknowledgement");
			}
			acknowledged = true;
			clearTimeout(ackTimer);
			response(socket, { ok: true, phase: "confirmed" });
		} catch {
			clearTimeout(ackTimer);
			rollback();
			socket.destroy();
		}
	});
	socket.resume();
	response(socket, { ok: true, phase: "grant" }, false);
}

function removeQueuedSocket(state: LocalCoordinator, socket: Socket): void {
	state.queue = state.queue.filter((candidate) => candidate.socket !== socket);
}

function drainQueue(state: LocalCoordinator): void {
	if (state.status !== "active" || state.maximum === undefined) return;
	pruneDeadSlots(state);
	while (state.activeSlots.size < state.maximum && state.queue.length > 0) {
		const queued = state.queue.shift()!;
		if (queued.socket.destroyed) continue;
		try {
			grantSlot(state, queued.socket, queued.request, queued.resume);
		} catch (error) {
			failureResponse(queued.socket, error);
		}
	}
}

function allocateCall(
	state: LocalCoordinator,
	request: CoordinatorRequest,
): number {
	const maximum = exactNonNegativeInteger("RLM_MAX_CALLS", request.maximum);
	const seed = exactNonNegativeInteger("RLM_CALL_COUNT", request.seedCallCount);
	if (!request.counterFile || !path.isAbsolute(request.counterFile)) {
		throw new TreeCoordinatorError(
			"RLM_CALL_COUNTER_FILE must be absolute for coordinated admission.",
		);
	}
	if (state.maxCalls === undefined) {
		let adoptedCounter:
			| {
				identity: AtomicFileIdentity;
				raw: string;
			}
			| undefined;
		if (!state.counterIdentity && existsSync(request.counterFile)) {
			const identity = capturePrivateFileIdentity(request.counterFile);
			const raw = readOwnedPrivateFile(
				request.counterFile,
				identity,
				"utf8",
				MAX_COUNTER_BYTES,
			);
			if (raw !== `${seed}\n`) {
				throw new TreeCoordinatorError(
					"Existing call-count projection does not match RLM_CALL_COUNT.",
				);
			}
			adoptedCounter = {
				identity: atomicIdentityFromPrivate(identity),
				raw,
			};
		}
		state.maxCalls = maximum;
		state.callCount = seed;
		if (
			state.counterFile !== undefined
			&& state.counterFile !== request.counterFile
		) {
			throw new TreeCoordinatorError(
				"Call-count projection path changed between root generations.",
			);
		}
		state.counterFile = request.counterFile;
		if (adoptedCounter) {
			state.counterIdentity = adoptedCounter.identity;
			state.counterRaw = adoptedCounter.raw;
		}
	}
	if (state.maxCalls !== maximum || state.counterFile !== request.counterFile) {
		throw new TreeCoordinatorError(
			"Call-count configuration changed within one recursion tree.",
		);
	}
	if (state.callCount >= maximum) {
		throw new TreeCoordinatorError(
			`Max calls exceeded: ${maximum} of ${maximum} child calls already used. Continue the task directly without spawning more children.`,
		);
	}
	const next = state.callCount + 1;
	const nextRaw = `${next}\n`;
	const nextIdentity = state.counterIdentity && state.counterRaw !== undefined
		? atomicConditionalReplaceFile(
			state.counterFile,
			state.counterIdentity,
			nextRaw,
			{ mode: 0o600, expectedContent: state.counterRaw },
		)
		: atomicCreateFile(state.counterFile, nextRaw, { mode: 0o600 });
	state.counterIdentity = nextIdentity;
	state.counterRaw = nextRaw;
	state.callCount = next;
	return next;
}

function handleRequest(
	state: LocalCoordinator,
	socket: Socket,
	raw: string,
): void {
	try {
		const request = authenticateRequest(state, JSON.parse(raw));
		switch (request.operation) {
			case "check":
				response(socket, { ok: true });
				return;
			case "allocate-call":
				response(socket, { ok: true, value: allocateCall(state, request) });
				return;
			case "acquire-slot":
			case "resume-slot": {
				const maximum = bindMaximum(state, request);
				pruneDeadSlots(state);
				const resume = request.operation === "resume-slot";
				if (state.activeSlots.size < maximum) {
					grantSlot(state, socket, request, resume);
					return;
				}
				state.queue.push({ socket, request, resume });
				socket.once("close", () => removeQueuedSocket(state, socket));
				return;
			}
			case "release-slot": {
				const token = requireSlotToken(request);
				state.activeSlots.delete(token);
				state.suspendedSlots.delete(token);
				response(socket, { ok: true });
				drainQueue(state);
				return;
			}
			case "suspend-slot": {
				const token = requireSlotToken(request);
				const slot = state.activeSlots.get(token);
				if (!slot) {
					throw new TreeCoordinatorError(
						`Recursive concurrency slot is unavailable for suspension: ${token}`,
					);
				}
				if (
					!(
						slot.ownerPid === request.pid
						&& slot.ownerProcessIdentity === request.processIdentity
					)
					&& !(
						slot.childPid === request.pid
						&& slot.childProcessIdentity === request.processIdentity
					)
				) {
					throw new TreeCoordinatorError(
						`Recursive process ${request.pid} does not own inherited concurrency slot ${token}.`,
					);
				}
				state.activeSlots.delete(token);
				state.suspendedSlots.set(token, slot);
				response(socket, { ok: true });
				drainQueue(state);
				return;
			}
			case "register-launch": {
				const token = requireSlotToken(request);
				const slot = state.activeSlots.get(token);
				if (!slot) {
					throw new TreeCoordinatorError(
						`Recursive concurrency slot is unavailable at the final launch gate: ${token}`,
						130,
					);
				}
				if (
					!Number.isSafeInteger(request.childPid)
					|| Number(request.childPid) <= 0
					|| typeof request.childProcessIdentity !== "string"
					|| !processMatchesStartIdentity(
						Number(request.childPid),
						request.childProcessIdentity,
					)
				) {
					throw new TreeCoordinatorError(
						"Recursive child launch identity is invalid.",
						130,
					);
				}
				slot.childPid = Number(request.childPid);
				slot.childProcessIdentity = request.childProcessIdentity;
				response(socket, { ok: true });
				return;
			}
		}
		throw new TreeCoordinatorError(
			`Unknown tree coordinator operation: ${request.operation}`,
		);
	} catch (error) {
		failureResponse(socket, error);
	}
}

function acceptConnection(state: LocalCoordinator, socket: Socket): void {
	socket.setEncoding("utf8");
	let input = "";
	socket.on("data", (chunk: string) => {
		input += chunk;
		if (Buffer.byteLength(input) > MAX_PROTOCOL_BYTES) {
			failureResponse(
				socket,
				new TreeCoordinatorError("Tree coordinator request exceeds the protocol bound."),
			);
			return;
		}
		const newline = input.indexOf("\n");
		if (newline < 0) return;
		socket.pause();
		handleRequest(state, socket, input.slice(0, newline));
	});
	socket.on("error", () => {
		removeQueuedSocket(state, socket);
	});
}

function parseManifest(value: unknown): AuthorityManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TreeCoordinatorError("Tree authority manifest must be an object.", 130);
	}
	const manifest = value as Partial<AuthorityManifest>;
	if (
		manifest.schemaVersion !== PROTOCOL_VERSION
		|| !GENERATION_TOKEN.test(manifest.generation || "")
		|| !Number.isSafeInteger(manifest.rootPid)
		|| Number(manifest.rootPid) <= 0
		|| typeof manifest.rootProcessIdentity !== "string"
		|| !manifest.rootProcessIdentity
		|| typeof manifest.socketPath !== "string"
		|| !path.isAbsolute(manifest.socketPath)
		|| !["starting", "active", "terminal"].includes(manifest.status || "")
		|| !Number.isSafeInteger(manifest.createdAtEpochMilliseconds)
		|| Number(manifest.createdAtEpochMilliseconds) < 0
	) {
		throw new TreeCoordinatorError("Tree authority manifest is invalid.", 130);
	}
	return manifest as AuthorityManifest;
}

function inheritedAuthority(): {
	manifest: AuthorityManifest;
	socketPath: string;
	generation: string;
	secret: string;
} {
	const manifestPath = process.env.YPI_TREE_AUTHORITY_FILE;
	const identityRaw = process.env.YPI_TREE_AUTHORITY_IDENTITY;
	const generation = process.env.YPI_TREE_GENERATION;
	const secret = process.env.YPI_TREE_SECRET;
	const socketPath = process.env.YPI_TREE_COORDINATOR_SOCKET;
	if (
		!manifestPath
		|| !path.isAbsolute(manifestPath)
		|| !identityRaw
		|| !GENERATION_TOKEN.test(generation || "")
		|| !SECRET_TOKEN.test(secret || "")
		|| !socketPath
		|| !path.isAbsolute(socketPath)
	) {
		throw new TreeCoordinatorError(
			"Recursive tree authority is unavailable or malformed.",
			130,
		);
	}
	let manifest: AuthorityManifest;
	try {
		const raw = readOwnedPrivateFile(
			manifestPath,
			parsePrivateFileIdentity(identityRaw),
			"utf8",
			MAX_MANIFEST_BYTES,
		);
		manifest = parseManifest(JSON.parse(raw));
	} catch (error) {
		if (error instanceof TreeCoordinatorError) throw error;
		throw new TreeCoordinatorError(
			`Recursive tree authority could not be verified: ${error instanceof Error ? error.message : String(error)}`,
			130,
		);
	}
	if (
		manifest.generation !== generation
		|| manifest.socketPath !== socketPath
		|| manifest.status !== "active"
	) {
		throw new TreeCoordinatorError(
			`Recursive tree authority is ${manifest.status}; no new work may be admitted.`,
			130,
		);
	}
	if (
		!processMatchesStartIdentity(
			manifest.rootPid,
			manifest.rootProcessIdentity,
		)
	) {
		throw new TreeCoordinatorError(
			"Recursive tree root identity is no longer live; no new work may be admitted.",
			130,
		);
	}
	return {
		manifest,
		socketPath,
		generation: generation!,
		secret: secret!,
	};
}

async function requestCoordinator(
	operation: CoordinatorRequest["operation"],
	options: CoordinatorWaitOptions = {},
	fields: Partial<CoordinatorRequest> = {},
): Promise<CoordinatorResponse> {
	const local = localCoordinator;
	if (
		local
		&& local.generation === process.env.YPI_TREE_GENERATION
		&& local.status === "starting"
	) {
		await local.ready;
	}
	if (options.signal?.aborted) {
		throw new TreeCoordinatorError(
			"Recursive child cancelled while waiting for tree authority.",
			130,
		);
	}
	const authority = inheritedAuthority();
	const pid = process.pid;
	const processIdentity = currentProcessStartIdentity();
	const request: CoordinatorRequest = {
		schemaVersion: PROTOCOL_VERSION,
		generation: authority.generation,
		secret: authority.secret,
		operation,
		pid,
		processIdentity,
		...fields,
	};
	return new Promise<CoordinatorResponse>((resolve, reject) => {
		let settled = false;
		let input = "";
		let timer: NodeJS.Timeout | undefined;
		const socket = createConnection(authority.socketPath);
		const finish = (error?: unknown, value?: CoordinatorResponse) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve(value!);
		};
		const onAbort = () => finish(
			new TreeCoordinatorError(
				"Recursive child cancelled while waiting for tree authority.",
				130,
			),
		);
		socket.once("connect", () => {
			socket.write(`${JSON.stringify(request)}\n`);
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			input += chunk;
			if (Buffer.byteLength(input) > MAX_PROTOCOL_BYTES) {
				finish(new TreeCoordinatorError("Tree coordinator response exceeds the protocol bound."));
				return;
			}
			while (!settled) {
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				const line = input.slice(0, newline);
				input = input.slice(newline + 1);
				try {
					const value = JSON.parse(line) as CoordinatorResponse;
					if (
						value.schemaVersion !== PROTOCOL_VERSION
						|| typeof value.ok !== "boolean"
					) {
						throw new Error("invalid response schema");
					}
					if (!value.ok) {
						finish(new TreeCoordinatorError(
							value.message || "Tree coordinator rejected the request.",
							value.exitCode || 1,
						));
						return;
					}
					if (
						(operation === "acquire-slot" || operation === "resume-slot")
						&& value.phase === "grant"
					) {
						socket.write(`${JSON.stringify({
							schemaVersion: PROTOCOL_VERSION,
							ack: true,
							token: fields.token,
						})}\n`);
						continue;
					}
					if (
						(operation === "acquire-slot" || operation === "resume-slot")
						&& value.phase !== "confirmed"
					) {
						throw new Error("slot grant was not confirmed");
					}
					finish(undefined, value);
				} catch (error) {
					finish(new TreeCoordinatorError(
						`Tree coordinator response is invalid: ${error instanceof Error ? error.message : String(error)}`,
					));
				}
			}
		});
		socket.once("error", (error) => {
			finish(new TreeCoordinatorError(
				`Recursive tree authority is unreachable: ${error.message}`,
				130,
			));
		});
		socket.once("close", () => {
			if (!settled) {
				finish(new TreeCoordinatorError(
					"Recursive tree authority closed before acknowledging the request.",
					130,
				));
			}
		});
		if (options.deadlineMilliseconds !== undefined) {
			const remaining = options.deadlineMilliseconds - Date.now();
			if (remaining <= 0) {
				finish(new TreeCoordinatorError(
					"RLM_TIMEOUT expired while waiting for tree authority.",
					124,
				));
				return;
			}
			timer = setTimeout(() => finish(new TreeCoordinatorError(
				"RLM_TIMEOUT expired while waiting for tree authority.",
				124,
			)), remaining);
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function coordinatorDirectory(): string {
	const directory = process.env.RLM_CONCURRENCY_DIR;
	if (!directory || !path.isAbsolute(directory)) {
		throw new TreeCoordinatorError(
			"RLM_CONCURRENCY_DIR must be an absolute private directory.",
		);
	}
	ensurePrivateDirectory(directory);
	return directory;
}

function coordinatorSocketLocation(
	directory: string,
	generation: string,
): {
	socketPath: string;
	socketOwner?: OwnedPrivateDirectory;
} {
	const preferred = path.join(
		directory,
		`coordinator-${generation.slice(0, 16)}.sock`,
	);
	if (
		process.platform === "win32"
		|| Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH_BYTES
	) {
		return { socketPath: preferred };
	}
	const socketOwner = createOwnedPrivateTempDirectory(
		path.join("/tmp", "ypi-coordinator."),
	);
	return {
		socketPath: path.join(socketOwner.path, "coordinator.sock"),
		socketOwner,
	};
}

function retireUnusedSocketOwner(owner: OwnedPrivateDirectory | undefined): void {
	if (!owner) return;
	retireOwnedPrivateTree(sealOwnedPrivateDirectory(owner, []));
}

function closeCoordinatorServer(state: LocalCoordinator): Promise<void> {
	if (state.socketRetirement) return state.socketRetirement;
	state.socketRetirement = new Promise<void>((resolve, reject) => {
		const finish = () => {
			try {
				retireUnusedSocketOwner(state.socketOwner);
				state.socketOwner = undefined;
				resolve();
			} catch (error) {
				reject(error);
			}
		};
		try {
			state.server.close(finish);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
				finish();
				return;
			}
			reject(error);
		}
	});
	// Root-turn replacement is synchronous and cannot await the old generation.
	// Keep the original promise rejectable for explicit termination callers while
	// preventing an unhandled rejection in replacement and startup-failure paths.
	void state.socketRetirement.catch(() => {});
	return state.socketRetirement;
}

function startLocalCoordinator(previous?: LocalCoordinator): LocalCoordinator {
	const directory = coordinatorDirectory();
	const previousCounter = previous
		&& previous.counterFile === process.env.RLM_CALL_COUNTER_FILE
		&& previous.counterIdentity
		&& previous.counterRaw !== undefined
		? {
			counterFile: previous.counterFile,
			counterIdentity: previous.counterIdentity,
			counterRaw: previous.counterRaw,
		}
		: {};
	const generation = randomBytes(16).toString("hex");
	const secret = randomBytes(32).toString("hex");
	const rootProcessIdentity = currentProcessStartIdentity();
	const { socketPath, socketOwner } = coordinatorSocketLocation(
		directory,
		generation,
	);
	const manifestPath = path.join(directory, `authority-${generation}.json`);
	const manifest: AuthorityManifest = {
		schemaVersion: PROTOCOL_VERSION,
		generation,
		rootPid: process.pid,
		rootProcessIdentity,
		socketPath,
		status: "starting",
		createdAtEpochMilliseconds: Date.now(),
	};
	const manifestRaw = manifestText(manifest);
	let manifestAtomicIdentity: AtomicFileIdentity;
	try {
		manifestAtomicIdentity = atomicCreateFile(
			manifestPath,
			manifestRaw,
			{ mode: 0o600 },
		);
	} catch (error) {
		try {
			retireUnusedSocketOwner(socketOwner);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Tree coordinator manifest creation and socket-directory cleanup failed.",
			);
		}
		throw error;
	}
	const manifestIdentity = capturePrivateFileIdentity(manifestPath);
	const server = createServer();
	const state: LocalCoordinator = {
		generation,
		secret,
		socketPath,
		manifestPath,
		manifestIdentity,
		manifestAtomicIdentity,
		manifestRaw,
		manifest,
		server,
		status: "starting" as const,
		socketOwner,
		activeSlots: new Map<string, ActiveSlot>(),
		suspendedSlots: new Map<string, ActiveSlot>(),
		queue: [],
		callCount: 0,
		...previousCounter,
		ready: Promise.resolve(),
	};
	server.on("connection", (socket) => acceptConnection(state, socket));
	state.ready = new Promise<void>((resolve, reject) => {
		let startupSettled = false;
		const failStartup = (error: unknown) => {
			if (startupSettled) return;
			startupSettled = true;
			const failure = error instanceof Error
				? error
				: new TreeCoordinatorError("Tree coordinator startup failed.", 130);
			if (state.status !== "terminal") {
				state.status = "terminal";
				try {
					updateManifest(state, {
						...state.manifest,
						status: "terminal",
						terminalAtEpochMilliseconds: Date.now(),
						terminalReason: `coordinator-start-failed:${failure.message}`.slice(0, 200),
					});
				} catch {
					// Preserve the original startup error when the authority path vanished
					// or was replaced concurrently.
				}
			}
			void closeCoordinatorServer(state);
			reject(failure);
		};
		server.on("error", (error) => {
			if (!startupSettled) {
				failStartup(error);
				return;
			}
			if (state.status === "terminal") return;
			state.status = "terminal";
			try {
				updateManifest(state, {
					...state.manifest,
					status: "terminal",
					terminalAtEpochMilliseconds: Date.now(),
					terminalReason: `coordinator-server-failed:${error.message}`.slice(0, 200),
				});
			} catch {
				// The next authority request still fails closed on the terminal state.
			}
			for (const queued of state.queue.splice(0)) {
				failureResponse(
					queued.socket,
					new TreeCoordinatorError("Recursive tree authority failed.", 130),
				);
			}
			void closeCoordinatorServer(state);
		});
		try {
			server.listen(socketPath, () => {
				try {
					if (state.status === "terminal") {
						throw new TreeCoordinatorError(
							"Tree coordinator was terminalized during startup.",
							130,
						);
					}
					chmodSync(socketPath, 0o600);
					updateManifest(state, { ...state.manifest, status: "active" });
					state.status = "active";
					server.unref();
					startupSettled = true;
					resolve();
				} catch (error) {
					failStartup(error);
				}
			});
		} catch (error) {
			failStartup(error);
		}
	});
	// Environment setup is synchronous and some callers never make a recursive
	// request. Observe readiness here so a concurrent teardown cannot become an
	// unhandled rejection; requestCoordinator still awaits the original promise.
	void state.ready.catch(() => {});

	process.env.YPI_TREE_AUTHORITY_FILE = manifestPath;
	process.env.YPI_TREE_AUTHORITY_IDENTITY = JSON.stringify(manifestIdentity);
	process.env.YPI_TREE_COORDINATOR_SOCKET = socketPath;
	process.env.YPI_TREE_GENERATION = generation;
	process.env.YPI_TREE_SECRET = secret;
	appendCoordinatorTrace(
		`TREE_GENERATION_START generation=${generation} root_pid=${process.pid}`,
	);
	return state;
}

function markLocalCoordinatorTerminal(
	state: LocalCoordinator,
	reason: string,
): number[] {
	if (state.status === "terminal") return [];
	state.status = "terminal";
	const boundedReason = reason.replace(/[\r\n]+/g, " ").slice(0, 200) || "terminal";
	updateManifest(state, {
		...state.manifest,
		status: "terminal",
		terminalAtEpochMilliseconds: Date.now(),
		terminalReason: boundedReason,
	});
	appendCoordinatorTrace(
		`TREE_TERMINAL generation=${state.generation} reason=${JSON.stringify(boundedReason)} active_slots=${state.activeSlots.size}`,
	);
	for (const queued of state.queue.splice(0)) {
		failureResponse(
			queued.socket,
			new TreeCoordinatorError("Recursive tree authority became terminal.", 130),
		);
	}
	void closeCoordinatorServer(state);
	const groups = new Map<number, string>();
	for (const slot of controlledSlots(state)) {
		if (
			slot.childPid
			&& slot.childPid !== process.pid
			&& slot.childProcessIdentity
			&& processMatchesStartIdentity(
				slot.childPid,
				slot.childProcessIdentity,
			)
		) {
			groups.set(slot.childPid, slot.childProcessIdentity);
		}
	}
	for (const [pid] of groups) {
		try {
			const target = process.platform !== "win32" && processGroupId(pid) === pid
				? -pid
				: pid;
			process.kill(target, "SIGTERM");
		} catch {
			// The registered process group may already be terminal.
		}
	}
	return [...groups.keys()];
}

export function ensureRootTreeCoordinator(): void {
	const depth = process.env.RLM_DEPTH || "0";
	if (depth !== "0") return;
	if (
		localCoordinator
		&& localCoordinator.status !== "terminal"
		&& process.env.YPI_TREE_GENERATION === localCoordinator.generation
	) return;
	if (localCoordinator && localCoordinator.status !== "terminal") {
		markLocalCoordinatorTerminal(localCoordinator, "root-generation-replaced");
	}
		localCoordinator = startLocalCoordinator(localCoordinator);
}

export function beginRootTreeCoordinator(reason = "root-turn"): void {
	if ((process.env.RLM_DEPTH || "0") !== "0") {
		throw new TreeCoordinatorError(
			"Only a depth-0 root may begin a tree coordinator generation.",
		);
	}
	if (localCoordinator && localCoordinator.status !== "terminal") {
		markLocalCoordinatorTerminal(localCoordinator, reason);
	}
	process.env.RLM_CALL_COUNT = "0";
	localCoordinator = startLocalCoordinator(localCoordinator);
}

export function terminateRootTreeCoordinator(reason: string): Promise<void> {
	const state = localCoordinator;
	if (!state || state.status === "terminal") {
		return state?.termination || Promise.resolve();
	}
	const groups = markLocalCoordinatorTerminal(state, reason);
	const processTermination = new Promise<void>((resolve) => {
			if (groups.length === 0) {
			resolve();
			return;
		}
			setTimeout(() => {
				for (const pid of groups) {
					const slot = controlledSlots(state).find(
						(candidate) => candidate.childPid === pid,
					);
				if (
					!slot?.childProcessIdentity
					|| !processMatchesStartIdentity(pid, slot.childProcessIdentity)
				) continue;
				try {
					const target = process.platform !== "win32" && processGroupId(pid) === pid
						? -pid
						: pid;
					process.kill(target, "SIGKILL");
				} catch {
					// The registered process group may already be terminal.
				}
			}
			resolve();
			}, TERMINATION_GRACE_MILLISECONDS);
	});
	state.termination = Promise.all([
		processTermination,
		closeCoordinatorServer(state),
	]).then(() => undefined);
	return state.termination;
}

export async function assertTreeCoordinatorActive(
	options: CoordinatorWaitOptions = {},
): Promise<void> {
	await requestCoordinator("check", options);
}

export async function allocateCoordinatedCall(
	maximum: number,
	seedCallCount: number,
	counterFile: string,
	options: CoordinatorWaitOptions = {},
): Promise<number> {
	const result = await requestCoordinator("allocate-call", options, {
		maximum,
		seedCallCount,
		counterFile,
	});
	if (!Number.isSafeInteger(result.value) || Number(result.value) < 1) {
		throw new TreeCoordinatorError("Tree coordinator returned an invalid call count.");
	}
	return Number(result.value);
}

export async function acquireCoordinatedSlot(
	token: string,
	maximum: number,
	options: CoordinatorWaitOptions = {},
): Promise<void> {
	await requestCoordinator("acquire-slot", options, { token, maximum });
}

export async function releaseCoordinatedSlot(token: string): Promise<void> {
	await requestCoordinator("release-slot", {}, { token });
}

export async function suspendCoordinatedSlot(
	token: string,
	options: CoordinatorWaitOptions = {},
): Promise<void> {
	await requestCoordinator("suspend-slot", options, { token });
}

export async function resumeCoordinatedSlot(
	token: string,
	maximum: number,
	options: CoordinatorWaitOptions = {},
): Promise<void> {
	await requestCoordinator("resume-slot", options, { token, maximum });
}

export async function registerCoordinatedLaunch(
	token: string,
	childPid = process.pid,
	options: CoordinatorWaitOptions = {},
): Promise<void> {
	const childProcessIdentity = processStartIdentity(childPid);
	if (!childProcessIdentity) {
		throw new TreeCoordinatorError(
			`Stable recursive child identity is unavailable for PID ${childPid}.`,
			130,
		);
	}
	await requestCoordinator("register-launch", options, {
		token,
		childPid,
		childProcessIdentity,
	});
}

export function treeAuthorityManifestForTests(): AuthorityManifest | undefined {
	return localCoordinator ? { ...localCoordinator.manifest } : undefined;
}

export function treeCoordinatorHasSlotForTests(token: string): boolean {
	return localCoordinator?.activeSlots.has(token) || false;
}

export function treeCoordinatorSlotCountForTests(): number {
	return localCoordinator?.activeSlots.size || 0;
}

export function treeCoordinatorSocketExistsForTests(): boolean {
	return Boolean(localCoordinator?.socketPath && existsSync(localCoordinator.socketPath));
}

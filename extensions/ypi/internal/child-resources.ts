import {
	existsSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId, sharedSessionsEnabled } from "../env.ts";
import { atomicCopyFile, atomicCreateFile } from "./atomic-file.ts";
import {
	createPrivateDirectory,
	createOwnedPrivateTempDirectory,
	retireOwnedPrivateTree,
	sealOwnedPrivateDirectory,
	type OwnedPrivateTree,
	withPrivateUmask,
} from "./private-path.ts";
import { renderActiveTaskFilesSection } from "./task-files.ts";
import {
	abandonUnstartedTranscriptProof,
	closeTranscriptProof,
	prepareTranscriptProof,
	type TranscriptProofLease,
	transcriptsRequired,
} from "./transcript.ts";
import { acquireWorkspace, type ChildMode, type WorkspaceLease } from "./workspace-policy.ts";

export interface ChildResourceInput {
	prompt: string;
	context?: string;
	contextPath?: string;
	fork?: boolean;
	cwd: string;
	parentSessionFile?: string;
	parentSessionDir?: string;
	childDepth: number;
	callCount: number;
	systemPromptPath?: string;
	rootPromptPath?: string;
	setupDeadlineMilliseconds?: number;
	fullResourceIsolation?: boolean;
	selectedProvider?: string;
	mode: ChildMode;
	scope?: string[];
}

export interface ChildResourceLease {
	promptFile: string;
	contextFile?: string;
	childSession?: string;
	transcriptProof?: TranscriptProofLease;
	standaloneSystemPromptFile?: string;
	isolatedPiRoot?: string;
	workspace: WorkspaceLease;
	cleanup(): Error[];
}

interface OwnedFileArtifact {
	filePath: string;
	tree: OwnedPrivateTree;
}

function createContextFile(input: ChildResourceInput): OwnedFileArtifact | undefined {
	if (input.context !== undefined) {
		const owner = createOwnedPrivateTempDirectory(path.join(tmpdir(), "ypi_ctx_"));
		const contextPath = path.join(owner.path, "context.txt");
		atomicCreateFile(contextPath, input.context);
		return {
			filePath: contextPath,
			tree: sealOwnedPrivateDirectory(owner, ["context.txt"]),
		};
	}

	const inheritedPath = input.contextPath || process.env.CONTEXT;
	if (inheritedPath && existsSync(inheritedPath)) {
		const owner = createOwnedPrivateTempDirectory(path.join(tmpdir(), "ypi_ctx_"));
		const contextPath = path.join(owner.path, "context.txt");
		atomicCopyFile(inheritedPath, contextPath);
		return {
			filePath: contextPath,
			tree: sealOwnedPrivateDirectory(owner, ["context.txt"]),
		};
	}
	return undefined;
}

function createPromptFile(prompt: string): OwnedFileArtifact {
	const owner = createOwnedPrivateTempDirectory(path.join(tmpdir(), "ypi_prompt_"));
	const promptPath = path.join(owner.path, "prompt.txt");
	atomicCreateFile(promptPath, prompt);
	return {
		filePath: promptPath,
		tree: sealOwnedPrivateDirectory(owner, ["prompt.txt"]),
	};
}

function createStandaloneSystemPrompt(
	input: ChildResourceInput,
	promptFile: string,
	contextFile?: string,
): OwnedFileArtifact | undefined {
	if (!input.systemPromptPath || !existsSync(input.systemPromptPath)) return undefined;
	const owner = createOwnedPrivateTempDirectory(path.join(tmpdir(), "ypi_system_"));
	const outputPath = path.join(owner.path, "system-prompt.md");
	const section = renderActiveTaskFilesSection({
		contextPath: contextFile,
		promptPath: promptFile,
		rootPromptPath: input.rootPromptPath || promptFile,
	});
	atomicCreateFile(outputPath, `${readFileSync(input.systemPromptPath, "utf8")}${section}`);
	return {
		filePath: outputPath,
		tree: sealOwnedPrivateDirectory(owner, ["system-prompt.md"]),
	};
}

function childSessionFile(input: ChildResourceInput): string | undefined {
	if (!sharedSessionsEnabled()) {
		if (transcriptsRequired()) {
			throw new Error(
				"RLM_REQUIRE_TRANSCRIPTS=1 requires RLM_SHARED_SESSIONS=1 and an explicit child session directory; do not run the root with --no-session.",
			);
		}
		return undefined;
	}
	const sessionDir = process.env.RLM_SESSION_DIR || (input.parentSessionFile ? input.parentSessionDir : "");
	if (!sessionDir) {
		if (transcriptsRequired()) {
			throw new Error(
				"RLM_REQUIRE_TRANSCRIPTS=1 requires an explicit child session directory; do not run the root with --no-session.",
			);
		}
		return undefined;
	}
	if (transcriptsRequired()) {
		if (!path.isAbsolute(sessionDir)) {
			throw new Error(
				`RLM_REQUIRE_TRANSCRIPTS=1 requires an absolute session directory: ${sessionDir}`,
			);
		}
		// Required mode validates and holds the existing private directory in
		// prepareTranscriptProof. Creating it recursively here would permit
		// symlinked ancestors and umask-dependent permissions.
		return path.join(sessionDir, `${safeTraceId(process.env.RLM_TRACE_ID || "ypi")}_d${input.childDepth}_c${input.callCount}.jsonl`);
	}
	withPrivateUmask(() => mkdirSync(sessionDir, { recursive: true, mode: 0o700 }));
	return path.join(sessionDir, `${safeTraceId(process.env.RLM_TRACE_ID || "ypi")}_d${input.childDepth}_c${input.callCount}.jsonl`);
}

function copyForkSession(input: ChildResourceInput, childSession: string | undefined): void {
	const parentSession = input.parentSessionFile || process.env.RLM_SESSION_FILE;
	if (input.fork && childSession && parentSession && existsSync(parentSession)) {
		atomicCopyFile(parentSession, childSession);
	}
}

function cleanupErrors(actions: Array<() => void>): Error[] {
	const errors: Error[] = [];
	for (const action of actions) {
		try {
			action();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	return errors;
}

function cleanupChildResources(input: {
	workspace?: WorkspaceLease;
	transcriptProof?: TranscriptProofLease;
	promptTree?: OwnedPrivateTree;
	contextTree?: OwnedPrivateTree;
	standaloneSystemPromptTree?: OwnedPrivateTree;
	isolatedPiTree?: OwnedPrivateTree;
}): Error[] {
	return cleanupErrors([
		() => input.workspace?.cleanup(),
		() => closeTranscriptProof(input.transcriptProof),
		() => input.promptTree && retireOwnedPrivateTree(input.promptTree),
		() => input.contextTree && retireOwnedPrivateTree(input.contextTree),
		() => input.standaloneSystemPromptTree
			&& retireOwnedPrivateTree(input.standaloneSystemPromptTree),
		() => input.isolatedPiTree && retireOwnedPrivateTree(input.isolatedPiTree),
	]);
}

function errorWithCleanupFailures(
	primary: unknown,
	cleanupFailures: Error[],
): Error & { exitCode?: number } {
	const primaryError = primary instanceof Error
		? primary as Error & { exitCode?: number }
		: new Error(String(primary)) as Error & { exitCode?: number };
	if (cleanupFailures.length === 0) return primaryError;
	const combined = new Error(
		`${primaryError.message}\nResource cleanup also failed: ${cleanupFailures.map((item) => item.message).join("; ")}`,
		{ cause: primaryError },
	) as Error & { exitCode?: number };
	combined.exitCode = primaryError.exitCode;
	return combined;
}

function configuredParentAgentDir(): string {
	const home = process.env.HOME || homedir();
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return path.join(home, ".pi", "agent");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return path.join(home, configured.slice(2));
	}
	return configured;
}

function projectSelectedProviderAuth(agentDir: string, selectedProvider: string | undefined): boolean {
	if (!selectedProvider) return false;
	const parentAgentDir = configuredParentAgentDir();
	const sourceAuthPath = path.join(parentAgentDir, "auth.json");
	if (!existsSync(sourceAuthPath)) return false;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(sourceAuthPath, "utf8"));
	} catch {
		throw new Error("Full child isolation could not project selected provider authentication: parent auth.json is malformed");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Full child isolation could not project selected provider authentication: parent auth.json must be an object");
	}
	if (!Object.hasOwn(parsed, selectedProvider)) return false;
	const credential = (parsed as Record<string, unknown>)[selectedProvider];
	if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
		throw new Error("Full child isolation could not project selected provider authentication: selected provider entry is invalid");
	}

	const projected: Record<string, unknown> = Object.create(null);
	Object.defineProperty(projected, selectedProvider, {
		value: credential,
		enumerable: true,
		configurable: false,
		writable: false,
	});
	const targetAuthPath = path.join(agentDir, "auth.json");
	atomicCreateFile(targetAuthPath, `${JSON.stringify(projected, null, 2)}\n`);
	return true;
}

export function acquireChildResources(input: ChildResourceInput): ChildResourceLease {
	let promptArtifact: OwnedFileArtifact | undefined;
	let contextArtifact: OwnedFileArtifact | undefined;
	let standaloneSystemPromptArtifact: OwnedFileArtifact | undefined;
	let isolatedPiTree: OwnedPrivateTree | undefined;
	let workspace: WorkspaceLease | undefined;
	let transcriptProof: TranscriptProofLease | undefined;
	try {
		promptArtifact = createPromptFile(input.prompt);
		contextArtifact = createContextFile(input);
		standaloneSystemPromptArtifact = createStandaloneSystemPrompt(
			input,
			promptArtifact.filePath,
			contextArtifact?.filePath,
		);
		if (input.fullResourceIsolation) {
			const isolatedPiOwner = createOwnedPrivateTempDirectory(
				path.join(tmpdir(), "ypi_isolated_pi_"),
			);
			const isolatedAgentDir = path.join(isolatedPiOwner.path, "agent");
			createPrivateDirectory(isolatedAgentDir);
			const projectedAuth = projectSelectedProviderAuth(
				isolatedAgentDir,
				input.selectedProvider,
			);
			isolatedPiTree = sealOwnedPrivateDirectory(
				isolatedPiOwner,
				projectedAuth ? ["agent", path.join("agent", "auth.json")] : ["agent"],
			);
		}
		const childSession = childSessionFile(input);
		if (transcriptsRequired()) {
			const forkSource = input.fork
				? input.parentSessionFile || process.env.RLM_SESSION_FILE
				: undefined;
			if (input.fork && !forkSource) {
				throw new Error("Required fork transcript has no parent session source.");
			}
			transcriptProof = prepareTranscriptProof({ childSession, forkSource });
		} else {
			copyForkSession(input, childSession);
		}
		if (input.setupDeadlineMilliseconds !== undefined && Date.now() >= input.setupDeadlineMilliseconds) {
			const error = new Error("RLM_TIMEOUT expired during recursive resource setup") as Error & { exitCode: number };
			error.exitCode = 124;
			throw error;
		}
		workspace = acquireWorkspace({
			cwd: input.cwd,
			childDepth: input.childDepth,
			mode: input.mode,
			scope: input.scope,
			setupDeadlineMilliseconds: input.setupDeadlineMilliseconds,
		});
		return {
			promptFile: promptArtifact.filePath,
			contextFile: contextArtifact?.filePath,
			childSession,
			transcriptProof,
			standaloneSystemPromptFile: standaloneSystemPromptArtifact?.filePath,
			isolatedPiRoot: isolatedPiTree?.path,
			workspace,
			cleanup() {
				return cleanupChildResources({
					workspace,
					transcriptProof,
					promptTree: promptArtifact?.tree,
					contextTree: contextArtifact?.tree,
					standaloneSystemPromptTree: standaloneSystemPromptArtifact?.tree,
					isolatedPiTree,
				});
			},
		};
	} catch (error) {
		const transcriptRetirementFailures = cleanupErrors([
			() => abandonUnstartedTranscriptProof(transcriptProof),
		]);
		const failures = cleanupChildResources({
			workspace,
			transcriptProof,
			promptTree: promptArtifact?.tree,
			contextTree: contextArtifact?.tree,
			standaloneSystemPromptTree: standaloneSystemPromptArtifact?.tree,
			isolatedPiTree,
		});
		throw errorWithCleanupFailures(
			error,
			[...transcriptRetirementFailures, ...failures],
		);
	}
}

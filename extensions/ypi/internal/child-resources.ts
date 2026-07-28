import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { safeTraceId, sharedSessionsEnabled } from "../env.ts";
import { atomicCopyFile } from "./atomic-file.ts";
import { renderActiveTaskFilesSection } from "./task-files.ts";
import { requiredTranscriptBaseline, transcriptsRequired } from "./transcript.ts";
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
	transcriptBaselineBytes?: number;
	standaloneSystemPromptFile?: string;
	isolatedPiRoot?: string;
	workspace: WorkspaceLease;
	cleanup(): void;
}

function createContextFile(input: ChildResourceInput): string | undefined {
	if (input.context !== undefined) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		writeFileSync(contextPath, input.context);
		return contextPath;
	}

	const inheritedPath = input.contextPath || process.env.CONTEXT;
	if (inheritedPath && existsSync(inheritedPath)) {
		const contextPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_ctx_")), "context.txt");
		copyFileSync(inheritedPath, contextPath);
		return contextPath;
	}
	return undefined;
}

function createPromptFile(prompt: string): string {
	const promptPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_prompt_")), "prompt.txt");
	writeFileSync(promptPath, prompt);
	return promptPath;
}

function createStandaloneSystemPrompt(input: ChildResourceInput, promptFile: string, contextFile?: string): string | undefined {
	if (!input.systemPromptPath || !existsSync(input.systemPromptPath)) return undefined;
	const outputPath = path.join(mkdtempSync(path.join(tmpdir(), "ypi_system_")), "system-prompt.md");
	const section = renderActiveTaskFilesSection({
		contextPath: contextFile,
		promptPath: promptFile,
		rootPromptPath: input.rootPromptPath || promptFile,
	});
	writeFileSync(outputPath, `${readFileSync(input.systemPromptPath, "utf8")}${section}`);
	return outputPath;
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
	mkdirSync(sessionDir, { recursive: true });
	if (transcriptsRequired()) {
		const metadata = lstatSync(sessionDir);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error(
				`RLM_REQUIRE_TRANSCRIPTS=1 requires a regular non-symlink session directory: ${sessionDir}`,
			);
		}
	}
	return path.join(sessionDir, `${safeTraceId(process.env.RLM_TRACE_ID || "ypi")}_d${input.childDepth}_c${input.callCount}.jsonl`);
}

function copyForkSession(input: ChildResourceInput, childSession: string | undefined): void {
	const parentSession = input.parentSessionFile || process.env.RLM_SESSION_FILE;
	if (input.fork && childSession && parentSession && existsSync(parentSession)) {
		atomicCopyFile(parentSession, childSession);
	}
}

function removeArtifact(filePath: string | undefined): void {
	if (filePath) rmSync(path.dirname(filePath), { recursive: true, force: true });
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

function projectSelectedProviderAuth(agentDir: string, selectedProvider: string | undefined): void {
	if (!selectedProvider) return;
	const parentAgentDir = configuredParentAgentDir();
	const sourceAuthPath = path.join(parentAgentDir, "auth.json");
	if (!existsSync(sourceAuthPath)) return;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(sourceAuthPath, "utf8"));
	} catch {
		throw new Error("Full child isolation could not project selected provider authentication: parent auth.json is malformed");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Full child isolation could not project selected provider authentication: parent auth.json must be an object");
	}
	if (!Object.hasOwn(parsed, selectedProvider)) return;
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
	writeFileSync(targetAuthPath, `${JSON.stringify(projected, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	chmodSync(targetAuthPath, 0o600);
}

export function acquireChildResources(input: ChildResourceInput): ChildResourceLease {
	let promptFile: string | undefined;
	let contextFile: string | undefined;
	let standaloneSystemPromptFile: string | undefined;
	let isolatedPiRoot: string | undefined;
	let workspace: WorkspaceLease | undefined;
	try {
		promptFile = createPromptFile(input.prompt);
		contextFile = createContextFile(input);
		standaloneSystemPromptFile = createStandaloneSystemPrompt(input, promptFile, contextFile);
		if (input.fullResourceIsolation) {
			isolatedPiRoot = mkdtempSync(path.join(tmpdir(), "ypi_isolated_pi_"));
			chmodSync(isolatedPiRoot, 0o700);
			const isolatedAgentDir = path.join(isolatedPiRoot, "agent");
			mkdirSync(isolatedAgentDir, { recursive: true, mode: 0o700 });
			chmodSync(isolatedAgentDir, 0o700);
			projectSelectedProviderAuth(isolatedAgentDir, input.selectedProvider);
		}
			const childSession = childSessionFile(input);
			copyForkSession(input, childSession);
			const transcriptBaselineBytes = requiredTranscriptBaseline(childSession);
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
			promptFile,
			contextFile,
				childSession,
				transcriptBaselineBytes,
			standaloneSystemPromptFile,
			isolatedPiRoot,
			workspace,
			cleanup() {
				workspace?.cleanup();
				removeArtifact(promptFile);
				removeArtifact(contextFile);
				removeArtifact(standaloneSystemPromptFile);
				if (isolatedPiRoot) rmSync(isolatedPiRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		workspace?.cleanup();
		removeArtifact(promptFile);
		removeArtifact(contextFile);
		removeArtifact(standaloneSystemPromptFile);
		if (isolatedPiRoot) rmSync(isolatedPiRoot, { recursive: true, force: true });
		throw error;
	}
}

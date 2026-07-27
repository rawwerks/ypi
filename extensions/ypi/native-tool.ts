import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canExecute, readCostSummary } from "./guardrails.ts";
import { appendRuntimeTrace, formatRecursiveResultForTool, runRecursiveChild, type ChildToolActivity } from "./runtime-core.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

const RlmQueryParams = Type.Object({
	prompt: Type.String({
		description: "Task for a child Pi agent. Keep it clear and bounded.",
	}),
	context: Type.Optional(Type.String({
		description: "Optional exact context to pass to the child via CONTEXT.",
	})),
	fork: Type.Optional(Type.Boolean({
		description: "Copy the current session file into the child session before running.",
	})),
	mode: Type.Optional(Type.String({
		description: "review (default, read-only) or implement (root-only writer in an isolated Git worktree).",
		pattern: "^(review|implement)$",
	})),
	scope: Type.Optional(Type.Array(Type.String({
		description: "Literal repository-relative file or directory path prefix owned by this implementer.",
		maxLength: 1024,
	}), {
		description: "Required for implement mode. Concurrent implementers must declare disjoint scopes.",
		minItems: 1,
		maxItems: 64,
	})),
});

export function registerNativeRlmQueryTool(pi: ExtensionAPI, runtime: YpiRuntime): void {
	const tool = defineTool({
		name: "rlm_query",
		label: "Recursive query",
		description: "Delegate a bounded task to a child Pi agent using ypi's canonical recursion runtime.",
		promptSnippet: "Delegate a bounded task to a child Pi agent with a fresh context window.",
		promptGuidelines: [
			"Use rlm_query for clear subtasks that benefit from an extra context window.",
			"Pass exact source text through the context parameter when the child must inspect specific data.",
			"Use rlm_query mode=review for audits, research, and probes; review is read-only and is the default.",
			"Use root-only mode=implement with an explicit scope for bounded edit/write work. Parallel implementers require disjoint declared scopes; the parent integrates returned refs, then runs commands and tests.",
			"Do not recurse past the active RLM_MAX_DEPTH limit.",
		],
		parameters: RlmQueryParams,
		executionMode: "parallel" as const,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const started = Date.now();
			const activities = new Map<string, ChildToolActivity>();
			let assistantTail = "";
			let admittedCall: number | undefined;
			let lastEventAt = started;
			let staleTraced = false;
			const configuredStale = Number.parseInt(process.env.YPI_STALL_WARNING_SECONDS || "600", 10);
			const staleAfterSeconds = Number.isSafeInteger(configuredStale) && configuredStale > 0 ? configuredStale : 600;

			const formatElapsed = (seconds: number) => {
				const hours = Math.floor(seconds / 3600);
				const minutes = Math.floor((seconds % 3600) / 60);
				const rest = seconds % 60;
				return hours > 0 ? `${hours}h${String(minutes).padStart(2, "0")}m${String(rest).padStart(2, "0")}s` : `${minutes}m${String(rest).padStart(2, "0")}s`;
			};
			const publishProgress = () => {
				if (!onUpdate) return;
				const now = Date.now();
				const elapsedSeconds = Math.max(0, Math.floor((now - started) / 1000));
				const idleSeconds = Math.max(0, Math.floor((now - lastEventAt) / 1000));
				const stale = idleSeconds >= staleAfterSeconds;
				if (stale && !staleTraced) {
					appendRuntimeTrace(`STALE_WARNING caller=tool idle=${idleSeconds}s action=observe_only`);
					if (ctx.hasUI) ctx.ui.notify(`Recursive child has emitted no new event for ${formatElapsed(idleSeconds)}; it is still running.`, "warning");
					staleTraced = true;
				}
				const spent = readCostSummary();
				const activityLines = [...activities.values()].map((activity) => {
					const marker = activity.status === "succeeded" ? "✓" : activity.status === "failed" ? "✗" : "…";
					return `${marker} ${activity.label}`;
				});
				const header = [
					stale ? `No new child events for ${formatElapsed(idleSeconds)}; still running — cancel manually if desired` : "Child running",
					`elapsed ${formatElapsed(elapsedSeconds)}`,
					`call ${admittedCall ?? "pending"}/${process.env.RLM_MAX_CALLS || "∞"}`,
					`completed cost ${spent.incomplete ? "at least " : ""}$${spent.cost.toFixed(4)}`,
				].join(" · ");
				const statusBlock = [header, ...activityLines].join("\n");
				const remaining = Math.max(0, 8_192 - statusBlock.length - 1);
				const body = `${statusBlock}${assistantTail ? `\n${assistantTail.slice(-remaining)}` : ""}`;
				onUpdate({
					content: [{ type: "text" as const, text: body }],
					details: {
						phase: stale ? "stale-warning" : "streaming",
						elapsedSeconds,
						idleSeconds,
						callCount: admittedCall,
						activities: [...activities.values()].map(({ label, status }) => ({ label, status })),
					},
				});
			};
			const noteEvent = () => {
				lastEventAt = Date.now();
				staleTraced = false;
			};
			let timer: NodeJS.Timeout | undefined;
			const scheduleProgress = () => {
				if (!onUpdate) return;
				const elapsed = Date.now() - started;
				const delay = elapsed < 60_000 ? 1_000 : elapsed < 600_000 ? 5_000 : 30_000;
				timer = setTimeout(() => {
					publishProgress();
					scheduleProgress();
				}, delay);
				timer.unref?.();
			};
			publishProgress();
			scheduleProgress();

			try {
				const result = await runRecursiveChild(runtime, {
					prompt: params.prompt,
					context: params.context,
					fork: params.fork,
					mode: params.mode === "implement" ? "implement" : "review",
					scope: params.scope,
					caller: "tool",
					signal,
					onAdmitted(callCount) {
						admittedCall = callCount;
						noteEvent();
					},
					onText(text) {
						assistantTail = `${assistantTail}${text}`.slice(-4_096);
						noteEvent();
					},
					onToolActivity(activity) {
						activities.delete(activity.key);
						activities.set(activity.key, activity);
						while (activities.size > 4) activities.delete(activities.keys().next().value!);
						noteEvent();
					},
					parent: {
						cwd: ctx.cwd,
						provider: ctx.model?.provider,
						model: ctx.model?.id,
						thinkingLevel: pi.getThinkingLevel(),
						sessionFile: ctx.sessionManager.getSessionFile() || undefined,
						sessionDir: ctx.sessionManager.getSessionFile() ? ctx.sessionManager.getSessionDir() : undefined,
					},
				});
				publishProgress();

				return {
					content: [{ type: "text" as const, text: formatRecursiveResultForTool(result) }],
					details: result.details,
				};
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	});

	pi.registerTool(tool);
	debug("__YPI_NATIVE_TOOL_REGISTERED__ rlm_query");
	if (process.env.YPI_PI_BIN && !canExecute(process.env.YPI_PI_BIN)) {
		debug(`__YPI_NATIVE_PI_BIN_NOT_EXECUTABLE__ ${process.env.YPI_PI_BIN}`);
	}
}

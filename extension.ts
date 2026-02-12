/**
 * Pi RLM Extension — Approach 3: Tool-Use REPL
 *
 * Registers an "rlm" provider that uses completeWithTools() to give the LLM
 * search tools for iteratively querying conversation history. This is the
 * proper recursive approach — the model searches, reads, and iterates until
 * it has enough information to answer.
 *
 * The system prompt from Pi (which includes --append-system-prompt content)
 * is parsed to extract session data. The LLM then uses tools like
 * search_sessions and get_session to find relevant information.
 *
 * Usage:
 *   pi -e ./path/to/pi-rlm-extension --provider rlm --model rlm-default
 *
 * For LongMemEval:
 *   pi -p --provider rlm --model rlm-default --no-session \
 *     --append-system-prompt context.md "What degree did I graduate with?"
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Api,
	type SimpleStreamOptions,
	type ToolCall,
	type ToolResultMessage,
	type Tool,
	type Message,
	createAssistantMessageEventStream,
	completeWithTools,
	type CompleteWithToolsOptions,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Configuration ──

/** Which backend model to use for the recursive sub-completions */
const BACKEND_PROVIDER = process.env.RLM_BACKEND_PROVIDER || "anthropic";
const BACKEND_MODEL = process.env.RLM_BACKEND_MODEL || "claude-sonnet-4-5-20250929";
const MAX_TURNS = parseInt(process.env.RLM_MAX_TURNS || "15", 10);

// ── Session data types ──

interface SessionTurn {
	role: string;
	content: string;
}

interface Session {
	index: number;
	date: string;
	turns: SessionTurn[];
}

interface ParsedContext {
	sessions: Session[];
	questionDate?: string;
	rawText: string;
}

// ── Context parsing ──

/**
 * Parse the system prompt to extract structured session data.
 * Expects the format produced by run_pi_rlm.py / LongMemEval adapter:
 *
 *   === Session 1 (2023/05/20 (Sat) 02:21) ===
 *   [user]: Hello
 *   [assistant]: Hi there
 */
function parseSessionsFromSystemPrompt(systemPrompt: string): ParsedContext {
	const sessions: Session[] = [];
	let questionDate: string | undefined;

	// Extract question date if present
	const dateMatch = systemPrompt.match(/The current date is:\s*(.+)/);
	if (dateMatch) {
		questionDate = dateMatch[1].trim();
	}

	// Split into session blocks. Date may contain parens like (Sat), so match
	// from "=== Session N (" to ") ===" greedily within the line.
	const sessionPattern = /=== Session (\d+) \((.+?)\) ===([\s\S]*?)(?==== Session \d|\s*$)/g;
	let match;

	while ((match = sessionPattern.exec(systemPrompt)) !== null) {
		const sessionIndex = parseInt(match[1], 10) - 1; // 0-based
		const date = match[2].trim();
		const body = match[3].trim();

		const turns: SessionTurn[] = [];
		const turnPattern = /\[(\w+)\]:\s*([\s\S]*?)(?=\n\[\w+\]:|\s*$)/g;
		let turnMatch;

		while ((turnMatch = turnPattern.exec(body)) !== null) {
			turns.push({
				role: turnMatch[1],
				content: turnMatch[2].trim(),
			});
		}

		sessions.push({ index: sessionIndex, date, turns });
	}

	return { sessions, questionDate, rawText: systemPrompt };
}

// ── Tool implementations ──

function searchSessions(
	ctx: ParsedContext,
	query: string,
	maxResults: number = 10,
): Array<{ sessionIndex: number; date: string; role: string; content: string; turnIndex: number }> {
	const results: Array<{ sessionIndex: number; date: string; role: string; content: string; turnIndex: number; score: number }> = [];
	const queryLower = query.toLowerCase();
	const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

	for (const session of ctx.sessions) {
		for (let ti = 0; ti < session.turns.length; ti++) {
			const turn = session.turns[ti];
			const contentLower = turn.content.toLowerCase();

			// Score by number of query terms found
			let score = 0;
			for (const term of queryTerms) {
				if (contentLower.includes(term)) {
					score++;
				}
			}
			// Exact phrase match bonus
			if (contentLower.includes(queryLower)) {
				score += queryTerms.length * 2;
			}

			if (score > 0) {
				results.push({
					sessionIndex: session.index,
					date: session.date,
					role: turn.role,
					content: turn.content.length > 500 ? turn.content.slice(0, 500) + "..." : turn.content,
					turnIndex: ti,
					score,
				});
			}
		}
	}

	// Sort by score descending, take top N
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, maxResults).map(({ score: _, ...rest }) => rest);
}

function getSession(ctx: ParsedContext, sessionIndex: number): Session | null {
	return ctx.sessions.find((s) => s.index === sessionIndex) ?? null;
}

function getSessionsByDate(
	ctx: ParsedContext,
	startDate?: string,
	endDate?: string,
): Array<{ index: number; date: string; turnCount: number }> {
	return ctx.sessions
		.filter((s) => {
			if (startDate && s.date < startDate) return false;
			if (endDate && s.date > endDate) return false;
			return true;
		})
		.map((s) => ({ index: s.index, date: s.date, turnCount: s.turns.length }));
}

// ── Tool definitions ──

const TOOLS: Tool[] = [
	{
		name: "search_sessions",
		description:
			"Search all conversation sessions by keyword. Returns matching turns with session index, date, role, and content snippet. Use this to find relevant information before answering.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (keywords or phrases)" }),
			maxResults: Type.Optional(Type.Number({ description: "Maximum results to return (default: 10)" })),
		}),
	},
	{
		name: "get_session",
		description: "Get the full content of a specific conversation session by its index. Use after search_sessions to read the complete context of a relevant session.",
		parameters: Type.Object({
			sessionIndex: Type.Number({ description: "0-based session index" }),
		}),
	},
	{
		name: "get_sessions_by_date",
		description: "List sessions within a date range. Returns session indices, dates, and turn counts.",
		parameters: Type.Object({
			startDate: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD), inclusive" })),
			endDate: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD), inclusive" })),
		}),
	},
	{
		name: "count_sessions",
		description: "Get the total number of sessions and the date range of the conversation history.",
		parameters: Type.Object({}),
	},
];

// ── Tool executor ──

function createToolExecutor(parsedCtx: ParsedContext) {
	return async (toolCall: ToolCall): Promise<ToolResultMessage> => {
		let resultText: string;
		let isError = false;

		try {
			switch (toolCall.name) {
				case "search_sessions": {
					const { query, maxResults } = toolCall.arguments as { query: string; maxResults?: number };
					const results = searchSessions(parsedCtx, query, maxResults ?? 10);
					resultText = results.length > 0
						? JSON.stringify(results, null, 2)
						: `No results found for "${query}". Try different search terms.`;
					break;
				}
				case "get_session": {
					const { sessionIndex } = toolCall.arguments as { sessionIndex: number };
					const session = getSession(parsedCtx, sessionIndex);
					if (session) {
						resultText = JSON.stringify(session, null, 2);
					} else {
						resultText = `Session ${sessionIndex} not found. Valid range: 0-${parsedCtx.sessions.length - 1}`;
						isError = true;
					}
					break;
				}
				case "get_sessions_by_date": {
					const { startDate, endDate } = toolCall.arguments as { startDate?: string; endDate?: string };
					const results = getSessionsByDate(parsedCtx, startDate, endDate);
					resultText = JSON.stringify(results, null, 2);
					break;
				}
				case "count_sessions": {
					const count = parsedCtx.sessions.length;
					const dates = parsedCtx.sessions.map((s) => s.date).sort();
					resultText = JSON.stringify({
						count,
						firstDate: dates[0] || null,
						lastDate: dates[dates.length - 1] || null,
						questionDate: parsedCtx.questionDate || null,
					});
					break;
				}
				default:
					resultText = `Unknown tool: ${toolCall.name}`;
					isError = true;
			}
		} catch (err) {
			resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
			isError = true;
		}

		return {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: resultText }],
			isError,
			timestamp: Date.now(),
		};
	};
}

// ── Streaming handler ──

/**
 * The streamSimple handler for the "rlm" provider.
 *
 * 1. Parses session data from the system prompt
 * 2. Resolves a backend model + API key from Pi's modelRegistry
 * 3. Calls completeWithTools() with search tools
 * 4. Streams the final answer back to Pi
 */
function createStreamHandler(extensionCtx: { modelRegistry: any; model: any }) {
	return function streamRlm(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const eventStream = createAssistantMessageEventStream();

		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};

			try {
				eventStream.push({ type: "start", partial: output });

				// 1. Parse sessions from system prompt
				const parsedCtx = parseSessionsFromSystemPrompt(context.systemPrompt || "");

				if (parsedCtx.sessions.length === 0) {
					throw new Error("No sessions found in system prompt. Ensure --append-system-prompt points to a context file with session data.");
				}

				// 2. Resolve backend model
				const registry = extensionCtx.modelRegistry;
				const backendModel = registry.find(BACKEND_PROVIDER, BACKEND_MODEL);
				if (!backendModel) {
					throw new Error(`Backend model ${BACKEND_PROVIDER}/${BACKEND_MODEL} not found. Available models: ${registry.getAll().map((m: any) => `${m.provider}/${m.id}`).join(", ")}`);
				}

				console.error(`  [rlm] Backend model resolved: ${backendModel.provider}/${backendModel.id} (api: ${backendModel.api})`);

				const apiKey = await registry.getApiKey(backendModel);
				if (!apiKey) {
					throw new Error(`No API key for ${BACKEND_PROVIDER}. Run: pi /login ${BACKEND_PROVIDER}`);
				}

				// 3. Extract the user question from context messages
				const userQuestion = context.messages
					.filter((m): m is Message & { role: "user" } => m.role === "user")
					.map((m) => {
						if (typeof m.content === "string") return m.content;
						if (Array.isArray(m.content)) {
							return m.content
								.filter((b): b is { type: "text"; text: string } => b.type === "text")
								.map((b) => b.text)
								.join("\n");
						}
						return "";
					})
					.pop() || "";

				// 4. Build the agent context with tools
				// System prompt adapted from longmemeval-rlm exp 004 (tool-aware prompt)
				// Key lessons: delegation prevents context rot, lean instructions for Flash-class models
				const systemPrompt = [
					"Answer a question about a user's conversation history.",
					"",
					`There are ${parsedCtx.sessions.length} sessions from ${parsedCtx.sessions[0]?.date || "unknown"} to ${parsedCtx.sessions[parsedCtx.sessions.length - 1]?.date || "unknown"}.`,
					parsedCtx.questionDate ? `The current date is: ${parsedCtx.questionDate}` : "",
					"",
					"You have tools: search_sessions, get_session, get_sessions_by_date, count_sessions.",
					"",
					"WORKFLOW:",
					"1. FIND: Use search_sessions with keywords from the question. Try multiple",
					"   synonyms if the first search returns nothing useful.",
					"2. READ: Use get_session to read promising sessions. Focus on the specific",
					"   facts needed — do not try to memorize entire sessions.",
					"3. VERIFY: For entity questions, search for the EXACT entity name.",
					"   If the exact entity is not found, answer \"I don't know\".",
					"4. ANSWER: Give the shortest possible answer.",
					"",
					"RULES:",
					"- For counting questions: enumerate each item explicitly before counting.",
					"- For temporal questions: note exact dates from sessions, compute with math.",
					"- If the information is NOT in the history, say \"I don't know\".",
					"- Do NOT substitute a similar entity for the one asked about.",
				]
					.filter(Boolean)
					.join("\n");

				const agentMessages: Message[] = [
					{
						role: "user",
						content: [{ type: "text", text: userQuestion }],
						timestamp: Date.now(),
					},
				];

				const toolExecutor = createToolExecutor(parsedCtx);

				// 5. Run the tool-use loop
				const cwOptions: CompleteWithToolsOptions = {
					apiKey,
					maxTurns: MAX_TURNS,
					signal: options?.signal,
					onTurn: (turn) => {
						const toolCalls = turn.message.content.filter((c) => c.type === "toolCall");
						if (toolCalls.length > 0) {
							const names = toolCalls.map((c) => (c as ToolCall).name).join(", ");
							console.error(`  [rlm] Turn ${turn.index + 1}: tools=[${names}]`);
						} else {
							const text = turn.message.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("")
								.slice(0, 100);
							console.error(`  [rlm] Turn ${turn.index + 1}: final answer (${text}...)`);
						}
					},
				};

				const result = await completeWithTools(
					backendModel,
					{ systemPrompt, messages: agentMessages, tools: TOOLS },
					cwOptions,
					toolExecutor,
				);

				console.error(`  [rlm] Completed in ${result.turns} turns, ${result.usage.totalTokens} tokens`);

				// 6. Stream the final answer
				const finalText = result.finalText;

				output.content.push({ type: "text", text: "" });
				eventStream.push({ type: "text_start", contentIndex: 0, partial: output });

				const textBlock = output.content[0];
				if (textBlock.type === "text") {
					textBlock.text = finalText;
				}
				eventStream.push({ type: "text_delta", contentIndex: 0, delta: finalText, partial: output });
				eventStream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });

				// Update usage from aggregated result
				output.usage = result.usage;

				eventStream.push({ type: "done", reason: "stop", message: output });
				eventStream.end();
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				console.error(`  [rlm] Error: ${output.errorMessage}`);
				eventStream.push({ type: "error", reason: output.stopReason, error: output });
				eventStream.end();
			}
		})();

		return eventStream;
	};
}

// ── Extension entry point ──

export default function (pi: ExtensionAPI) {
	// We need the modelRegistry from the extension context to resolve backend models.
	// Capture it from the first event handler that fires.
	const sharedCtx: { modelRegistry: any; model: any } = {
		modelRegistry: null,
		model: null,
	};

	// Register the RLM provider
	pi.registerProvider("rlm", {
		baseUrl: "local://rlm",
		apiKey: "RLM_DUMMY_KEY",
		api: "rlm-tool-use-api",
		models: [
			{
				id: "rlm-default",
				name: "RLM Tool-Use (Approach 3)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 16384,
			},
		],
		streamSimple: (model, context, options) => {
			if (!sharedCtx.modelRegistry) {
				const s = createAssistantMessageEventStream();
				const err: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: "ModelRegistry not yet initialized. Send a message first to trigger session_start.",
					timestamp: Date.now(),
				};
				s.push({ type: "error", reason: "error", error: err });
				s.end();
				return s;
			}
			return createStreamHandler(sharedCtx)(model, context, options);
		},
	});

	// Capture modelRegistry on session_start
	pi.on("session_start", async (_event, ctx) => {
		sharedCtx.modelRegistry = ctx.modelRegistry;
		sharedCtx.model = ctx.model;

		// Verify backend model is available
		const backendModel = ctx.modelRegistry.find(BACKEND_PROVIDER, BACKEND_MODEL);
		if (backendModel) {
			const apiKey = await ctx.modelRegistry.getApiKey(backendModel);
			if (apiKey) {
				ctx.ui.setStatus("rlm", `RLM: ${BACKEND_PROVIDER}/${BACKEND_MODEL}`);
			} else {
				ctx.ui.setStatus("rlm", `RLM: no key for ${BACKEND_PROVIDER}`);
			}
		} else {
			ctx.ui.setStatus("rlm", `RLM: model not found`);
		}
	});

	// Also capture on turn_start in case session_start didn't fire (e.g., print mode)
	pi.on("turn_start", async (_event, ctx) => {
		if (!sharedCtx.modelRegistry) {
			sharedCtx.modelRegistry = ctx.modelRegistry;
			sharedCtx.model = ctx.model;
		}
	});

	// Register /rlm status command
	pi.registerCommand("rlm", {
		description: "Show RLM extension status",
		handler: async (_args, ctx) => {
			const backendModel = ctx.modelRegistry.find(BACKEND_PROVIDER, BACKEND_MODEL);
			const hasKey = backendModel ? !!(await ctx.modelRegistry.getApiKey(backendModel)) : false;

			ctx.ui.notify(
				[
					`RLM Extension (Approach 3: Tool-Use REPL)`,
					`  Backend: ${BACKEND_PROVIDER}/${BACKEND_MODEL}`,
					`  Model found: ${!!backendModel}`,
					`  API key: ${hasKey ? "available" : "missing"}`,
					`  Max turns: ${MAX_TURNS}`,
					``,
					`  Override with env vars:`,
					`    RLM_BACKEND_PROVIDER=${BACKEND_PROVIDER}`,
					`    RLM_BACKEND_MODEL=${BACKEND_MODEL}`,
					`    RLM_MAX_TURNS=${MAX_TURNS}`,
				].join("\n"),
				"info",
			);
		},
	});
}

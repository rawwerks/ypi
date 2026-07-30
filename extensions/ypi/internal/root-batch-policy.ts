import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "rlm_query"]);

export function registerRootImplementerBatchPolicy(pi: ExtensionAPI): void {
	const blocked = new Map<string, string>();

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		blocked.clear();
		if ((process.env.RLM_DEPTH || "0") !== "0" || process.env.YPI_IMPLEMENT_ROOT) return;
		const calls = event.message.content.filter((part) => part.type === "toolCall");
		const hasImplementer = calls.some((call) =>
			call.name === "rlm_query" && call.arguments.mode === "implement");
		if (!hasImplementer) return;
		for (const call of calls) {
			if (ROOT_READ_ONLY_TOOLS.has(call.name)) continue;
			blocked.set(
				call.id,
				`Root tool "${call.name}" cannot share a parallel batch with implementer children. Wait for the complete implementer batch, inspect every returned ref, then mutate or integrate in a later turn.`,
			);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		const reason = blocked.get(event.toolCallId);
		if (!reason) return undefined;
		blocked.delete(event.toolCallId);
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});

	pi.on("turn_end", () => {
		blocked.clear();
	});
}

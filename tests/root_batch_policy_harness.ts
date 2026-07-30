import { registerRootImplementerBatchPolicy } from "../extensions/ypi/internal/root-batch-policy.ts";

type Handler = (event: any, ctx: any) => unknown;

const handlers = new Map<string, Handler[]>();
registerRootImplementerBatchPolicy({
	on(event: string, handler: Handler) {
		const registered = handlers.get(event) || [];
		registered.push(handler);
		handlers.set(event, registered);
	},
} as any);

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = "") {
	if (ok) { pass++; console.log(`  ✓ ${label}`); }
	else { fail++; console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
}

async function emit(event: string, payload: any): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(event) || []) {
		results.push(await handler(payload, { hasUI: false }));
	}
	return results;
}

function assistant(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", ...call })),
		},
	};
}

async function toolCall(id: string, name: string): Promise<{ block?: boolean; reason?: string } | undefined> {
	const [result] = await emit("tool_call", {
		type: "tool_call",
		toolCallId: id,
		toolName: name,
		input: {},
	});
	return result as { block?: boolean; reason?: string } | undefined;
}

console.log("\n=== Root implementer batch policy harness ===");
process.env.RLM_DEPTH = "0";

await emit("message_end", assistant([
	{ id: "implement-a", name: "rlm_query", arguments: { mode: "implement", scope: ["a"] } },
	{ id: "read-a", name: "read", arguments: { path: "a" } },
	{ id: "edit-root", name: "edit", arguments: { path: "a" } },
	{ id: "plugin-root", name: "unknown_mutator", arguments: {} },
]));
record(await toolCall("implement-a", "rlm_query") === undefined, "implementer call remains admitted");
record(await toolCall("read-a", "read") === undefined, "known read-only root call may share the batch");
const edit = await toolCall("edit-root", "edit");
record(
	edit?.block === true && edit.reason?.includes("cannot share a parallel batch") === true,
	"root edit is blocked from an implementer batch",
	JSON.stringify(edit),
);
const plugin = await toolCall("plugin-root", "unknown_mutator");
record(
	plugin?.block === true && plugin.reason?.includes("unknown_mutator") === true,
	"unknown root tool fails closed in an implementer batch",
	JSON.stringify(plugin),
);

await emit("turn_end", { type: "turn_end" });
await emit("message_end", assistant([
	{ id: "ordinary-edit", name: "edit", arguments: { path: "a" } },
]));
record(await toolCall("ordinary-edit", "edit") === undefined, "ordinary root mutation remains available outside implementer batches");

await emit("message_end", assistant([
	{ id: "implement-b", name: "rlm_query", arguments: { mode: "implement", scope: ["b"] } },
	{ id: "implement-c", name: "rlm_query", arguments: { mode: "implement", scope: ["c"] } },
]));
record(
	await toolCall("implement-b", "rlm_query") === undefined
		&& await toolCall("implement-c", "rlm_query") === undefined,
	"parallel implementer-only batch remains available",
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

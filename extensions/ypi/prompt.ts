import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { shellHelperEnabled } from "./env.ts";
import { renderActiveTaskFilesSection } from "./internal/task-files.ts";
import type { YpiRuntime } from "./runtime.ts";
import { debug } from "./runtime.ts";

const MINIMAL_SYSTEM_PROMPT = `# ypi Minimal Recursive Mode

You are Pi with a native \`rlm_query\` tool.

- Use the native \`rlm_query\` tool to delegate clear, bounded subtasks to child Pi agents.
- Native \`rlm_query\` calls can run in parallel. The runtime queues breadth above three active child generations without dropping calls. Derive disjoint path scopes before batching implementers, and wait for the whole batch before root mutation or integration. Use shell \`rlm_query --async\` only for bounded read-only fan-out when that optional helper exists.
- Each child receives a fresh context window and can call \`rlm_query\` again until \`RLM_MAX_DEPTH\`.
- \`rlm_query\` defaults to read-only review mode. Only the root may use implement mode, with an explicit repository-relative path scope. Each implementer edits an isolated Git worktree and returns a verified attempt ref; the parent integrates refs and runs commands and tests.
- Never install or initialize version-control tooling. Never overlap implementer scopes or auto-resolve an integration conflict.
- Cost is telemetry only; never set or recommend a dollar budget.
- Never release or mutate a non-owned remote without an explicit user request for that exact operation.
- The shell command named \`rlm_query\` is optional compatibility glue. Do not require it for minimal recursion.
`;

function runtimeImplementationSection(runtime: YpiRuntime): string {
	if (!shellHelperEnabled(runtime)) {
		debug("__YPI_EXTENSION_NO_SHELL_HELPER__");
		return "";
	}

	const rlmQuery = readFileSync(runtime.rlmQueryPath, "utf8");
	const runtimeCore = readFileSync(runtime.runtimeCorePath, "utf8");
	const internalRuntime = readdirSync(runtime.runtimeInternalDir)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => `// ${name}\n${readFileSync(`${runtime.runtimeInternalDir}/${name}`, "utf8")}`)
		.join("\n\n");
	const cliAdapter = readFileSync(runtime.cliAdapterPath, "utf8");
	return `

## SECTION 6 - Canonical rlm_query Runtime Implementation

The shell command is a thin launcher. Child planning, guardrails, resources,
process execution, result handling, and cleanup belong to the shared TypeScript
runtime below. The CLI adapter adds stdin, async jobs, and notification; the Pi
adapter calls the same runtime directly.

### Launcher

\`\`\`bash
${rlmQuery}
\`\`\`

### Canonical runtime core

\`\`\`typescript
${runtimeCore}
\`\`\`

### Internal runtime owners

\`\`\`typescript
${internalRuntime}
\`\`\`

### CLI adapter

\`\`\`typescript
${cliAdapter}
\`\`\`
`;
}

export function buildYpiPrompt(runtime: YpiRuntime): string {
	let systemPrompt: string;
	if (existsSync(runtime.systemPromptPath)) {
		systemPrompt = readFileSync(runtime.systemPromptPath, "utf8");
	} else {
		debug("__YPI_EXTENSION_MINIMAL_PROMPT__");
		systemPrompt = MINIMAL_SYSTEM_PROMPT;
	}

	return `${systemPrompt}${renderActiveTaskFilesSection({
		contextPath: process.env.CONTEXT,
		promptPath: process.env.RLM_PROMPT_FILE,
		rootPromptPath: process.env.RLM_ROOT_PROMPT_FILE,
	})}${runtimeImplementationSection(runtime)}`;
}

export function patchSystemPrompt(runtime: YpiRuntime, event: BeforeAgentStartEvent): string {
	const ypiPrompt = buildYpiPrompt(runtime);
	const mode = process.env.YPI_EXTENSION_PROMPT_MODE || "append";

	if (mode === "replace") {
		return ypiPrompt;
	}

	return `${event.systemPrompt}

${ypiPrompt}`;
}

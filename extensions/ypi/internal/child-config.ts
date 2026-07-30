import path from "node:path";
import { maxDepth, sharedSessionsEnabled } from "../env.ts";
import type { YpiRuntime } from "../runtime.ts";

export const READ_ONLY_EXCLUDED_BUILTINS = ["bash", "edit", "write"] as const;
export const IMPLEMENT_TOOL_ALLOWLIST = ["read", "grep", "find", "ls", "edit", "write", "rlm_query"] as const;

export interface ParentRouteContext {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
}

function commaEntry(value: string | undefined, oneBasedIndex: number): string {
	if (!value || oneBasedIndex < 1) return "";
	const parts = value.split(",").map((part) => part.trim());
	return parts[oneBasedIndex - 1] || "";
}

export function resolveChildRoute(parent: ParentRouteContext, childDepth: number): { provider: string; model: string; thinkingLevel: string } {
	let provider = process.env.RLM_PROVIDER || parent.provider || "";
	let model = process.env.RLM_MODEL || parent.model || "";
	let thinkingLevel = process.env.RLM_THINKING_LEVEL || parent.thinkingLevel || "";

	const depthModel = commaEntry(process.env.RLM_CHILD_MODELS, childDepth);
	const depthProvider = commaEntry(process.env.RLM_CHILD_PROVIDERS, childDepth);
	const depthThinking = commaEntry(process.env.RLM_CHILD_THINKING_LEVELS, childDepth);

	if (childDepth > 0) {
		if (depthModel) model = depthModel;
		else if (process.env.RLM_CHILD_MODEL) model = process.env.RLM_CHILD_MODEL;

		if (depthProvider) provider = depthProvider;
		else if (process.env.RLM_CHILD_PROVIDER && (depthModel || process.env.RLM_CHILD_MODEL)) provider = process.env.RLM_CHILD_PROVIDER;

		if (depthThinking) thinkingLevel = depthThinking;
		else if (process.env.RLM_CHILD_THINKING_LEVEL) thinkingLevel = process.env.RLM_CHILD_THINKING_LEVEL;
	}

	return { provider, model, thinkingLevel };
}

export function childExtensionsEnabled(childDepth: number): boolean {
	let enabled = process.env.RLM_EXTENSIONS !== "0";
	if (childDepth > 0 && process.env.RLM_CHILD_EXTENSIONS) {
		enabled = process.env.RLM_CHILD_EXTENSIONS !== "0";
	}
	return enabled;
}

function removePathEntry(currentPath: string | undefined, entry: string): string | undefined {
	if (!currentPath) return currentPath;
	return currentPath.split(path.delimiter).filter((candidate) => candidate && candidate !== entry).join(path.delimiter);
}

export const CHILD_PLATFORM_ENV_KEYS = [
	"HOME",
	"PATH",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SHELL",
	"USER",
	"LOGNAME",
] as const;

export const CHILD_PI_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_PACKAGE_DIR",
	"PI_OFFLINE",
	"PI_TELEMETRY",
	"PI_SHARE_VIEWER_URL",
] as const;

export const CHILD_RUNTIME_WILDCARD_PREFIXES = ["RLM_", "YPI_"] as const;
export const CHILD_RUNTIME_FIXED_KEYS = ["CONTEXT", "PI_TRACE_FILE"] as const;
export const CHILD_RUNTIME_EXCLUDED_KEYS = [
	"RLM_BUDGET",
	"YPI_EXPLICIT_RELEASE_REQUEST",
	"YPI_EXPLICIT_NON_OWNED_REMOTE",
	"YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS",
] as const;
export const CHILD_RUNTIME_EXCLUDED_PREFIXES = ["YPI_EXPLICIT_"] as const;

// Full-isolation children retain only environment values used by their selected
// provider. Keep provider aliases/config companions beside the credential owner;
// the flat allowlist below remains the parity surface for normal children.
const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
	"github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
	huggingface: ["HF_TOKEN"],
	"ant-ling": ["ANT_LING_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	"azure-openai-responses": ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "AZURE_API_VERSION"],
	deepseek: ["DEEPSEEK_API_KEY"],
	nvidia: ["NVIDIA_API_KEY"],
	google: ["GEMINI_API_KEY"],
	"google-vertex": ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
	groq: ["GROQ_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	xai: ["XAI_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	"vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
	zai: ["ZAI_API_KEY"],
	"zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	"minimax-cn": ["MINIMAX_CN_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	"moonshotai-cn": ["MOONSHOT_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
	"opencode-go": ["OPENCODE_API_KEY"],
	"kimi-coding": ["KIMI_API_KEY"],
	"cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_HOST", "CLOUDFLARE_WORKERS_AI_BASE_URL"],
	"cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "CLOUDFLARE_API_HOST", "CLOUDFLARE_AI_GATEWAY_HOST", "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL", "CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL", "CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL"],
	xiaomi: ["XIAOMI_API_KEY"],
	"xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	"xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	"xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
	"amazon-bedrock": ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"],
	ollama: ["OLLAMA_API_KEY"],
	portkey: ["PORTKEY_API_KEY"],
};

// Keep in sync with Pi's provider credential source of truth. The provider
// allowlist test derives completeness from pinned pi-mono when available.
export const PROVIDER_ENV_ALLOWLIST = new Set([
	"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "HF_TOKEN", "ANT_LING_API_KEY", "OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
	"OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY",
	"OPENCODE_API_KEY", "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
	"XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
	"GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "OLLAMA_API_KEY", "PORTKEY_API_KEY", "MINIMAX_CN_API_KEY",
	"AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_API_VERSION", "CLOUDFLARE_API_HOST", "CLOUDFLARE_AI_GATEWAY_HOST", "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL", "CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL",
	"CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL", "CLOUDFLARE_WORKERS_AI_BASE_URL",
]);

export function retainSelectedProviderEnvironment(env: NodeJS.ProcessEnv, selectedProvider: string): void {
	const retained = new Set(PROVIDER_ENV_KEYS[selectedProvider] || []);
	for (const key of PROVIDER_ENV_ALLOWLIST) {
		if (!retained.has(key)) delete env[key];
	}
}

export function buildChildEnvironment(baseEnv: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv, runtime: YpiRuntime, childDepth: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of CHILD_PLATFORM_ENV_KEYS) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of CHILD_PI_ENV_KEYS) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const key of PROVIDER_ENV_ALLOWLIST) {
		if (baseEnv[key]) env[key] = baseEnv[key];
	}
	for (const [key, value] of Object.entries(baseEnv)) {
		if (
			CHILD_RUNTIME_EXCLUDED_KEYS.includes(
				key as typeof CHILD_RUNTIME_EXCLUDED_KEYS[number],
			)
			|| CHILD_RUNTIME_EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))
		) continue;
		if (
			CHILD_RUNTIME_WILDCARD_PREFIXES.some((prefix) => key.startsWith(prefix))
			|| CHILD_RUNTIME_FIXED_KEYS.includes(
				key as typeof CHILD_RUNTIME_FIXED_KEYS[number],
			)
		) env[key] = value;
	}
	Object.assign(env, overrides);
	delete env.YPI_EXPLICIT_RELEASE_REQUEST;
	delete env.YPI_EXPLICIT_NON_OWNED_REMOTE;
	delete env.YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS;

	if (childDepth >= maxDepth()) env.PATH = removePathEntry(env.PATH, runtime.root);
	if (!sharedSessionsEnabled()) {
		env.RLM_SESSION_DIR = "";
		env.RLM_SESSION_FILE = "";
	}
	return env;
}

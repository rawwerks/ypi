import { readFileSync } from "node:fs";
import path from "node:path";
import {
	buildChildEnvironment,
	CHILD_PI_ENV_KEYS,
	CHILD_PLATFORM_ENV_KEYS,
	CHILD_RUNTIME_EXCLUDED_KEYS,
	CHILD_RUNTIME_EXCLUDED_PREFIXES,
	CHILD_RUNTIME_FIXED_KEYS,
	CHILD_RUNTIME_WILDCARD_PREFIXES,
	retainSelectedProviderEnvironment,
} from "../extensions/ypi/internal/child-config.ts";
import { resolveRuntime } from "../extensions/ypi/runtime.ts";

const root = path.resolve(import.meta.dir, "..");
const registry = JSON.parse(
	readFileSync(path.join(root, "config", "runtime-env.json"), "utf8"),
).child_environment_projection;
const runtime = resolveRuntime(
	new URL("../extensions/recursive.ts", import.meta.url).href,
);

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}`);
	}
}
function same(left: readonly string[], right: readonly string[]): boolean {
	return JSON.stringify([...left]) === JSON.stringify([...right]);
}

console.log("\n=== Child environment projection ===");
record(same(registry.fixed_platform, CHILD_PLATFORM_ENV_KEYS), "registry owns fixed platform projection");
record(same(registry.fixed_pi, CHILD_PI_ENV_KEYS), "registry owns fixed Pi projection");
record(same(registry.wildcard_prefixes, CHILD_RUNTIME_WILDCARD_PREFIXES), "registry owns wildcard projection");
record(same(registry.fixed_runtime, CHILD_RUNTIME_FIXED_KEYS), "registry owns fixed runtime projection");
record(same(registry.excluded, CHILD_RUNTIME_EXCLUDED_KEYS), "registry owns explicit projection exclusions");
record(same(registry.excluded_prefixes, CHILD_RUNTIME_EXCLUDED_PREFIXES), "registry owns wildcard exclusions");

process.env.RLM_MAX_DEPTH = "3";
const base = Object.fromEntries([
	...CHILD_PLATFORM_ENV_KEYS.map((key) => [key, `platform-${key}`]),
	...CHILD_PI_ENV_KEYS.map((key) => [key, `pi-${key}`]),
	["RLM_FUTURE_CONTROL", "future-rlm"],
	["YPI_FUTURE_CONTROL", "future-ypi"],
	["CONTEXT", "/context"],
	["PI_TRACE_FILE", "/trace"],
	["RLM_BUDGET", "unsupported"],
	["YPI_EXPLICIT_RELEASE_REQUEST", "secret"],
	["YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS", "secret"],
	["UNLISTED_SECRET", "secret"],
	["AWS_ACCESS_KEY_ID", "access"],
	["AWS_SECRET_ACCESS_KEY", "secret"],
	["AWS_SESSION_TOKEN", "session"],
]);
const projected = buildChildEnvironment(base, {}, runtime, 1);
record(
	CHILD_PLATFORM_ENV_KEYS.every((key) => projected[key] === base[key]),
	"all fixed platform values reach normal children",
);
record(
	CHILD_PI_ENV_KEYS.every((key) => projected[key] === base[key]),
	"all fixed Pi values reach normal children",
);
record(
	projected.RLM_FUTURE_CONTROL === "future-rlm"
		&& projected.YPI_FUTURE_CONTROL === "future-ypi",
	"future RLM/YPI variables follow the declared wildcard rule",
);
record(
	projected.CONTEXT === "/context" && projected.PI_TRACE_FILE === "/trace",
	"fixed runtime values reach normal children",
);
record(
	CHILD_RUNTIME_EXCLUDED_KEYS.every((key) => projected[key] === undefined)
		&& projected.UNLISTED_SECRET === undefined,
	"explicit exclusions and unlisted environment values stay out",
);
record(
	projected.AWS_ACCESS_KEY_ID === "access"
		&& projected.AWS_SECRET_ACCESS_KEY === "secret"
		&& projected.AWS_SESSION_TOKEN === "session",
	"normal projection preserves the Bedrock temporary credential triplet",
);
retainSelectedProviderEnvironment(projected, "amazon-bedrock");
record(
	projected.AWS_ACCESS_KEY_ID === "access"
		&& projected.AWS_SECRET_ACCESS_KEY === "secret"
		&& projected.AWS_SESSION_TOKEN === "session",
	"full isolation preserves the selected Bedrock temporary credential triplet",
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

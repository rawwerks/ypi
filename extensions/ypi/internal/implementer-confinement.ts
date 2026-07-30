import path from "node:path";
import {
	assertOwnedPrivateTree,
	assertPrivatePathIdentity,
	parsePrivatePathIdentityValue,
	readOwnedPrivateFile,
	type PrivatePathIdentity,
} from "./private-path.ts";

export const IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION = 1;

export interface ImplementerConfinementManifest {
	schemaVersion: typeof IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION;
	gitDir: string;
	leaseDirectoryIdentity: PrivatePathIdentity;
	resources: Record<string, PrivatePathIdentity>;
}

export interface VerifiedImplementerConfinement {
	auditFile: string;
	auditIdentity: PrivatePathIdentity;
	baselineIgnoreRoot: string;
	gitDir: string;
	scopeFile: string;
	scopeIdentity: PrivatePathIdentity;
	submodulePathsFile: string;
	submodulePathsIdentity: PrivatePathIdentity;
}

const REQUIRED_FILES = ["writes", "scope", "submodules"] as const;
const BASELINE_IGNORE_ROOT = "baseline-ignore";

function normalizeResourcePath(relativePath: string): string {
	if (
		relativePath === ""
		|| relativePath === "."
		|| path.isAbsolute(relativePath)
	) {
		throw new Error("implementer confinement resource path is invalid");
	}
	const normalized = path.normalize(relativePath);
	if (
		normalized !== relativePath
		|| normalized === ".."
		|| normalized.startsWith(`..${path.sep}`)
	) {
		throw new Error("implementer confinement resource path is invalid");
	}
	return normalized;
}

export function parseImplementerConfinementManifest(
	value: unknown,
): ImplementerConfinementManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("implementer confinement manifest is malformed");
	}
	const candidate = value as Partial<ImplementerConfinementManifest>;
	if (
		candidate.schemaVersion !== IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION
		|| typeof candidate.gitDir !== "string"
		|| !path.isAbsolute(candidate.gitDir)
		|| !candidate.resources
		|| typeof candidate.resources !== "object"
		|| Array.isArray(candidate.resources)
	) {
		throw new Error("implementer confinement manifest is malformed");
	}
	const resources: Record<string, PrivatePathIdentity> = {};
	for (const [relativePath, identityValue] of Object.entries(candidate.resources)) {
		const normalized = normalizeResourcePath(relativePath);
		if (
			!REQUIRED_FILES.includes(normalized as typeof REQUIRED_FILES[number])
			&& normalized !== BASELINE_IGNORE_ROOT
			&& !normalized.startsWith(`${BASELINE_IGNORE_ROOT}${path.sep}`)
		) {
			throw new Error("implementer confinement manifest declares an unexpected resource");
		}
		resources[normalized] = parsePrivatePathIdentityValue(identityValue);
	}
	for (const required of [...REQUIRED_FILES, BASELINE_IGNORE_ROOT]) {
		if (!resources[required]) {
			throw new Error(`implementer confinement manifest omits ${required}`);
		}
	}
	for (const required of REQUIRED_FILES) {
		if (resources[required].kind !== "file") {
			throw new Error(`implementer confinement resource ${required} is not a file`);
		}
	}
	if (resources[BASELINE_IGNORE_ROOT].kind !== "directory") {
		throw new Error("implementer confinement baseline-ignore root is not a directory");
	}
	return {
		schemaVersion: IMPLEMENTER_CONFINEMENT_SCHEMA_VERSION,
		gitDir: candidate.gitDir,
		leaseDirectoryIdentity: parsePrivatePathIdentityValue(
			candidate.leaseDirectoryIdentity,
		),
		resources,
	};
}

export function verifyImplementerConfinement(
	manifestFile: string,
	manifestIdentity: PrivatePathIdentity,
): VerifiedImplementerConfinement {
	if (path.basename(manifestFile) !== "confinement.json") {
		throw new Error("implementer confinement manifest path is invalid");
	}
	const leaseDirectory = path.dirname(manifestFile);
	const manifest = parseImplementerConfinementManifest(
		JSON.parse(readOwnedPrivateFile(manifestFile, manifestIdentity)),
	);
	assertPrivatePathIdentity(leaseDirectory, manifest.leaseDirectoryIdentity);
	for (const required of REQUIRED_FILES) {
		assertPrivatePathIdentity(
			path.join(leaseDirectory, required),
			manifest.resources[required],
		);
	}
	const baselineIgnoreRoot = path.join(leaseDirectory, BASELINE_IGNORE_ROOT);
	const baselineEntries = new Map<string, PrivatePathIdentity>();
	for (const [relativePath, identity] of Object.entries(manifest.resources)) {
		if (!relativePath.startsWith(`${BASELINE_IGNORE_ROOT}${path.sep}`)) continue;
		baselineEntries.set(relativePath.slice(BASELINE_IGNORE_ROOT.length + 1), identity);
	}
	assertOwnedPrivateTree({
		path: baselineIgnoreRoot,
		identity: manifest.resources[BASELINE_IGNORE_ROOT],
		entries: baselineEntries,
	});
	assertPrivatePathIdentity(leaseDirectory, manifest.leaseDirectoryIdentity);
	return {
		auditFile: path.join(leaseDirectory, "writes"),
		auditIdentity: manifest.resources.writes,
		baselineIgnoreRoot,
		gitDir: manifest.gitDir,
		scopeFile: path.join(leaseDirectory, "scope"),
		scopeIdentity: manifest.resources.scope,
		submodulePathsFile: path.join(leaseDirectory, "submodules"),
		submodulePathsIdentity: manifest.resources.submodules,
	};
}

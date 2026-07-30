import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export interface ImplementerRegistryPaths {
	root: string;
	leases: string;
	lock: string;
	retired: string;
	staging: string;
}

const REGISTRY_DIRECTORY_NAMES = ["leases", "retired", "staging"] as const;

function pathExistsWithoutFollowing(candidate: string): boolean {
	try {
		lstatSync(candidate);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function implementerRegistryPaths(commonGitDir: string): ImplementerRegistryPaths {
	const root = path.join(commonGitDir, "ypi-implementers");
	return {
		root,
		leases: path.join(root, "leases"),
		lock: path.join(commonGitDir, "ypi-implementers.lock"),
		retired: path.join(root, "retired"),
		staging: path.join(root, "staging"),
	};
}

export function implementerRegistryHasState(
	paths: ImplementerRegistryPaths,
): boolean {
	if (pathExistsWithoutFollowing(paths.lock)) return true;
	if (!pathExistsWithoutFollowing(paths.root)) return false;

	const rootMetadata = lstatSync(paths.root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return true;

	const knownNames = new Set<string>(REGISTRY_DIRECTORY_NAMES);
	for (const entry of readdirSync(paths.root, { withFileTypes: true })) {
		if (!knownNames.has(entry.name)) return true;
		const candidate = path.join(paths.root, entry.name);
		const metadata = lstatSync(candidate);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) return true;
		if (readdirSync(candidate).length > 0) return true;
	}
	return false;
}

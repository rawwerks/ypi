import path from "node:path";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function compareCodePoints(left: string, right: string): number {
	const leftPoints = [...left];
	const rightPoints = [...right];
	for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
		const difference = leftPoints[index].codePointAt(0)! - rightPoints[index].codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

function normalizeRepositoryRelativePath(value: string, label: string): string {
	if (!value || value.length > 1024 || CONTROL_CHARACTER.test(value) || value.includes("\\")) {
		throw new Error(`${label} must use bounded, non-empty repository-relative POSIX paths without control characters`);
	}
	if (path.posix.isAbsolute(value)) {
		throw new Error(`${label} must use repository-relative paths, not absolute paths`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`${label} must use repository-relative paths that stay within the repository`);
	}
	if (normalized.split("/").includes(".git")) {
		throw new Error(`${label} cannot include Git metadata`);
	}
	return normalized;
}

export function normalizeImplementScope(scope: readonly string[] | undefined): string[] {
	if (!Array.isArray(scope) || scope.length === 0) {
		throw new Error("Implement mode requires a non-empty scope of repository-relative path prefixes");
	}
	if (scope.length > 64) {
		throw new Error("Implement scope accepts at most 64 path prefixes");
	}
	const normalized = [...new Set(scope.map((entry) => {
		if (typeof entry !== "string") {
			throw new Error("Implement scope must contain only repository-relative path strings");
		}
		return normalizeRepositoryRelativePath(entry, "Implement scope");
	}))].sort(compareCodePoints);
	const reduced: string[] = [];
	for (const candidate of normalized) {
		if (reduced.some((owner) => pathIsWithinImplementScope(candidate, [owner]))) continue;
		reduced.push(candidate);
	}
	return reduced;
}

export function pathIsWithinImplementScope(relativePath: string, scope: readonly string[]): boolean {
	let candidate: string;
	try {
		candidate = normalizeRepositoryRelativePath(relativePath, "Implementer write path");
	} catch {
		return false;
	}
	return scope.some((owner) => owner === "."
		|| candidate === owner
		|| candidate.startsWith(`${owner}/`));
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
	const fold = (candidate: string) => candidate
		.normalize("NFKC")
		.toUpperCase()
		.toLowerCase()
		.normalize("NFKC");
	const foldedLeft = left.map(fold);
	const foldedRight = right.map(fold);
	return foldedLeft.some((candidate) => pathIsWithinImplementScope(candidate, foldedRight))
		|| foldedRight.some((candidate) => pathIsWithinImplementScope(candidate, foldedLeft));
}

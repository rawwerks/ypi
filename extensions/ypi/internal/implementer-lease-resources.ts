import { readdirSync } from "node:fs";
import path from "node:path";
import type { ImplementerLeaseRecord } from "./implementer-lease.ts";
import {
	assertPrivatePathIdentity,
	capturePrivatePathIdentity,
	retireOwnedPrivateTree,
	type OwnedPrivateTree,
	type PrivatePathIdentity,
} from "./private-path.ts";

function normalizeRelativePath(relativePath: string): string {
	if (
		relativePath === ""
		|| relativePath === "."
		|| relativePath === "lease.json"
		|| path.isAbsolute(relativePath)
	) {
		throw new Error(`invalid implementer lease resource path: ${relativePath}`);
	}
	const normalized = path.normalize(relativePath);
	if (
		normalized !== relativePath
		|| normalized === ".."
		|| normalized.startsWith(`..${path.sep}`)
	) {
		throw new Error(`invalid implementer lease resource path: ${relativePath}`);
	}
	return normalized;
}

function resourcePath(leaseDirectory: string, relativePath: string): string {
	return path.join(leaseDirectory, normalizeRelativePath(relativePath));
}

export function recordImplementerLeaseResource(
	record: ImplementerLeaseRecord,
	leaseDirectory: string,
	relativePath: string,
): PrivatePathIdentity {
	assertPrivatePathIdentity(leaseDirectory, record.leaseDirectoryIdentity);
	const normalized = normalizeRelativePath(relativePath);
	const identity = capturePrivatePathIdentity(resourcePath(leaseDirectory, normalized));
	record.leaseResources[normalized] = identity;
	assertPrivatePathIdentity(leaseDirectory, record.leaseDirectoryIdentity);
	return identity;
}

export function recordImplementerLeaseResourceTree(
	record: ImplementerLeaseRecord,
	leaseDirectory: string,
	relativeRoot: string,
): void {
	const normalizedRoot = normalizeRelativePath(relativeRoot);
	const rootPath = resourcePath(leaseDirectory, normalizedRoot);
	const visit = (candidate: string, relativePath: string): void => {
		const identity = recordImplementerLeaseResource(
			record,
			leaseDirectory,
			relativePath,
		);
		if (identity.kind !== "directory") return;
		for (const name of readdirSync(candidate).sort()) {
			visit(path.join(candidate, name), path.join(relativePath, name));
		}
	};
	visit(rootPath, normalizedRoot);
}

export function assertImplementerLeaseResource(
	record: ImplementerLeaseRecord,
	leaseDirectory: string,
	relativePath: string,
): PrivatePathIdentity {
	const normalized = normalizeRelativePath(relativePath);
	const expected = record.leaseResources[normalized];
	if (!expected) {
		throw new Error(`implementer lease resource is undeclared: ${normalized}`);
	}
	return assertPrivatePathIdentity(
		resourcePath(leaseDirectory, normalized),
		expected,
	);
}

export function implementerLeaseOwnedTree(
	record: ImplementerLeaseRecord,
	leaseDirectory: string,
): OwnedPrivateTree {
	assertPrivatePathIdentity(leaseDirectory, record.leaseDirectoryIdentity);
	const entries = new Map<string, PrivatePathIdentity>([
		["lease.json", record.leaseFileIdentity],
	]);
	for (const [relativePath, identity] of Object.entries(record.leaseResources)) {
		const normalized = normalizeRelativePath(relativePath);
		if (entries.has(normalized)) {
			throw new Error(`duplicate implementer lease resource: ${normalized}`);
		}
		entries.set(normalized, identity);
	}
	return {
		path: leaseDirectory,
		identity: record.leaseDirectoryIdentity,
		entries,
	};
}

export function retireImplementerLeaseOwnedTree(
	record: ImplementerLeaseRecord,
	leaseDirectory: string,
	options: { afterEligibilityInventory?: () => void } = {},
): void {
	retireOwnedPrivateTree(
		implementerLeaseOwnedTree(record, leaseDirectory),
		options,
	);
}

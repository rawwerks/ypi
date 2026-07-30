#!/usr/bin/env node

import {
	implementerRegistryHasState,
	implementerRegistryPaths,
} from "../extensions/ypi/internal/implementer-registry-layout.ts";

const commonGitDir = process.argv[2];
if (!commonGitDir || process.argv.length !== 3) {
	console.error("usage: inspect-implementer-registry.ts <common-git-dir>");
	process.exit(2);
}

const paths = implementerRegistryPaths(commonGitDir);
console.log(implementerRegistryHasState(paths) ? "present" : "absent");

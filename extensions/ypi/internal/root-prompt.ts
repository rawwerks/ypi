import { tmpdir } from "node:os";
import path from "node:path";
import { atomicCreateFile } from "./atomic-file.ts";
import {
	createOwnedPrivateTempDirectory,
	retireOwnedPrivateTree,
	sealOwnedPrivateDirectory,
	type OwnedPrivateDirectory,
	type OwnedPrivateTree,
	writeOwnedPrivateFile,
} from "./private-path.ts";

export interface RootPromptLease {
	capture(prompt: string): string | undefined;
	cleanup(): void;
}

export function createRootPromptLease(): RootPromptLease {
	let owner: OwnedPrivateDirectory | undefined;
	let tree: OwnedPrivateTree | undefined;
	let promptPath: string | undefined;
	return {
		capture(prompt: string) {
			if (process.env.RLM_DEPTH !== "0") return process.env.RLM_ROOT_PROMPT_FILE;
			if (!owner) {
				owner = createOwnedPrivateTempDirectory(
					path.join(process.env.TMPDIR || tmpdir(), "ypi_root_prompt_"),
				);
				promptPath = path.join(owner.path, "prompt.txt");
				atomicCreateFile(promptPath, prompt);
				tree = sealOwnedPrivateDirectory(owner, ["prompt.txt"]);
			} else {
				const promptIdentity = tree?.entries.get("prompt.txt");
				if (!promptPath || !promptIdentity) {
					throw new Error("Root prompt lease has no owned prompt identity");
				}
				writeOwnedPrivateFile(promptPath, promptIdentity, prompt);
			}
			process.env.RLM_ROOT_PROMPT_FILE = promptPath!;
			return promptPath;
		},
		cleanup() {
			if (promptPath && process.env.RLM_ROOT_PROMPT_FILE === promptPath) delete process.env.RLM_ROOT_PROMPT_FILE;
			if (tree) retireOwnedPrivateTree(tree);
			owner = undefined;
			tree = undefined;
			promptPath = undefined;
		},
	};
}

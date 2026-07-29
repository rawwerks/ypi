import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	atomicConditionalReplaceFile,
	atomicCopyFile,
	atomicCreateFile,
	atomicWriteFile,
	setAtomicFileLifecycleHookForTests,
} from "../extensions/ypi/internal/atomic-file.ts";

let pass = 0;
let fail = 0;
function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function expectThrow(label: string, action: () => unknown): void {
	try {
		action();
		record(false, label, "did not throw");
	} catch {
		record(true, label);
	}
}

function exactMode(candidate: string): number {
	return lstatSync(candidate).mode & 0o777;
}

console.log("\n=== Atomic file harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_atomic_file."));
try {
	for (const umask of [0o000, 0o777]) {
		const target = path.join(root, `mode-${umask.toString(8)}`);
		const previous = process.umask(umask);
		try {
			atomicCreateFile(target, "private\n");
		} finally {
			process.umask(previous);
		}
		record(
			exactMode(target) === 0o600 && readFileSync(target, "utf8") === "private\n",
			`no-clobber create enforces 0600 under umask ${umask.toString(8)}`,
		);
	}

	const occupied = path.join(root, "occupied");
	writeFileSync(occupied, "SUCCESSOR\n", { mode: 0o600 });
	chmodSync(occupied, 0o600);
	expectThrow("absent-target publication refuses an existing successor", () => (
		atomicCreateFile(occupied, "WRONG\n")
	));
	record(
		readFileSync(occupied, "utf8") === "SUCCESSOR\n",
		"existing successor remains byte-exact",
	);

	const injectedTarget = path.join(root, "injected-target");
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage === "before-publish" && event.target === injectedTarget) {
			writeFileSync(injectedTarget, "INTERVENING\n", { mode: 0o600 });
			chmodSync(injectedTarget, 0o600);
		}
	});
	expectThrow("creator paused before publication cannot replace an intervening target", () => (
		atomicCreateFile(injectedTarget, "CREATOR\n")
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		readFileSync(injectedTarget, "utf8") === "INTERVENING\n",
		"intervening target survives no-clobber publication",
	);

	const replacedTemporaryTarget = path.join(root, "temporary-replacement-target");
	const movedTemporary = path.join(root, "captured-original-temporary");
	let replacementTemporary = "";
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage !== "before-publish" || event.target !== replacedTemporaryTarget || !event.temporary) return;
		replacementTemporary = event.temporary;
		renameSync(event.temporary, movedTemporary);
		writeFileSync(event.temporary, "TEMP CANARY\n", { mode: 0o600 });
		chmodSync(event.temporary, 0o600);
	});
	expectThrow("temporary pathname replacement is detected before canonical publication", () => (
		atomicCreateFile(replacedTemporaryTarget, "ORIGINAL\n")
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		!existsSync(replacedTemporaryTarget)
			&& readFileSync(replacementTemporary, "utf8") === "TEMP CANARY\n"
			&& readFileSync(movedTemporary, "utf8") === "ORIGINAL\n",
		"replacement temporary and displaced original both survive uncertainty",
	);

	const externalLinkTarget = path.join(root, "external-link-target");
	const externalLink = path.join(root, "external-link-canary");
	let linkedTemporary = "";
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage !== "after-publish" || event.target !== externalLinkTarget || !event.temporary) return;
		linkedTemporary = event.temporary;
		linkSync(event.target, externalLink);
	});
	expectThrow("unrecognized external hard link removes publication cleanup authority", () => (
		atomicCreateFile(externalLinkTarget, "LINKED\n")
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		readFileSync(externalLinkTarget, "utf8") === "LINKED\n"
			&& readFileSync(externalLink, "utf8") === "LINKED\n"
			&& readFileSync(linkedTemporary, "utf8") === "LINKED\n"
			&& lstatSync(externalLink).nlink === 3,
		"all represented and external hard links are preserved",
	);

	const retireRaceTarget = path.join(root, "retire-race-target");
	const retireRaceOriginal = path.join(root, "retire-race-original");
	let retireRaceTemporary = "";
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage !== "before-temporary-retire" || event.target !== retireRaceTarget || !event.temporary) return;
		retireRaceTemporary = event.temporary;
		renameSync(event.temporary, retireRaceOriginal);
		writeFileSync(event.temporary, "LATE ONLY COPY\n", { mode: 0o600 });
		chmodSync(event.temporary, 0o600);
	});
	expectThrow("temporary replacement immediately before retirement is preserved", () => (
		atomicCreateFile(retireRaceTarget, "PUBLISHED\n")
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		readFileSync(retireRaceTarget, "utf8") === "PUBLISHED\n"
			&& readFileSync(retireRaceOriginal, "utf8") === "PUBLISHED\n"
			&& readFileSync(retireRaceTemporary, "utf8") === "LATE ONLY COPY\n",
		"late only-copy temporary canary survives the cleanup failure",
	);

	const replaceTarget = path.join(root, "replace-target");
	writeFileSync(replaceTarget, "OLD\n", { mode: 0o600 });
	chmodSync(replaceTarget, 0o600);
	const expected = atomicWriteFile(replaceTarget, "BASE\n", { expectedContent: "OLD\n" });
	const displaced = path.join(root, "replace-target.displaced");
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage !== "before-existing-commit" || event.target !== replaceTarget) return;
		renameSync(replaceTarget, displaced);
		writeFileSync(replaceTarget, "SUCCESSOR\n", { mode: 0o600 });
		chmodSync(replaceTarget, 0o600);
	});
	expectThrow("conditional replace refuses a pathname successor", () => (
		atomicConditionalReplaceFile(
			replaceTarget,
			expected,
			"NEW\n",
			{ expectedContent: "BASE\n" },
		)
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		readFileSync(replaceTarget, "utf8") === "SUCCESSOR\n"
			&& readFileSync(displaced, "utf8") === "BASE\n",
		"conditional replacement mutates neither successor nor displaced predecessor",
	);

	const exactGone = path.join(root, "exact-gone");
	writeFileSync(exactGone, "PRESENT\n", { mode: 0o600 });
	chmodSync(exactGone, 0o600);
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage === "before-existing-commit" && event.target === exactGone) unlinkSync(exactGone);
	});
	let exactGoneRejected = false;
	try { atomicWriteFile(exactGone, "RECREATED\n", { expectedContent: "PRESENT\n" }); } catch {
		exactGoneRejected = true;
	}
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		exactGoneRejected && !existsSync(exactGone),
		"exact-existing update never silently degrades to absent-target creation",
	);

	const normalReplace = path.join(root, "normal-replace");
	atomicCreateFile(normalReplace, "A\n");
	atomicWriteFile(normalReplace, "B\n", { expectedContent: "A\n" });
	record(
		readFileSync(normalReplace, "utf8") === "B\n",
		"exact-existing conditional update commits through the held inode",
	);

	const postCommitGone = path.join(root, "post-commit-gone");
	const postCommitDisplaced = path.join(root, "post-commit-gone.displaced");
	atomicCreateFile(postCommitGone, "OLD\n");
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage === "after-existing-commit" && event.target === postCommitGone) {
			renameSync(postCommitGone, postCommitDisplaced);
		}
	});
	expectThrow("post-commit disappearance is not reinterpreted as fresh creation", () => (
		atomicWriteFile(postCommitGone, "COMMITTED\n")
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		!existsSync(postCommitGone)
			&& readFileSync(postCommitDisplaced, "utf8") === "COMMITTED\n",
		"held-inode commit is reported as displaced without creating a successor pathname",
	);

	const copySource = path.join(root, "copy-source");
	const copyTarget = path.join(root, "copy-target");
	writeFileSync(copySource, "COPY BYTES\n", { mode: 0o600 });
	chmodSync(copySource, 0o600);
	atomicCopyFile(copySource, copyTarget);
	record(
		readFileSync(copyTarget, "utf8") === "COPY BYTES\n"
			&& exactMode(copyTarget) === 0o600,
		"copy uses the same private no-clobber publication",
	);

	const existingCopy = path.join(root, "copy-existing-regular");
	writeFileSync(existingCopy, "REGULAR ONLY COPY\n", { mode: 0o600 });
	chmodSync(existingCopy, 0o600);
	const existingCopyInode = lstatSync(existingCopy).ino;
	expectThrow("copy rejects a pre-existing regular file", () => (
		atomicCopyFile(copySource, existingCopy)
	));
	record(
		readFileSync(existingCopy, "utf8") === "REGULAR ONLY COPY\n"
			&& lstatSync(existingCopy).ino === existingCopyInode,
		"pre-existing regular copy destination remains byte- and inode-exact",
	);

	const copySymlinkTarget = path.join(root, "copy-symlink-target");
	const copySymlink = path.join(root, "copy-symlink");
	writeFileSync(copySymlinkTarget, "SYMLINK REFERENT\n", { mode: 0o600 });
	chmodSync(copySymlinkTarget, 0o600);
	symlinkSync(copySymlinkTarget, copySymlink);
	expectThrow("copy rejects a pre-existing symlink without unlinking it", () => (
		atomicCopyFile(copySource, copySymlink)
	));
	record(
		lstatSync(copySymlink).isSymbolicLink()
			&& readFileSync(copySymlinkTarget, "utf8") === "SYMLINK REFERENT\n",
		"copy preserves both symlink and referent",
	);

	const copyHardlink = path.join(root, "copy-hardlink");
	const copyHardlinkAlias = path.join(root, "copy-hardlink-alias");
	writeFileSync(copyHardlink, "HARD LINK ONLY COPY\n", { mode: 0o600 });
	chmodSync(copyHardlink, 0o600);
	linkSync(copyHardlink, copyHardlinkAlias);
	expectThrow("copy rejects a multiply linked destination", () => (
		atomicCopyFile(copySource, copyHardlink)
	));
	record(
		readFileSync(copyHardlink, "utf8") === "HARD LINK ONLY COPY\n"
			&& readFileSync(copyHardlinkAlias, "utf8") === "HARD LINK ONLY COPY\n"
			&& lstatSync(copyHardlink).nlink === 2,
		"copy preserves every hard-link alias and link count",
	);

	const copyDirectory = path.join(root, "copy-directory");
	const copyDirectoryCanary = path.join(copyDirectory, "only-copy");
	mkdirSync(copyDirectory);
	writeFileSync(copyDirectoryCanary, "DIRECTORY CANARY\n", { mode: 0o600 });
	expectThrow("copy rejects a pre-existing directory", () => (
		atomicCopyFile(copySource, copyDirectory)
	));
	record(
		lstatSync(copyDirectory).isDirectory()
			&& readFileSync(copyDirectoryCanary, "utf8") === "DIRECTORY CANARY\n",
		"copy preserves a destination directory and contained canary",
	);

	expectThrow("copy rejects expected-content replacement semantics", () => (
		atomicCopyFile(copySource, path.join(root, "copy-with-expected"), {
			expectedContent: "old",
		})
	));
	expectThrow("copy rejects truncate-before-write replacement semantics", () => (
		atomicCopyFile(copySource, path.join(root, "copy-with-truncate"), {
			truncateBeforeWrite: false,
		})
	));

	const copyBlocked = path.join(root, "copy-blocked");
	setAtomicFileLifecycleHookForTests((event) => {
		if (event.stage === "before-publish" && event.target === copyBlocked) {
			writeFileSync(copyBlocked, "COPY SUCCESSOR\n", { mode: 0o600 });
			chmodSync(copyBlocked, 0o600);
		}
	});
	expectThrow("copy cannot overwrite an absent-read successor", () => (
		atomicCopyFile(copySource, copyBlocked)
	));
	setAtomicFileLifecycleHookForTests(undefined);
	record(
		readFileSync(copyBlocked, "utf8") === "COPY SUCCESSOR\n",
		"copy successor remains byte-exact",
	);
} finally {
	setAtomicFileLifecycleHookForTests(undefined);
	rmSync(root, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

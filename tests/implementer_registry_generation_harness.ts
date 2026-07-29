import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { implementerLeaseRecordDigest } from "../extensions/ypi/internal/implementer-lease.ts";
import {
	readImplementerLeaseFile,
	writeImplementerLeaseFile,
} from "../extensions/ypi/internal/implementer-lease-file.ts";
import {
	recordImplementerLeaseResource,
	retireImplementerLeaseOwnedTree,
} from "../extensions/ypi/internal/implementer-lease-resources.ts";
import { implementerRegistryPaths } from "../extensions/ypi/internal/implementer-registry-layout.ts";
import {
	acquireRecoveryMutex,
	releaseRecoveryMutex,
	retireInterruptedLeaseArtifact,
	retireRecoveryLease,
	scanRetiredLeaseArtifacts,
} from "../extensions/ypi/internal/implementer-recovery/registry.ts";
import { recoverImplementerWorkspaces } from "../extensions/ypi/internal/implementer-recovery/service.ts";
import {
	implementerLeaseDirectory,
	readImplementerLeaseRecords,
	removeImplementerLeaseRecord,
	reserveImplementerLease,
	withImplementerRegistryLock,
	writeImplementerLeaseRecord,
} from "../extensions/ypi/internal/workspace-registry.ts";

let passed = 0;
let failed = 0;

function record(ok: boolean, label: string, detail = ""): void {
	if (ok) {
		passed++;
		console.log(`  PASS ${label}`);
	} else {
		failed++;
		console.error(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function privateDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
}

function journalCommit(payload: Buffer, revision: number): Buffer {
	const digest = createHash("sha256").update(payload).digest("hex");
	return Buffer.from(
		`commit\t${revision}\t${payload.length}\t${digest}\n`,
		"ascii",
	);
}

function appendCommittedPayload(
	recordPath: string,
	payload: Buffer,
	revision: number,
): void {
	appendFileSync(recordPath, payload);
	appendFileSync(recordPath, journalCommit(payload, revision));
}

console.log("\n=== Implementer registry generation harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_registry_generation."));

{
	const commonGitDir = path.join(root, "mutex-common");
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	const moved = path.join(root, "owned-mutex");
	const canary = path.join(paths.lock, "only-copy");
	let failure = "";
	try {
		withImplementerRegistryLock(commonGitDir, () => {
			renameSync(paths.lock, moved);
			privateDirectory(paths.lock);
			copyFileSync(path.join(moved, "owner.json"), path.join(paths.lock, "owner.json"));
			chmodSync(path.join(paths.lock, "owner.json"), 0o600);
			writeFileSync(canary, "preserve replacement\n", { mode: 0o600 });
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("identity changed")
			&& existsSync(moved)
			&& existsSync(canary)
			&& readFileSync(canary, "utf8") === "preserve replacement\n",
		"mutex release preserves a copied-token replacement and reports failure",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "mutex-owner-common");
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	const movedOwner = path.join(root, "owned-mutex-owner.json");
	let failure = "";
	try {
		withImplementerRegistryLock(commonGitDir, () => {
			renameSync(path.join(paths.lock, "owner.json"), movedOwner);
			copyFileSync(movedOwner, path.join(paths.lock, "owner.json"));
			chmodSync(path.join(paths.lock, "owner.json"), 0o600);
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("identity changed")
			&& existsSync(paths.lock)
			&& existsSync(movedOwner)
			&& existsSync(path.join(paths.lock, "owner.json")),
		"mutex release preserves an owner-file generation replacement and reports failure",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "mutex-content-common");
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	let failure = "";
	try {
		withImplementerRegistryLock(commonGitDir, () => {
			const ownerPath = path.join(paths.lock, "owner.json");
			const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token: string };
			owner.token = "f".repeat(32);
			writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("contents changed") && existsSync(paths.lock),
		"mutex release preserves an in-place owner mutation and reports failure",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "mutex-combined-common");
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	const movedOwner = path.join(root, "combined-owned-owner.json");
	let errors: unknown[] = [];
	try {
		withImplementerRegistryLock(commonGitDir, () => {
			renameSync(path.join(paths.lock, "owner.json"), movedOwner);
			copyFileSync(movedOwner, path.join(paths.lock, "owner.json"));
			chmodSync(path.join(paths.lock, "owner.json"), 0o600);
			throw new Error("synthetic primary registry action failure");
		});
	} catch (error) {
		if (error instanceof AggregateError) errors = [...error.errors];
	}
	const messages = errors.map((error) => error instanceof Error ? error.message : String(error));
	record(
		messages.some((message) => message.includes("synthetic primary"))
			&& messages.some((message) => message.includes("identity changed"))
			&& existsSync(paths.lock)
			&& existsSync(movedOwner),
		"registry action and release failures are both caller-visible",
		messages.join(" | "),
	);
}

{
	const commonGitDir = path.join(root, "lease-common");
	privateDirectory(commonGitDir);
	const recordValue = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"a".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, recordValue.token);
	const moved = path.join(root, "owned-lease");
	const canary = path.join(active, "only-copy");
	renameSync(active, moved);
	privateDirectory(active);
	copyFileSync(path.join(moved, "lease.json"), path.join(active, "lease.json"));
	chmodSync(path.join(active, "lease.json"), 0o600);
	writeFileSync(canary, "preserve replacement\n", { mode: 0o600 });
	let failure = "";
	try {
		removeImplementerLeaseRecord(commonGitDir, recordValue.token);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("identity changed")
			&& existsSync(moved)
			&& existsSync(canary)
			&& readFileSync(canary, "utf8") === "preserve replacement\n",
		"lease retirement rejects a copied-record replacement without deleting either generation",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "normal-common");
	privateDirectory(commonGitDir);
	const recordValue = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"b".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, recordValue.token);
	record(
		existsSync(active)
			&& recordValue.leaseDirectoryIdentity.kind === "directory",
		"published lease carries its exact no-clobber directory generation",
	);
	removeImplementerLeaseRecord(commonGitDir, recordValue.token);
	record(!existsSync(active), "normal exact lease generation retires");
}

{
	const commonGitDir = path.join(root, "undeclared-resource-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"2".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	writeFileSync(path.join(active, "only-copy"), "preserve undeclared\n", { mode: 0o600 });
	let failure = "";
	try {
		removeImplementerLeaseRecord(commonGitDir, lease.token);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const retiredRoot = implementerRegistryPaths(commonGitDir).retired;
	const retired = path.join(retiredRoot, readdirSync(retiredRoot)[0]);
	record(
		failure.includes("gained or lost entries")
			&& existsSync(path.join(retired, "only-copy"))
			&& readFileSync(path.join(retired, "only-copy"), "utf8") === "preserve undeclared\n",
		"lease retirement preserves an undeclared only-copy resource",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "replaced-resource-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"3".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const owned = path.join(active, "owned");
	const moved = path.join(root, "moved-owned-resource");
	writeFileSync(owned, "owned generation\n", { mode: 0o600 });
	recordImplementerLeaseResource(lease, active, "owned");
	withImplementerRegistryLock(commonGitDir, () => writeImplementerLeaseRecord(lease));
	renameSync(owned, moved);
	writeFileSync(owned, "successor only copy\n", { mode: 0o600 });
	let failure = "";
	try {
		removeImplementerLeaseRecord(commonGitDir, lease.token);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const retiredRoot = implementerRegistryPaths(commonGitDir).retired;
	const retired = path.join(retiredRoot, readdirSync(retiredRoot)[0]);
	record(
		failure.includes("entry changed")
			&& existsSync(moved)
			&& readFileSync(moved, "utf8") === "owned generation\n"
			&& existsSync(path.join(retired, "owned"))
			&& readFileSync(path.join(retired, "owned"), "utf8") === "successor only copy\n",
		"lease retirement preserves both generations of a replaced declared resource",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "post-inventory-resource-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"4".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	let failure = "";
	try {
		retireImplementerLeaseOwnedTree(lease, active, {
			afterEligibilityInventory() {
				writeFileSync(path.join(active, "late-only-copy"), "preserve late\n", { mode: 0o600 });
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.length > 0
			&& existsSync(path.join(active, "lease.json"))
			&& existsSync(path.join(active, "late-only-copy"))
			&& readFileSync(path.join(active, "late-only-copy"), "utf8") === "preserve late\n",
		"post-eligibility injection preserves the complete lease authority",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "stable-record-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"d".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	const before = statSync(recordPath);
	lease.childPid = 4242;
	writeImplementerLeaseRecord(lease);
	const after = statSync(recordPath);
	const reread = readImplementerLeaseRecords(commonGitDir);
	record(
		before.dev === after.dev
			&& before.ino === after.ino
			&& reread.length === 1
			&& reread[0].childPid === 4242
			&& reread[0].leaseFileIdentity.inode === String(after.ino),
		"lease state updates retain one self-identified record inode",
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "record-replacement-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"e".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	const movedRecord = path.join(root, "owned-lease-record.json");
	renameSync(recordPath, movedRecord);
	copyFileSync(movedRecord, recordPath);
	chmodSync(recordPath, 0o600);
	let failure = "";
	try {
		removeImplementerLeaseRecord(commonGitDir, lease.token);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("record identity changed")
			&& existsSync(active)
			&& existsSync(recordPath)
			&& existsSync(movedRecord),
		"lease retirement preserves a copied record replacement in the same directory",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "torn-record-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"f".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	appendFileSync(recordPath, "{\"schemaVersion\":");
	const recovered = readImplementerLeaseRecords(commonGitDir);
	lease.childPid = 4444;
	writeImplementerLeaseRecord(lease);
	const advanced = readImplementerLeaseRecords(commonGitDir);
	const journal = readFileSync(recordPath, "utf8");
	record(
		recovered.length === 1
			&& recovered[0].revision === 0
			&& recovered[0].childPid === undefined
			&& advanced.length === 1
			&& advanced[0].revision === 1
			&& advanced[0].childPid === 4444
			&& journal.endsWith("\n")
			&& journal.trimEnd().split("\n").length === 4,
		"an unterminated crash tail recovers and is trimmed before the next revision",
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "multibyte-tail-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"5".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	appendFileSync(recordPath, Buffer.from([0xc3]));
	const recovered = readImplementerLeaseFile(active, lease.token, commonGitDir);
	lease.childPid = 4949;
	writeImplementerLeaseFile(active, lease);
	const advanced = readImplementerLeaseFile(active, lease.token, commonGitDir);
	const bytes = readFileSync(recordPath);
	record(
		recovered.revision === 0
			&& advanced.revision === 1
			&& advanced.childPid === 4949
			&& bytes.filter((byte) => byte === 0x0a).length === 4
			&& !bytes.includes(0xc3),
		"an incomplete multibyte tail is trimmed by exact byte offset",
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "partial-first-frame-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"0".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	writeFileSync(path.join(active, "lease.json"), "{\"schemaVersion\":", { mode: 0o600 });
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("no complete committed revision") && existsSync(active),
		"a partial first journal payload fails closed before writer work exists",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "uncommitted-first-payload-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"1".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	const journal = readFileSync(recordPath);
	const payloadEnd = journal.indexOf(0x0a) + 1;
	writeFileSync(recordPath, journal.subarray(0, payloadEnd), { mode: 0o600 });
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		payloadEnd > 0
			&& failure.includes("no complete committed revision")
			&& existsSync(active),
		"an fsynced first payload without its commit is not accepted as authority",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "complete-invalid-utf8-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"4".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const invalidPayload = Buffer.from([0xff, 0x0a]);
	appendCommittedPayload(
		path.join(active, "lease.json"),
		invalidPayload,
		1,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("invalid UTF-8") && existsSync(active),
		"a committed invalid-UTF8 payload fails closed and remains evidence",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "trim-interruption-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"9".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	appendFileSync(recordPath, "{\"partial\":");
	lease.childPid = 4545;
	let failure = "";
	try {
		writeImplementerLeaseFile(active, lease, {
			afterTailTrim() {
				throw new Error("synthetic stop after journal-tail trim");
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const afterTrim = readImplementerLeaseFile(active, lease.token, commonGitDir);
	writeImplementerLeaseFile(active, lease);
	const afterRetry = readImplementerLeaseFile(active, lease.token, commonGitDir);
	record(
		failure.includes("synthetic stop")
			&& afterTrim.revision === 0
			&& afterTrim.childPid === undefined
			&& afterRetry.revision === 1
			&& afterRetry.childPid === 4545,
		"interruption after crash-tail trim retains the prior revision and permits retry",
		failure,
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "payload-sync-interruption-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"3".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	lease.childPid = 4546;
	let failure = "";
	try {
		writeImplementerLeaseFile(active, lease, {
			afterPayloadSync() {
				throw new Error("synthetic stop after journal-payload sync");
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const afterPayload = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	writeImplementerLeaseFile(active, lease);
	const afterRetry = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	record(
		failure.includes("synthetic stop")
			&& afterPayload.revision === 0
			&& afterPayload.childPid === undefined
			&& lease.revision === 1
			&& afterRetry.revision === 1
			&& afterRetry.childPid === 4546,
		"an fsynced payload without a commit retains the prior revision and permits retry",
		failure,
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "partial-commit-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"2".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	const next = {
		...readImplementerLeaseFile(active, lease.token, commonGitDir),
		revision: 1,
		childPid: 4547,
		recordDigest: "",
	};
	next.recordDigest = implementerLeaseRecordDigest(next);
	const payload = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
	appendFileSync(recordPath, payload);
	const commit = journalCommit(payload, 1);
	appendFileSync(recordPath, commit.subarray(0, commit.length - 1));
	const afterPartialCommit = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	lease.childPid = 4548;
	writeImplementerLeaseFile(active, lease);
	const afterRetry = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	record(
		afterPartialCommit.revision === 0
			&& afterPartialCommit.childPid === undefined
			&& afterRetry.revision === 1
			&& afterRetry.childPid === 4548,
		"a partial commit leaves its payload uncommitted and both are trimmed on retry",
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "uncommitted-malformed-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"b".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	appendFileSync(path.join(active, "lease.json"), "{\"not\":\"a lease\"}\n");
	const beforeRetry = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	lease.childPid = 4549;
	writeImplementerLeaseFile(active, lease);
	const afterRetry = readImplementerLeaseFile(
		active,
		lease.token,
		commonGitDir,
	);
	record(
		beforeRetry.revision === 0
			&& beforeRetry.childPid === undefined
			&& afterRetry.revision === 1
			&& afterRetry.childPid === 4549,
		"a complete malformed payload without a commit is ignored and trimmed on retry",
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "append-uncertainty-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"8".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	lease.childPid = 4747;
	let appendFailure = "";
	try {
		writeImplementerLeaseFile(active, lease, {
			afterCommitWrite() {
				throw new Error("synthetic stop after complete journal-commit write");
			},
		});
	} catch (error) {
		appendFailure = error instanceof Error ? error.message : String(error);
	}
	const persisted = readImplementerLeaseFile(active, lease.token, commonGitDir);
	let staleFailure = "";
	try {
		writeImplementerLeaseFile(active, lease);
	} catch (error) {
		staleFailure = error instanceof Error ? error.message : String(error);
	}
	record(
		appendFailure.includes("synthetic stop")
			&& persisted.revision === 1
			&& persisted.childPid === 4747
			&& lease.revision === 0
			&& staleFailure.includes("record contents changed"),
		"a complete but uncertain commit is recoverable and rejects stale replay",
		`${appendFailure} | ${staleFailure}`,
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "complete-malformed-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"a".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const malformedPayload = Buffer.from("{\"not\":\"a lease\"}\n", "utf8");
	appendCommittedPayload(
		path.join(active, "lease.json"),
		malformedPayload,
		1,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.length > 0 && existsSync(active),
		"a committed malformed payload fails closed and remains evidence",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "revision-gap-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"7".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const skipped = {
		...readImplementerLeaseFile(active, lease.token, commonGitDir),
		revision: 2,
		childPid: 4848,
		recordDigest: "",
	};
	skipped.recordDigest = implementerLeaseRecordDigest(skipped);
	const skippedPayload = Buffer.from(`${JSON.stringify(skipped)}\n`, "utf8");
	appendCommittedPayload(
		path.join(active, "lease.json"),
		skippedPayload,
		skipped.revision,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("non-contiguous committed revision") && existsSync(active),
		"a committed journal revision gap fails closed and remains evidence",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "commit-length-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"c".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const next = {
		...readImplementerLeaseFile(active, lease.token, commonGitDir),
		revision: 1,
		childPid: 4850,
		recordDigest: "",
	};
	next.recordDigest = implementerLeaseRecordDigest(next);
	const payload = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
	appendFileSync(path.join(active, "lease.json"), payload);
	const digest = createHash("sha256").update(payload).digest("hex");
	appendFileSync(
		path.join(active, "lease.json"),
		`commit\t1\t${payload.length + 1}\t${digest}\n`,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("invalid complete commit length") && existsSync(active),
		"a complete commit with the wrong payload length fails closed",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "commit-digest-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"d".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const next = {
		...readImplementerLeaseFile(active, lease.token, commonGitDir),
		revision: 1,
		childPid: 4851,
		recordDigest: "",
	};
	next.recordDigest = implementerLeaseRecordDigest(next);
	const payload = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
	appendFileSync(path.join(active, "lease.json"), payload);
	appendFileSync(
		path.join(active, "lease.json"),
		`commit\t1\t${payload.length}\t${"0".repeat(64)}\n`,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("complete commit digest mismatch") && existsSync(active),
		"a complete commit with the wrong payload digest fails closed",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "malformed-commit-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"e".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const next = {
		...readImplementerLeaseFile(active, lease.token, commonGitDir),
		revision: 1,
		childPid: 4852,
		recordDigest: "",
	};
	next.recordDigest = implementerLeaseRecordDigest(next);
	appendFileSync(
		path.join(active, "lease.json"),
		Buffer.from(`${JSON.stringify(next)}\n`, "utf8"),
	);
	appendFileSync(path.join(active, "lease.json"), "commit\tcorrupt\n");
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("malformed complete commit") && existsSync(active),
		"a malformed complete commit fails closed instead of hiding as a crash tail",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "orphan-commit-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"f".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	appendFileSync(
		path.join(active, "lease.json"),
		`commit\t1\t0\t${"0".repeat(64)}\n`,
	);
	let failure = "";
	try {
		readImplementerLeaseRecords(commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.includes("orphan complete commit") && existsSync(active),
		"an orphan complete commit fails closed and remains evidence",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "competing-record-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"1".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const competing = readImplementerLeaseFile(active, lease.token, commonGitDir);
	competing.childPid = 4646;
	writeImplementerLeaseFile(active, competing);
	lease.childPid = 4343;
	let failure = "";
	try {
		writeImplementerLeaseRecord(lease);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const preserved = readImplementerLeaseFile(active, lease.token, commonGitDir);
	record(
		failure.includes("record contents changed")
			&& preserved.childPid === 4646
			&& existsSync(active),
		"a competing complete journal revision is preserved and rejects stale overwrite",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "immutable-record-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"6".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(commonGitDir, lease.token);
	const recordPath = path.join(active, "lease.json");
	const before = readFileSync(recordPath, "utf8");
	lease.scope = ["other"];
	let failure = "";
	try {
		writeImplementerLeaseFile(active, lease);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const persisted = readImplementerLeaseFile(active, lease.token, commonGitDir);
	record(
		failure.includes("changed immutable state")
			&& readFileSync(recordPath, "utf8") === before
			&& persisted.scope.join("\0") === "src",
		"immutable state drift is rejected before journal append",
		failure,
	);
	removeImplementerLeaseRecord(commonGitDir, lease.token);
}

{
	const commonGitDir = path.join(root, "recovery-common");
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	const mutexToken = acquireRecoveryMutex(paths.lock);
	const movedMutex = path.join(root, "owned-recovery-mutex");
	const mutexCanary = path.join(paths.lock, "only-copy");
	renameSync(paths.lock, movedMutex);
	privateDirectory(paths.lock);
	copyFileSync(
		path.join(movedMutex, "owner.json"),
		path.join(paths.lock, "owner.json"),
	);
	chmodSync(path.join(paths.lock, "owner.json"), 0o600);
	writeFileSync(mutexCanary, "preserve recovery mutex\n", { mode: 0o600 });
	let mutexFailure = "";
	try {
		releaseRecoveryMutex(paths.lock, mutexToken);
	} catch (error) {
		mutexFailure = error instanceof Error ? error.message : String(error);
	}
	record(
		mutexFailure.includes("identity changed")
			&& existsSync(movedMutex)
			&& readFileSync(mutexCanary, "utf8") === "preserve recovery mutex\n",
		"recovery mutex release shares the generation-bound replacement refusal",
		mutexFailure,
	);

	const tokenMismatchCommonGitDir = path.join(root, "recovery-token-common");
	privateDirectory(tokenMismatchCommonGitDir);
	const tokenMismatchPath = implementerRegistryPaths(tokenMismatchCommonGitDir).lock;
	const expectedToken = acquireRecoveryMutex(tokenMismatchPath);
	let tokenMismatchFailure = "";
	try {
		releaseRecoveryMutex(tokenMismatchPath, "0".repeat(32));
	} catch (error) {
		tokenMismatchFailure = error instanceof Error ? error.message : String(error);
	}
	record(
		tokenMismatchFailure.includes("token changed") && existsSync(tokenMismatchPath),
		"recovery mutex token mismatch is preserved and reported",
		tokenMismatchFailure,
	);
	releaseRecoveryMutex(tokenMismatchPath, expectedToken);

	const leaseCommonGitDir = path.join(root, "recovery-lease-common");
	privateDirectory(leaseCommonGitDir);
	const recordValue = reserveImplementerLease(
		leaseCommonGitDir,
		path.join(root, "checkout"),
		"c".repeat(40),
		["src"],
	);
	const active = implementerLeaseDirectory(leaseCommonGitDir, recordValue.token);
	const movedLease = path.join(root, "owned-recovery-lease");
	const leaseCanary = path.join(active, "only-copy");
	renameSync(active, movedLease);
	privateDirectory(active);
	copyFileSync(path.join(movedLease, "lease.json"), path.join(active, "lease.json"));
	chmodSync(path.join(active, "lease.json"), 0o600);
	writeFileSync(leaseCanary, "preserve recovery lease\n", { mode: 0o600 });
	let leaseFailure = "";
	try {
		retireRecoveryLease(active, recordValue.token);
	} catch (error) {
		leaseFailure = error instanceof Error ? error.message : String(error);
	}
	record(
		leaseFailure.includes("identity changed")
			&& existsSync(movedLease)
			&& readFileSync(leaseCanary, "utf8") === "preserve recovery lease\n",
		"recovery lease retirement shares the generation-bound replacement refusal",
		leaseFailure,
	);
}

{
	const commonGitDir = path.join(root, "retired-exact-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"5".repeat(40),
		["src"],
	);
	const paths = implementerRegistryPaths(commonGitDir);
	privateDirectory(paths.retired);
	const retired = path.join(
		paths.retired,
		`.lease-${lease.token}-${process.pid}-11111111.done`,
	);
	renameSync(implementerLeaseDirectory(commonGitDir, lease.token), retired);
	const scan = scanRetiredLeaseArtifacts(
		paths.retired,
		commonGitDir,
		Number.MAX_SAFE_INTEGER,
		() => false,
	);
	let failure = "";
	try {
		retireInterruptedLeaseArtifact(scan.stale[0], commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		scan.stale.length === 1
			&& scan.invalid.length === 0
			&& failure === ""
			&& !existsSync(retired),
		"interrupted schema-3 retirement consumes only its declared resource inventory",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "retired-replacement-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"6".repeat(40),
		["src"],
	);
	const paths = implementerRegistryPaths(commonGitDir);
	privateDirectory(paths.retired);
	const retired = path.join(
		paths.retired,
		`.lease-${lease.token}-${process.pid}-22222222.done`,
	);
	renameSync(implementerLeaseDirectory(commonGitDir, lease.token), retired);
	const scan = scanRetiredLeaseArtifacts(
		paths.retired,
		commonGitDir,
		Number.MAX_SAFE_INTEGER,
		() => false,
	);
	const moved = path.join(root, "owned-retired-generation");
	renameSync(retired, moved);
	privateDirectory(retired);
	copyFileSync(path.join(moved, "lease.json"), path.join(retired, "lease.json"));
	chmodSync(path.join(retired, "lease.json"), 0o600);
	writeFileSync(path.join(retired, "only-copy"), "preserve replacement\n", { mode: 0o600 });
	let failure = "";
	try {
		retireInterruptedLeaseArtifact(scan.stale[0], commonGitDir);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.length > 0
			&& existsSync(moved)
			&& existsSync(path.join(retired, "only-copy"))
			&& readFileSync(path.join(retired, "only-copy"), "utf8") === "preserve replacement\n",
		"retired-artifact replacement after recovery scan preserves both generations",
		failure,
	);
}

{
	const commonGitDir = path.join(root, "retired-injection-common");
	privateDirectory(commonGitDir);
	const lease = reserveImplementerLease(
		commonGitDir,
		path.join(root, "checkout"),
		"7".repeat(40),
		["src"],
	);
	const paths = implementerRegistryPaths(commonGitDir);
	privateDirectory(paths.retired);
	const retired = path.join(
		paths.retired,
		`.lease-${lease.token}-${process.pid}-33333333.done`,
	);
	renameSync(implementerLeaseDirectory(commonGitDir, lease.token), retired);
	const scan = scanRetiredLeaseArtifacts(
		paths.retired,
		commonGitDir,
		Number.MAX_SAFE_INTEGER,
		() => false,
	);
	let failure = "";
	try {
		retireInterruptedLeaseArtifact(scan.stale[0], commonGitDir, {
			afterEligibilityInventory() {
				writeFileSync(path.join(retired, "late-only-copy"), "preserve late\n", { mode: 0o600 });
			},
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		failure.length > 0
			&& existsSync(path.join(retired, "lease.json"))
			&& existsSync(path.join(retired, "late-only-copy"))
			&& readFileSync(path.join(retired, "late-only-copy"), "utf8") === "preserve late\n",
		"post-scan retired-artifact injection preserves the complete authority",
		failure,
	);
}

{
	const checkout = path.join(root, "mutex-aba-checkout");
	const commonGitDir = path.join(root, "mutex-aba-common");
	privateDirectory(checkout);
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	const staleToken = acquireRecoveryMutex(paths.lock, 1);
	const displaced = path.join(root, "mutex-aba-stale");
	let successorToken = "";
	let failure = "";
	try {
		recoverImplementerWorkspaces(
			{ repo: checkout, ageMinutes: 0, force: true },
			{
				git: {
					run() {
						throw new Error("unexpected Git operation");
					},
					text() {
						throw new Error("unexpected Git operation");
					},
					optionalText(_cwd, args) {
						return args.includes("--show-toplevel") ? checkout : commonGitDir;
					},
				},
				nowEpochSeconds: () => 2_000_000_000,
				processAlive: () => false,
				beforeStaleMutexRetirement() {
					renameSync(paths.lock, displaced);
					successorToken = acquireRecoveryMutex(paths.lock, 1);
				},
			},
		);
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	record(
		staleToken !== successorToken
			&& failure.includes("identity changed")
			&& existsSync(displaced)
			&& existsSync(paths.lock),
		"stale recovery classification cannot retire a successor mutex generation",
		failure,
	);
	releaseRecoveryMutex(paths.lock, successorToken);
}

{
	const checkout = path.join(root, "legacy-staged-checkout");
	const commonGitDir = path.join(root, "legacy-staged-common");
	privateDirectory(checkout);
	privateDirectory(commonGitDir);
	const paths = implementerRegistryPaths(commonGitDir);
	for (const directory of [paths.root, paths.leases, paths.staging, paths.retired]) {
		privateDirectory(directory);
	}
	const staged = path.join(
		paths.staging,
		`.lease-${"8".repeat(32)}-${process.pid}-44444444.tmp`,
	);
	privateDirectory(staged);
	writeFileSync(path.join(staged, "only-copy"), "preserve legacy staged\n", { mode: 0o600 });
	const report = recoverImplementerWorkspaces(
		{ repo: checkout, ageMinutes: 0, force: true },
		{
			git: {
				run() {
					throw new Error("unexpected Git operation");
				},
				text() {
					throw new Error("unexpected Git operation");
				},
				optionalText(_cwd, args) {
					return args.includes("--show-toplevel") ? checkout : commonGitDir;
				},
			},
			nowEpochSeconds: () => 2_000_000_000,
			processAlive: () => false,
		},
	);
	record(
		report.exitCode === 1
			&& existsSync(path.join(staged, "only-copy"))
			&& report.stdout.some((line) => line.includes("no authoritative resource inventory")),
		"force preserves pre-schema staged artifacts without a complete inventory",
		[...report.stdout, ...report.stderr].join(" | "),
	);
}

{
	const checkout = path.join(root, "incomplete-lock-checkout");
	const commonGitDir = path.join(root, "incomplete-lock-common");
	privateDirectory(checkout);
	privateDirectory(commonGitDir);
	const lockPath = implementerRegistryPaths(commonGitDir).lock;
	privateDirectory(lockPath);
	const report = recoverImplementerWorkspaces(
		{ repo: checkout, ageMinutes: 1_000_000, force: true },
		{
			git: {
				run() {
					throw new Error("unexpected Git operation");
				},
				text() {
					throw new Error("unexpected Git operation");
				},
				optionalText(_cwd, args) {
					return args.includes("--show-toplevel") ? checkout : commonGitDir;
				},
			},
			nowEpochSeconds: () => 2_000_000_000,
			processAlive: () => false,
		},
	);
	record(
		report.exitCode === 0
			&& existsSync(lockPath)
			&& report.stdout.some((line) => line.includes("preserved incomplete or replaced")),
		"age and force never authorize deletion of an incomplete mutex claim",
		report.stdout.join(" | "),
	);
}

rmSync(root, { recursive: true, force: true });
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

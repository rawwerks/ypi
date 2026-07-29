import { spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireChildResources } from "../extensions/ypi/internal/child-resources.ts";
import {
	closeTranscriptProof,
	finalizeTranscriptProof,
	prepareTranscriptProof,
	verifyTranscriptReceipt,
	type TranscriptProofLease,
} from "../extensions/ypi/internal/transcript.ts";
import { validateJsonlRegion } from "../extensions/ypi/internal/transcript-proof-io.ts";

const sessionEvent = `${JSON.stringify({
	type: "session",
	version: 3,
	id: "test-session",
	timestamp: "2026-07-28T00:00:00.000Z",
	cwd: "/test",
})}\n`;
const messageEvent = `${JSON.stringify({
	type: "message",
	id: "message-1",
	parentId: null,
	timestamp: "2026-07-28T00:00:01.000Z",
	message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
})}\n`;

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

function expectThrow(label: string, expected: string, action: () => unknown): void {
	try {
		action();
		record(false, label, "did not throw");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		record(message.includes(expected), label, message);
	}
}

function sessionDirectory(root: string, name: string): string {
	const directory = path.join(root, name);
	mkdirSync(directory, { mode: 0o700 });
	chmodSync(directory, 0o700);
	return directory;
}

function childPath(directory: string, name: string): string {
	return path.join(directory, `${name}.jsonl`);
}

function closeQuietly(lease: TranscriptProofLease | undefined): void {
	try {
		closeTranscriptProof(lease);
	} catch {
		// A failed assertion should remain the reported failure.
	}
}

const root = mkdtempSync(path.join(tmpdir(), "ypi_transcript_test."));
chmodSync(root, 0o700);
process.env.RLM_REQUIRE_TRANSCRIPTS = "1";

console.log("\n=== Required transcript proof harness ===");
try {
	{
		const directory = sessionDirectory(root, "positive");
		const transcript = childPath(directory, "positive_d1_c1");
		const originalUmask = process.umask(0o777);
		let lease: TranscriptProofLease | undefined;
		try {
			lease = prepareTranscriptProof({ childSession: transcript });
		} finally {
			process.umask(originalUmask);
		}
		if (!lease) throw new Error("required proof did not return a lease");
		try {
			writeFileSync(transcript, `${sessionEvent}${messageEvent}`, { flag: "a" });
			const receipt = finalizeTranscriptProof(lease, {
				traceId: "positive",
				parentDepth: 0,
				childDepth: 1,
				callCount: 1,
				childExitCode: 0,
			});
			const metadata = lstatSync(transcript);
			record(
				(metadata.mode & 0o777) === 0o600 && metadata.nlink === 1,
				"precreated transcript remains private and singly linked under umask 0777",
			);
			record(
				receipt?.message_events_appended === 1,
				"final proof records an appended Pi message event",
			);
			const verified = verifyTranscriptReceipt(
				directory,
				path.basename(transcript),
			);
			record(
				verified.final_sha256 === receipt?.final_sha256,
				"offline verification recomputes the runtime transcript receipt",
			);

			const trace = path.join(root, "positive-trace.log");
			writeFileSync(
				trace,
					[
						"[2026-07-28 00:00:00] depth=0→1 PID=1 call=1 trace=positive caller=tool mode=review",
						"[2026-07-28T00:00:01.000Z] depth=0 child_depth=1 COMPLETED exit=0 elapsed=1s caller=tool call=1 trace=positive transcript=verified",
						"[2026-07-28T00:00:02.000Z] depth=0 child_depth=1 LIFECYCLE_TERMINAL exit=0 call=1 trace=positive transcript=verified cleanup=verified",
						"",
				].join("\n"),
				{ mode: 0o600 },
			);
			const validation = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					path.join(import.meta.dir, "..", "scripts", "validate-recursion-transcripts.ts"),
					"--trace",
					trace,
					"--session-dir",
					directory,
				],
				{ encoding: "utf8" },
			);
			record(
					validation.status === 0
						&& validation.stdout.includes("TRANSCRIPT_VALIDATION=PASS calls=1"),
					"trace validator requires matching completion, lifecycle, and receipt evidence",
					validation.stderr || validation.stdout,
				);

				writeFileSync(
					trace,
					[
						"[2026-07-28 00:00:00] depth=0→1 PID=1 call=1 trace=positive caller=tool mode=review",
						"[2026-07-28T00:00:01.000Z] depth=0 child_depth=1 COMPLETED exit=0 elapsed=1s caller=tool call=1 trace=positive transcript=verified",
						"",
					].join("\n"),
					{ mode: 0o600 },
				);
				const missingLifecycle = spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						path.join(import.meta.dir, "..", "scripts", "validate-recursion-transcripts.ts"),
						"--trace",
						trace,
						"--session-dir",
						directory,
					],
					{ encoding: "utf8" },
				);
				record(
					missingLifecycle.status !== 0
						&& missingLifecycle.stderr.includes("no verified lifecycle terminal"),
					"a completion and receipt cannot prove post-cleanup terminality",
					missingLifecycle.stderr || missingLifecycle.stdout,
				);

				writeFileSync(
					trace,
					[
						"[2026-07-28 00:00:00] depth=0→1 PID=1 call=1 trace=positive caller=tool mode=review",
						"[2026-07-28T00:00:01.000Z] depth=0 child_depth=1 COMPLETED exit=0 elapsed=1s caller=tool call=1 trace=positive transcript=verified",
						"[2026-07-28T00:00:02.000Z] depth=0 child_depth=1 CLEANUP_FAILED call=1 errors=1 detail=injected",
						"",
					].join("\n"),
					{ mode: 0o600 },
				);
				const cleanupFailure = spawnSync(
					process.execPath,
					[
						"--experimental-strip-types",
						path.join(import.meta.dir, "..", "scripts", "validate-recursion-transcripts.ts"),
						"--trace",
						trace,
						"--session-dir",
						directory,
					],
					{ encoding: "utf8" },
				);
				record(
					cleanupFailure.status !== 0
						&& cleanupFailure.stderr.includes("lifecycle cleanup failure"),
					"an explicit cleanup failure invalidates otherwise complete transcript evidence",
					cleanupFailure.stderr || cleanupFailure.stdout,
				);

				writeFileSync(
					trace,
					[
						"[2026-07-28 00:00:00] depth=0→1 PID=1 call=1 trace=positive caller=tool mode=review",
						"[2026-07-28T00:00:01.000Z] depth=0 child_depth=1 COMPLETED exit=0 elapsed=1s caller=tool call=1 trace=positive transcript=failed",
						"[2026-07-28T00:00:02.000Z] depth=0 child_depth=1 LIFECYCLE_TERMINAL exit=0 call=1 trace=positive transcript=failed cleanup=verified",
						"",
				].join("\n"),
				{ mode: 0o600 },
			);
			const failedStatus = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					path.join(import.meta.dir, "..", "scripts", "validate-recursion-transcripts.ts"),
					"--trace",
					trace,
					"--session-dir",
					directory,
				],
				{ encoding: "utf8" },
			);
			record(
				failedStatus.status !== 0
					&& failedStatus.stderr.includes("was not verified"),
				"a receipt cannot override a failed runtime proof status",
				failedStatus.stderr || failedStatus.stdout,
			);
			writeFileSync(
				trace,
					[
						"[2026-07-28 00:00:00] depth=0→1 PID=1 call=1 trace=positive caller=tool mode=review",
						"[2026-07-28T00:00:01.000Z] depth=0 child_depth=1 COMPLETED exit=0 elapsed=1s caller=tool call=1 trace=positive transcript=verified",
						"[2026-07-28T00:00:02.000Z] depth=0 child_depth=1 LIFECYCLE_TERMINAL exit=0 call=1 trace=positive transcript=verified cleanup=verified",
						"",
				].join("\n"),
				{ mode: 0o600 },
			);
			const orphan = path.join(directory, "positive_d2_c2.jsonl");
			writeFileSync(orphan, messageEvent, { mode: 0o600 });
			const orphanValidation = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					path.join(import.meta.dir, "..", "scripts", "validate-recursion-transcripts.ts"),
					"--trace",
					trace,
					"--session-dir",
					directory,
				],
				{ encoding: "utf8" },
			);
			record(
				orphanValidation.status !== 0
					&& orphanValidation.stderr.includes("orphan child transcript"),
				"orphan child transcripts fail the evidence gate",
				orphanValidation.stderr || orphanValidation.stdout,
			);
			rmSync(orphan);

			writeFileSync(transcript, messageEvent, { flag: "a" });
			expectThrow(
				"offline verification rejects transcript mutation after receipt",
				"size no longer matches",
				() => verifyTranscriptReceipt(directory, path.basename(transcript)),
			);
		} finally {
			closeQuietly(lease);
		}
		}

		{
			const directory = sessionDirectory(root, "rejected-admission");
			const nonGitCheckout = path.join(root, "not-a-git-checkout");
			mkdirSync(nonGitCheckout, { mode: 0o700 });
			const previousSharedSessions = process.env.RLM_SHARED_SESSIONS;
			const previousSessionDir = process.env.RLM_SESSION_DIR;
			const previousTraceId = process.env.RLM_TRACE_ID;
			process.env.RLM_SHARED_SESSIONS = "1";
			process.env.RLM_SESSION_DIR = directory;
			process.env.RLM_TRACE_ID = "rejected-admission";
			let rejected = false;
			try {
				acquireChildResources({
					prompt: "test rejected writable admission",
					cwd: nonGitCheckout,
					childDepth: 1,
					callCount: 1,
					mode: "implement",
					scope: ["edit.txt"],
				});
			} catch {
				rejected = true;
			} finally {
				if (previousSharedSessions === undefined) {
					delete process.env.RLM_SHARED_SESSIONS;
				} else {
					process.env.RLM_SHARED_SESSIONS = previousSharedSessions;
				}
				if (previousSessionDir === undefined) {
					delete process.env.RLM_SESSION_DIR;
				} else {
					process.env.RLM_SESSION_DIR = previousSessionDir;
				}
				if (previousTraceId === undefined) {
					delete process.env.RLM_TRACE_ID;
				} else {
					process.env.RLM_TRACE_ID = previousTraceId;
				}
			}
			const transcript = path.join(
				directory,
				"rejected-admission_d1_c1.jsonl",
			);
			record(rejected, "invalid writable workspace admission is rejected");
			record(
				!existsSync(transcript) && !existsSync(`${transcript}.receipt.json`),
				"rejected admission retires its exact unstarted transcript",
			);
		}

		{
			const directory = sessionDirectory(root, "no-append");
		const transcript = childPath(directory, "no_append_d1_c1");
		const lease = prepareTranscriptProof({ childSession: transcript });
		try {
			expectThrow(
				"zero-exit shape without an append fails proof",
				"did not append",
				() => finalizeTranscriptProof(lease, {
					traceId: "no-append",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "replacement");
		const transcript = childPath(directory, "replacement_d1_c1");
		const lease = prepareTranscriptProof({ childSession: transcript });
		try {
			renameSync(transcript, `${transcript}.leased`);
			writeFileSync(transcript, `${sessionEvent}${messageEvent}`, { mode: 0o600 });
			expectThrow(
				"pathname replacement cannot satisfy the held-inode proof",
				"leased inode",
				() => finalizeTranscriptProof(lease, {
					traceId: "replacement",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "hostile-targets");
		const canary = path.join(root, "canary.txt");
		writeFileSync(canary, "UNCHANGED\n", { mode: 0o600 });
		const hardlink = childPath(directory, "hardlink_d1_c1");
		linkSync(canary, hardlink);
		expectThrow(
			"a preexisting hardlink target is rejected without mutation",
			"EEXIST",
			() => prepareTranscriptProof({ childSession: hardlink }),
		);
		const symlink = childPath(directory, "symlink_d1_c2");
		symlinkSync(canary, symlink);
		expectThrow(
			"a preexisting symlink target is rejected without mutation",
			"EEXIST",
			() => prepareTranscriptProof({ childSession: symlink }),
		);
		record(
			readFileSync(canary, "utf8") === "UNCHANGED\n",
			"hostile transcript targets leave the outside canary unchanged",
		);
	}

	{
		const realDirectory = sessionDirectory(root, "real-directory");
		const alias = path.join(root, "session-alias");
		symlinkSync(realDirectory, alias, "dir");
		expectThrow(
			"symlinked session-directory ancestry is rejected",
			"symlinked session-directory ancestry",
			() => prepareTranscriptProof({
				childSession: childPath(alias, "alias_d1_c1"),
			}),
		);
	}

	{
		const directory = sessionDirectory(root, "public-directory");
		chmodSync(directory, 0o755);
		expectThrow(
			"a nonprivate session directory is rejected",
			"mode 0700",
			() => prepareTranscriptProof({
				childSession: childPath(directory, "public_d1_c1"),
			}),
		);
	}

	{
		const directory = sessionDirectory(root, "invalid-utf8");
		const transcript = childPath(directory, "invalid_utf8_d1_c1");
		const lease = prepareTranscriptProof({ childSession: transcript });
		try {
			const descriptor = openSync(transcript, "a");
			try {
				writeSync(descriptor, Buffer.from([0xff, 0x0a]));
			} finally {
				closeSync(descriptor);
			}
			expectThrow(
				"invalid UTF-8 cannot satisfy transcript proof",
				"invalid UTF-8",
				() => finalizeTranscriptProof(lease, {
					traceId: "invalid-utf8",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "malformed-tail");
		const transcript = childPath(directory, "malformed_tail_d1_c1");
		const lease = prepareTranscriptProof({ childSession: transcript });
		try {
			writeFileSync(transcript, `${messageEvent}not-json\n`, { flag: "a" });
			expectThrow(
				"a valid first event cannot hide malformed trailing JSONL",
				"invalid JSONL",
				() => finalizeTranscriptProof(lease, {
					traceId: "malformed-tail",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "oversized-event");
		const transcript = childPath(directory, "oversized_event_d1_c1");
		writeFileSync(transcript, `${"x".repeat(65)}\n`, { mode: 0o600 });
		const descriptor = openSync(transcript, "r");
		try {
			expectThrow(
				"one unbounded JSONL event cannot exhaust proof verification memory",
				"larger than 64 bytes",
				() => validateJsonlRegion(
					descriptor,
					0,
					66,
					"bounded test transcript",
					false,
					64,
				),
			);
		} finally {
			closeSync(descriptor);
		}
	}

	{
		const directory = sessionDirectory(root, "no-message");
		const transcript = childPath(directory, "no_message_d1_c1");
		const lease = prepareTranscriptProof({ childSession: transcript });
		try {
			writeFileSync(transcript, "{}\n", { flag: "a" });
			expectThrow(
				"a generic JSON object is not transcript evidence",
				"no Pi message event",
				() => finalizeTranscriptProof(lease, {
					traceId: "no-message",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "fork-prefix");
		const source = path.join(directory, "parent.jsonl");
		writeFileSync(source, `${sessionEvent}${messageEvent}`, { mode: 0o600 });
		const transcript = childPath(directory, "fork_d1_c1");
		const lease = prepareTranscriptProof({
			childSession: transcript,
			forkSource: source,
		});
		try {
			const descriptor = openSync(transcript, "r+");
			try {
				writeSync(descriptor, Buffer.from("X"), 0, 1, 0);
			} finally {
				closeSync(descriptor);
			}
			writeFileSync(transcript, messageEvent, { flag: "a" });
			expectThrow(
				"a fork child cannot rewrite its secured parent prefix",
				"baseline prefix",
				() => finalizeTranscriptProof(lease, {
					traceId: "fork-prefix",
					parentDepth: 0,
					childDepth: 1,
					callCount: 1,
					childExitCode: 0,
				}),
			);
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "streaming-fork");
		const source = path.join(directory, "parent.jsonl");
		const sourceContent = sessionEvent.repeat(20_000);
		writeFileSync(source, sourceContent, { mode: 0o600 });
		const transcript = childPath(directory, "streaming_d1_c1");
		const originalAllocate = Buffer.allocUnsafe;
		let lease: TranscriptProofLease | undefined;
		try {
			Buffer.allocUnsafe = ((size: number) => {
				if (size > 64 * 1024) {
					throw new Error(`unbounded transcript allocation: ${size}`);
				}
				return originalAllocate(size);
			}) as typeof Buffer.allocUnsafe;
			lease = prepareTranscriptProof({
				childSession: transcript,
				forkSource: source,
			});
		} finally {
			Buffer.allocUnsafe = originalAllocate;
		}
		try {
			record(
				lease?.baselineBytes === Buffer.byteLength(sourceContent),
				"a large fork baseline is copied with bounded allocations",
			);
			writeFileSync(transcript, messageEvent, { flag: "a" });
			finalizeTranscriptProof(lease, {
				traceId: "streaming-fork",
				parentDepth: 0,
				childDepth: 1,
				callCount: 1,
				childExitCode: 0,
			});
		} finally {
			closeQuietly(lease);
		}
	}

	{
		const directory = sessionDirectory(root, "preexisting");
		const transcript = childPath(directory, "preexisting_d1_c1");
		writeFileSync(transcript, messageEvent, { mode: 0o600 });
		expectThrow(
			"a stale deterministic transcript path is rejected",
			"EEXIST",
			() => prepareTranscriptProof({ childSession: transcript }),
		);
	}

	expectThrow(
		"a relative required-transcript path is rejected",
		"absolute child transcript path",
		() => prepareTranscriptProof({ childSession: "relative_d1_c1.jsonl" }),
	);
	expectThrow(
		"a relative required-fork path is rejected",
		"absolute fork source path",
		() => {
			const directory = sessionDirectory(root, "relative-fork");
			return prepareTranscriptProof({
				childSession: childPath(directory, "relative_fork_d1_c1"),
				forkSource: "relative-parent.jsonl",
			});
		},
	);
} finally {
	rmSync(root, { recursive: true, force: true });
	delete process.env.RLM_REQUIRE_TRANSCRIPTS;
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

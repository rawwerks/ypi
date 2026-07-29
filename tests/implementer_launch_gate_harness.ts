import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicCreateFile } from "../extensions/ypi/internal/atomic-file.ts";
import { runChildProcess } from "../extensions/ypi/internal/child-process.ts";
import { acquireConcurrencySlot } from "../extensions/ypi/internal/concurrency.ts";
import { parseLaunchGateArguments } from "../extensions/ypi/internal/launch-gate.ts";
import { currentProcessStartIdentity, processStartIdentity } from "../extensions/ypi/internal/process-identity.ts";
import {
	assertTreeCoordinatorActive,
	ensureRootTreeCoordinator,
	terminateRootTreeCoordinator,
} from "../extensions/ypi/internal/tree-coordinator.ts";

const launcher = path.resolve(import.meta.dir, "..", "scripts", "launch-recursive-child.ts");
const node = process.env.YPI_NODE_BIN || process.execPath;
let pass = 0;
let fail = 0;

function record(ok: boolean, label: string, detail = "") {
	if (ok) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
	}
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; diagnostics: string }> {
	let diagnostics = "";
	child.stdout?.on("data", (chunk) => { diagnostics += String(chunk); });
	child.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
	return new Promise((resolve) => child.once("close", (code) => resolve({ code, diagnostics })));
}

async function runReleasedCommand(
	root: string,
	label: string,
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; diagnostics: string }> {
	const pidFile = path.join(root, `${label}.pid`);
	const readyFile = path.join(root, `${label}.ready`);
	const lease = await acquireConcurrencySlot();
	try {
		const child = spawn(node, [
			launcher,
			"--pid-file",
			pidFile,
			"--ready-file",
			readyFile,
			"--owner-pid",
			String(process.pid),
			"--owner-process-identity",
			currentProcessStartIdentity(),
			"--",
			...command,
		], {
			env: { ...env, RLM_ACTIVE_SLOT_TOKEN: lease.token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = waitForExit(child);
		atomicCreateFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
		atomicCreateFile(readyFile, `${child.pid}\n`, { mode: 0o600 });
		return await exit;
	} finally {
		await lease.release();
	}
}

console.log("\n=== Implementer launch-gate harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_launch_gate."));
process.env.RLM_DEPTH = "0";
process.env.RLM_CONCURRENCY_DIR = path.join(root, "coordinator");
process.env.RLM_CALL_COUNTER_FILE = path.join(root, "calls.counter");
process.env.RLM_MAX_CONCURRENT_CALLS = "3";
process.env.RLM_MAX_CALLS = "65536";
process.env.RLM_CALL_COUNT = "0";
ensureRootTreeCoordinator();
await assertTreeCoordinatorActive();

{
	const childProcessSource = readFileSync(
		path.resolve(import.meta.dir, "..", "extensions", "ypi", "internal", "child-process.ts"),
		"utf8",
	);
	record(
		childProcessSource.includes("atomicCreateFile(options.launchGate.pidFile")
			&& childProcessSource.includes("atomicCreateFile(options.launchGate.readyFile"),
		"child-process publishes both launch signals with atomic create-only primitives",
	);
}

{
	const directory = path.join(root, "atomic-ready");
	const target = path.join(directory, "ready");
	const symlinkTarget = path.join(directory, "symlink-target");
	const symlinkSignal = path.join(directory, "symlink-ready");
	mkdirSync(directory);
	atomicCreateFile(target, "123\n", { mode: 0o600 });
	record(
		readFileSync(target, "utf8") === "123\n"
			&& (statSync(target).mode & 0o777) === 0o600
			&& readdirSync(directory).join("\0") === "ready",
		"atomic create-only publication exposes one complete private signal",
	);
	let preservedExisting = false;
	try {
		atomicCreateFile(target, "replacement\n", { mode: 0o600 });
	} catch (error) {
		preservedExisting = (error as NodeJS.ErrnoException).code === "EEXIST"
			&& readFileSync(target, "utf8") === "123\n"
			&& readdirSync(directory).join("\0") === "ready";
	}
	record(
		preservedExisting,
		"atomic create-only publication preserves an existing signal",
	);
	writeFileSync(symlinkTarget, "preserve\n", { mode: 0o600 });
	symlinkSync(symlinkTarget, symlinkSignal);
	let preservedSymlink = false;
	try {
		atomicCreateFile(symlinkSignal, "replacement\n", { mode: 0o600 });
	} catch (error) {
		preservedSymlink = (error as NodeJS.ErrnoException).code === "EEXIST"
			&& readFileSync(symlinkTarget, "utf8") === "preserve\n";
	}
	record(
		preservedSymlink,
		"atomic create-only publication refuses a pre-existing symlink",
	);
}

{
	const parsed = parseLaunchGateArguments([
		"--pid-file", "pid",
		"--ready-file", "ready",
			"--owner-pid", "42",
			"--owner-process-identity", "linux:test:identity",
		"--",
		"/bin/true",
	]);
	record(
		parsed.pidFile === "pid"
			&& parsed.readyFile === "ready"
				&& parsed.ownerPid === 42
				&& parsed.ownerProcessIdentity === "linux:test:identity"
			&& parsed.command.join("\0") === "/bin/true",
		"launch-gate parser keeps control arguments separate from the child command",
	);
	try {
		parseLaunchGateArguments([
			"--pid-file", "pid",
			"--ready-file", "ready",
				"--owner-pid", "42.5",
				"--owner-process-identity", "linux:test:identity",
			"--",
			"/bin/true",
		]);
		record(false, "launch-gate parser rejects non-integer owner PID", "did not throw");
	} catch {
		record(true, "launch-gate parser rejects non-integer owner PID");
	}
}

{
	const pidFile = path.join(root, "symlink.pid");
	const readyFile = path.join(root, "symlink.ready");
	const readyTarget = path.join(root, "symlink.target");
	const marker = path.join(root, "symlink.marker");
	const lease = await acquireConcurrencySlot();
	try {
		const child = spawn(node, [
			launcher,
			"--pid-file",
			pidFile,
			"--ready-file",
			readyFile,
			"--owner-pid",
			String(process.pid),
			"--owner-process-identity",
			currentProcessStartIdentity(),
			"--",
			"/bin/sh",
			"-c",
			`printf 'unsafe\\n' > '${marker}'`,
		], {
			env: { ...process.env, RLM_ACTIVE_SLOT_TOKEN: lease.token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = waitForExit(child);
		atomicCreateFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
		writeFileSync(readyTarget, `${child.pid}\n`, { mode: 0o600 });
		symlinkSync(readyTarget, readyFile);
		const result = await exit;
		record(
			result.code === 126 && !existsSync(marker),
			"launch gate refuses a symlinked ready signal without starting child work",
			result.diagnostics,
		);
	} finally {
		await lease.release();
	}
}

{
	const pidFile = path.join(root, "success.pid");
	const readyFile = path.join(root, "success.ready");
	const marker = path.join(root, "success.marker");
	const lease = await acquireConcurrencySlot();
	try {
		const child = spawn(node, [
			launcher,
			"--pid-file",
			pidFile,
			"--ready-file",
			readyFile,
			"--owner-pid",
			String(process.pid),
			"--owner-process-identity",
			currentProcessStartIdentity(),
			"--",
			"/bin/sh",
			"-c",
			`printf '%s\\n' "$$" > '${marker}'`,
		], {
			env: { ...process.env, RLM_ACTIVE_SLOT_TOKEN: lease.token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = waitForExit(child);
		atomicCreateFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
		record(!existsSync(marker), "child command cannot run before the durable ready signal");
		record(readFileSync(pidFile, "utf8").trim() === String(child.pid), "parent records the process-group PID before release");
		atomicCreateFile(readyFile, `${child.pid}\n`, { mode: 0o600 });
		const result = await exit;
		record(
			result.code === 0 && readFileSync(marker, "utf8").trim() === String(child.pid),
			"ready signal execs the child command under the registered PID",
			result.diagnostics,
		);
	} finally {
		await lease.release();
	}
}

{
	const pidFile = path.join(root, "abandoned.pid");
	const readyFile = path.join(root, "abandoned.ready");
	const marker = path.join(root, "abandoned.marker");
	const owner = spawn("/bin/sh", ["-c", "sleep 0.2"], { stdio: "ignore" });
	if (!owner.pid) throw new Error("owner PID unavailable");
	const ownerIdentity = processStartIdentity(owner.pid);
	if (!ownerIdentity) throw new Error("owner process identity unavailable");
	const ownerExit = waitForExit(owner);
	const lease = await acquireConcurrencySlot();
	try {
		const child = spawn(node, [
			launcher,
			"--pid-file",
			pidFile,
			"--ready-file",
			readyFile,
			"--owner-pid",
			String(owner.pid),
			"--owner-process-identity",
			ownerIdentity,
			"--",
			"/bin/sh",
			"-c",
			`printf 'unsafe\\n' > '${marker}'`,
		], {
			env: { ...process.env, RLM_ACTIVE_SLOT_TOKEN: lease.token },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const childExit = waitForExit(child);
		atomicCreateFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
		await ownerExit;
		const result = await childExit;
		record(
			result.code === 125 && !existsSync(marker) && !existsSync(readyFile),
			"an owner death before release exits without starting child work",
			result.diagnostics,
		);
	} finally {
		await lease.release();
	}
}

{
	const command = path.join(root, "not-executable");
	writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
	const result = await runReleasedCommand(root, "not-executable", [command]);
	record(
		result.code === 126,
		"launch gate classifies a present non-executable command as 126",
		`code=${result.code} ${result.diagnostics}`,
	);
}

{
	const command = path.join(root, "missing-interpreter");
	writeFileSync(command, "#!/definitely/missing/ypi-interpreter\n", { mode: 0o700 });
	chmodSync(command, 0o700);
	const result = await runReleasedCommand(root, "missing-interpreter", [command]);
	record(
		result.code === 127,
		"launch gate classifies a missing shebang interpreter as 127",
		`code=${result.code} ${result.diagnostics}`,
	);
}

{
	const command = path.join(root, "missing-executable");
	const result = await runReleasedCommand(root, "missing-executable", [command]);
	record(
		result.code === 127,
		"launch gate classifies a missing executable as 127",
		`code=${result.code} ${result.diagnostics}`,
	);
}

{
	const hostile = path.join(root, "hostile-path");
	const hostileEnvMarker = path.join(root, "hostile-env.marker");
	const hostileNodeMarker = path.join(root, "hostile-node.marker");
	mkdirSync(hostile);
	writeFileSync(
		path.join(hostile, "env"),
		`#!/bin/sh\nprintf 'used\\n' > '${hostileEnvMarker}'\nexit 88\n`,
		{ mode: 0o700 },
	);
	writeFileSync(
		path.join(hostile, "node"),
		`#!/bin/sh\nprintf 'used\\n' > '${hostileNodeMarker}'\nexit 89\n`,
		{ mode: 0o700 },
	);
	const hostileEnvironment = { ...process.env, PATH: hostile };
	const direct = await runReleasedCommand(
		root,
		"hostile-path-direct",
		["/bin/true"],
		hostileEnvironment,
	);
	record(
		direct.code === 0 && !existsSync(hostileEnvMarker),
		"launch gate binds the exec-status shim independently of child PATH",
		`code=${direct.code} ${direct.diagnostics}`,
	);

	const priorPi = process.env.YPI_PI_BIN;
	const priorNode = process.env.YPI_NODE_BIN;
	process.env.YPI_PI_BIN = "/bin/true";
	delete process.env.YPI_NODE_BIN;
	const lease = await acquireConcurrencySlot();
	try {
		const result = await runChildProcess({
			args: [],
			env: { ...hostileEnvironment, RLM_ACTIVE_SLOT_TOKEN: lease.token },
			cwd: root,
			jsonMode: false,
			launchGate: {
				launcherPath: launcher,
				pidFile: path.join(root, "hostile-path-runtime.pid"),
				readyFile: path.join(root, "hostile-path-runtime.ready"),
			},
		});
		record(
			result.code === 0
				&& !existsSync(hostileNodeMarker)
				&& !existsSync(hostileEnvMarker),
			"child launcher defaults to the running Node executable under hostile PATH",
			`code=${result.code} stderr=${result.stderr}`,
		);
	} finally {
		await lease.release();
		if (priorPi === undefined) delete process.env.YPI_PI_BIN;
		else process.env.YPI_PI_BIN = priorPi;
		if (priorNode === undefined) delete process.env.YPI_NODE_BIN;
		else process.env.YPI_NODE_BIN = priorNode;
	}
}

{
	const pidFile = path.join(root, "revoked.pid");
	const readyFile = path.join(root, "revoked.ready");
	const marker = path.join(root, "revoked.marker");
	const lease = await acquireConcurrencySlot();
	const child = spawn(node, [
		launcher,
		"--pid-file",
		pidFile,
		"--ready-file",
		readyFile,
		"--owner-pid",
		String(process.pid),
		"--owner-process-identity",
		currentProcessStartIdentity(),
		"--",
		"/bin/sh",
		"-c",
		`printf 'unsafe\\n' > '${marker}'`,
	], {
		env: { ...process.env, RLM_ACTIVE_SLOT_TOKEN: lease.token },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exit = waitForExit(child);
	atomicCreateFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
	await terminateRootTreeCoordinator("launch-gate-revocation-test");
	atomicCreateFile(readyFile, `${child.pid}\n`, { mode: 0o600 });
	const result = await exit;
	record(
		result.code === 130 && !existsSync(marker),
		"terminal root authority revokes the final launch gate before child exec",
		`code=${result.code} ${result.diagnostics}`,
	);
}

rmSync(root, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

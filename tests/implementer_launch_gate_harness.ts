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
import { parseLaunchGateArguments } from "../extensions/ypi/internal/launch-gate.ts";

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
	const child = spawn(node, [
		launcher,
		"--pid-file",
		pidFile,
		"--ready-file",
		readyFile,
		"--owner-pid",
		String(process.pid),
		"--",
		...command,
	], { env, stdio: ["ignore", "pipe", "pipe"] });
	const exit = waitForExit(child);
	writeFileSync(pidFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	writeFileSync(readyFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	return exit;
}

console.log("\n=== Implementer launch-gate harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_launch_gate."));

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
		"--",
		"/bin/true",
	]);
	record(
		parsed.pidFile === "pid"
			&& parsed.readyFile === "ready"
			&& parsed.ownerPid === 42
			&& parsed.command.join("\0") === "/bin/true",
		"launch-gate parser keeps control arguments separate from the child command",
	);
	try {
		parseLaunchGateArguments([
			"--pid-file", "pid",
			"--ready-file", "ready",
			"--owner-pid", "42.5",
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
	const child = spawn(node, [
		launcher,
		"--pid-file",
		pidFile,
		"--ready-file",
		readyFile,
		"--owner-pid",
		String(process.pid),
		"--",
		"/bin/sh",
		"-c",
		`printf 'unsafe\\n' > '${marker}'`,
	], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = waitForExit(child);
	writeFileSync(pidFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	writeFileSync(readyTarget, `${child.pid}\n`, { mode: 0o600 });
	symlinkSync(readyTarget, readyFile);
	const result = await exit;
	record(
		result.code === 126 && !existsSync(marker),
		"launch gate refuses a symlinked ready signal without starting child work",
		result.diagnostics,
	);
}

{
	const pidFile = path.join(root, "success.pid");
	const readyFile = path.join(root, "success.ready");
	const marker = path.join(root, "success.marker");
	const child = spawn(node, [
		launcher,
		"--pid-file",
		pidFile,
		"--ready-file",
		readyFile,
		"--owner-pid",
		String(process.pid),
		"--",
		"/bin/sh",
		"-c",
		`printf '%s\\n' "$$" > '${marker}'`,
	], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = waitForExit(child);
	writeFileSync(pidFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	record(!existsSync(marker), "child command cannot run before the durable ready signal");
	record(readFileSync(pidFile, "utf8").trim() === String(child.pid), "parent records the process-group PID before release");
	writeFileSync(readyFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	const result = await exit;
	record(
		result.code === 0 && readFileSync(marker, "utf8").trim() === String(child.pid),
		"ready signal execs the child command under the registered PID",
		result.diagnostics,
	);
}

{
	const pidFile = path.join(root, "abandoned.pid");
	const readyFile = path.join(root, "abandoned.ready");
	const marker = path.join(root, "abandoned.marker");
	const owner = spawn("/bin/sh", ["-c", "sleep 0.2"], { stdio: "ignore" });
	if (!owner.pid) throw new Error("owner PID unavailable");
	const ownerExit = waitForExit(owner);
	const child = spawn(node, [
		launcher,
		"--pid-file",
		pidFile,
		"--ready-file",
		readyFile,
		"--owner-pid",
		String(owner.pid),
		"--",
		"/bin/sh",
		"-c",
		`printf 'unsafe\\n' > '${marker}'`,
	], { stdio: ["ignore", "pipe", "pipe"] });
	const childExit = waitForExit(child);
	writeFileSync(pidFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	await ownerExit;
	const result = await childExit;
	record(
		result.code === 125 && !existsSync(marker) && !existsSync(readyFile),
		"an owner death before release exits without starting child work",
		result.diagnostics,
	);
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
	try {
		const result = await runChildProcess({
			args: [],
			env: hostileEnvironment,
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
		if (priorPi === undefined) delete process.env.YPI_PI_BIN;
		else process.env.YPI_PI_BIN = priorPi;
		if (priorNode === undefined) delete process.env.YPI_NODE_BIN;
		else process.env.YPI_NODE_BIN = priorNode;
	}
}

rmSync(root, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

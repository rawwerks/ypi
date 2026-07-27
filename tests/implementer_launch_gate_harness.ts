import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseLaunchGateArguments } from "../extensions/ypi/internal/launch-gate.ts";

const launcher = path.resolve(import.meta.dir, "..", "scripts", "launch-implementer-child.ts");
const node = process.env.YPI_NODE_BIN || "node";
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

function waitForFile(file: string, timeoutMilliseconds = 5_000): Promise<void> {
	if (existsSync(file)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = () => {
			clearTimeout(timer);
			watcher.close();
			resolve();
		};
		const watcher = watch(path.dirname(file), () => {
			if (existsSync(file)) finish();
		});
		timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`timed out waiting for ${file}`));
		}, timeoutMilliseconds);
		if (existsSync(file)) finish();
	});
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
	], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = waitForExit(child);
	await waitForPidOrExit(pidFile, exit);
	writeFileSync(readyFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	return exit;
}

async function waitForPidOrExit(
	pidFile: string,
	exit: Promise<{ code: number | null; diagnostics: string }>,
): Promise<void> {
	await Promise.race([
		waitForFile(pidFile),
		exit.then((result) => {
			throw new Error(`launcher exited before PID registration: code=${result.code} ${result.diagnostics}`);
		}),
	]);
}

console.log("\n=== Implementer launch-gate harness ===");
const root = mkdtempSync(path.join(tmpdir(), "ypi_launch_gate."));

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
	await waitForPidOrExit(pidFile, exit);
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
	await waitForPidOrExit(pidFile, exit);
	record(!existsSync(marker), "child command cannot run before the durable ready signal");
	record(readFileSync(pidFile, "utf8").trim() === String(child.pid), "launcher records the process-group PID before release");
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
	await waitForPidOrExit(pidFile, childExit);
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

rmSync(root, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

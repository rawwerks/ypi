import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const launcher = path.resolve(import.meta.dir, "..", "scripts", "launch_implementer_child.py");
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
	const pidFile = path.join(root, "success.pid");
	const readyFile = path.join(root, "success.ready");
	const marker = path.join(root, "success.marker");
	const child = spawn("python3", [
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
		`printf 'ran\\n' > '${marker}'`,
	], { stdio: ["ignore", "pipe", "pipe"] });
	const exit = waitForExit(child);
	await waitForPidOrExit(pidFile, exit);
	record(!existsSync(marker), "child command cannot run before the durable ready signal");
	record(readFileSync(pidFile, "utf8").trim() === String(child.pid), "launcher records the process-group PID before release");
	writeFileSync(readyFile, `${child.pid}\n`, { flag: "wx", mode: 0o600 });
	const result = await exit;
	record(result.code === 0 && readFileSync(marker, "utf8") === "ran\n", "ready signal execs the child command under the registered PID", result.diagnostics);
}

{
	const pidFile = path.join(root, "abandoned.pid");
	const readyFile = path.join(root, "abandoned.ready");
	const marker = path.join(root, "abandoned.marker");
	const owner = spawn("/bin/sh", ["-c", "sleep 0.2"], { stdio: "ignore" });
	if (!owner.pid) throw new Error("owner PID unavailable");
	const ownerExit = waitForExit(owner);
	const child = spawn("python3", [
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

rmSync(root, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const packageRoot = mkdtempSync(path.join(tmpdir(), "ypi-direct-extension."));
const fakePi = path.join(packageRoot, "node_modules", ".bin", "pi");

try {
	mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
	cpSync(
		path.join(projectRoot, "extensions", "recursive.ts"),
		path.join(packageRoot, "extensions", "recursive.ts"),
	);
	cpSync(
		path.join(projectRoot, "extensions", "ypi"),
		path.join(packageRoot, "extensions", "ypi"),
		{ recursive: true },
	);
	mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
	cpSync(
		path.join(projectRoot, "scripts", "launch-recursive-child.ts"),
		path.join(packageRoot, "scripts", "launch-recursive-child.ts"),
	);
	cpSync(
		path.join(projectRoot, "SYSTEM_PROMPT.md"),
		path.join(packageRoot, "SYSTEM_PROMPT.md"),
	);
	mkdirSync(path.dirname(fakePi), { recursive: true });
	writeFileSync(fakePi, "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' PACKED_NATIVE_EXEC_OK\n");
	chmodSync(fakePi, 0o755);
	symlinkSync(
		path.join(projectRoot, "node_modules", "@earendil-works"),
		path.join(packageRoot, "node_modules", "@earendil-works"),
		"dir",
	);
	symlinkSync(
		path.join(projectRoot, "node_modules", "typebox"),
		path.join(packageRoot, "node_modules", "typebox"),
		"dir",
	);

	const child = Bun.spawn([
		process.execPath,
		path.join(projectRoot, "tests", "installed_extension_harness.ts"),
		path.join(packageRoot, "extensions", "recursive.ts"),
		fakePi,
		"--discover-local",
	], {
		cwd: packageRoot,
		env: {
			HOME: process.env.HOME || packageRoot,
			PATH: "/usr/bin:/bin",
			TMPDIR: packageRoot,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0 || !stdout.includes("INSTALLED_EXTENSION_EXECUTION=PASS")) {
		throw new Error(
			`direct extension execution failed (${code}): ${stderr || stdout}`,
		);
	}
	console.log("DIRECT_EXTENSION_LOCAL_PI=PASS");
} finally {
	rmSync(packageRoot, { recursive: true, force: true });
}

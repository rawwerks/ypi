export function processIsAlive(pid: number | undefined): boolean {
	if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
	try {
		process.kill(pid as number, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

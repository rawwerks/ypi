#!/usr/bin/env python3
"""Hold an implementer child until its PID is durably registered."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import sys
import time


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def write_pid_file(target: Path) -> None:
    temporary = target.with_name(f".{target.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, target)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid-file", required=True, type=Path)
    parser.add_argument("--ready-file", required=True, type=Path)
    parser.add_argument("--owner-pid", required=True, type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a child command is required after --")
    if args.owner_pid <= 0:
        parser.error("--owner-pid must be positive")

    write_pid_file(args.pid_file)
    while not args.ready_file.exists():
        if not process_alive(args.owner_pid):
            return 125
        time.sleep(0.01)

    metadata = args.ready_file.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        print("implementer launch gate is not a regular file", file=sys.stderr)
        return 126
    try:
        os.execvpe(command[0], command, os.environ)
    except FileNotFoundError as error:
        print(f"ENOENT: {error}", file=sys.stderr)
        return 127
    except OSError as error:
        print(f"implementer launch failed: {error}", file=sys.stderr)
        return 126


if __name__ == "__main__":
    raise SystemExit(main())

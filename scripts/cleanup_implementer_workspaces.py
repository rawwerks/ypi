#!/usr/bin/env python3
"""Recover stale ypi implementer worktrees without discarding their edits."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any


VALID_STATES = {"reserved", "worktree-ready", "ref-verified", "worktree-removed"}
STAGED_LEASE = re.compile(r"^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.tmp$")
RETIRED_LEASE = re.compile(r"^\.lease-([0-9a-f]{32})-([1-9][0-9]*)-([0-9a-f]{8})\.done$")


def is_oid(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) in {40, 64}
        and all(character in "0123456789abcdef" for character in value)
    )


def git_environment(overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    if overrides:
        env.update(overrides)
    return env


def git(cwd: Path, *args: str, env: dict[str, str] | None = None, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args],
        cwd=cwd,
        env=git_environment(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=not binary,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace") if binary else result.stderr
        raise RuntimeError(f"git {' '.join(args)} failed: {str(stderr).strip()}")
    return result.stdout


def git_optional(cwd: Path, *args: str) -> str | None:
    try:
        return str(git(cwd, *args)).strip()
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return None


def process_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def canonical_scope(value: object) -> list[str]:
    if not isinstance(value, list) or not value or len(value) > 64:
        raise ValueError("scope is empty")
    result: list[str] = []
    for entry in value:
        if (
            not isinstance(entry, str)
            or not entry
            or len(entry) > 1024
            or entry.startswith("/")
            or "\\" in entry
            or any(ord(character) < 32 or ord(character) == 127 for character in entry)
        ):
            raise ValueError("scope contains an invalid path")
        parts: list[str] = []
        for component in entry.split("/"):
            if component in {"", "."}:
                continue
            if component == "..":
                raise ValueError("scope escapes the repository")
            parts.append(component)
        normalized = "/".join(parts) or "."
        if ".git" in parts:
            raise ValueError("scope contains Git metadata")
        if normalized not in result:
            result.append(normalized)
    result.sort()
    reduced: list[str] = []
    for candidate in result:
        if any(path_in_scope(candidate, [owner]) for owner in reduced):
            continue
        reduced.append(candidate)
    if reduced != value:
        raise ValueError("scope is not canonical")
    return reduced


def path_in_scope(candidate: str, scope: list[str]) -> bool:
    return any(owner == "." or candidate == owner or candidate.startswith(f"{owner}/") for owner in scope)


def atomic_write_json(target: Path, value: dict[str, Any]) -> None:
    temporary = target.with_name(f".{target.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)


def scan_registry_artifacts(
    root: Path,
    pattern: re.Pattern[str],
    cutoff: int,
    *,
    staged: bool,
) -> tuple[list[Path], int, list[tuple[Path, str]]]:
    stale: list[Path] = []
    active = 0
    invalid: list[tuple[Path, str]] = []
    if not root.exists():
        return stale, active, invalid
    if root.is_symlink() or not root.is_dir():
        return stale, active, [(root, "registry artifact root is not a directory")]
    for entry in sorted(root.iterdir()):
        match = pattern.fullmatch(entry.name)
        if not match or entry.is_symlink() or not entry.is_dir():
            invalid.append((entry, "unexpected registry artifact"))
            continue
        if staged:
            contents = list(entry.iterdir())
            if (
                len(contents) > 1
                or (
                    contents
                    and (
                        contents[0].name != "lease.json"
                        or contents[0].is_symlink()
                        or not contents[0].is_file()
                    )
                )
            ):
                invalid.append((entry, "staged lease contains unexpected content"))
                continue
        pid = int(match.group(2))
        eligible = int(entry.stat().st_mtime) <= cutoff
        if eligible and not process_alive(pid):
            stale.append(entry)
        else:
            active += 1
    return stale, active, invalid


def retire_lease_directory(lease_dir: Path, token: str) -> None:
    if lease_dir.name != token or lease_dir.parent.name != "leases" or lease_dir.is_symlink():
        raise RuntimeError("lease directory cannot be retired safely")
    retired_root = lease_dir.parent.parent / "retired"
    retired_root.mkdir(mode=0o700, exist_ok=True)
    destination = retired_root / f".lease-{token}-{os.getpid()}-{os.urandom(4).hex()}.done"
    os.replace(lease_dir, destination)
    shutil.rmtree(destination)


def load_record(record_path: Path, common_git_dir: Path) -> dict[str, Any]:
    if record_path.is_symlink() or not record_path.is_file():
        raise ValueError("record metadata is not a regular file")
    value = json.loads(record_path.read_text(encoding="utf-8"))
    token = record_path.parent.name
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or value.get("token") != token
        or len(token) != 32
        or any(character not in "0123456789abcdef" for character in token)
        or type(value.get("ownerPid")) is not int
        or value["ownerPid"] <= 0
        or type(value.get("createdAtEpochSeconds")) is not int
        or value["createdAtEpochSeconds"] < 0
        or (
            value.get("childLaunchStartedAtEpochSeconds") is not None
            and (
                type(value["childLaunchStartedAtEpochSeconds"]) is not int
                or value["childLaunchStartedAtEpochSeconds"] < 0
            )
        )
        or (
            value.get("childPid") is not None
            and (type(value["childPid"]) is not int or value["childPid"] <= 0)
        )
        or value.get("commonGitDir") != str(common_git_dir)
        or not isinstance(value.get("root"), str)
        or not is_oid(value.get("baselineHead"))
        or (value.get("attemptCommit") is not None and not is_oid(value["attemptCommit"]))
        or value.get("state") not in VALID_STATES
        or value.get("attemptRef") != f"refs/ypi/attempt-{token}"
    ):
        raise ValueError("record schema is invalid")
    canonical_scope(value.get("scope"))
    return value


def registered_child_pid(lease_dir: Path, record: dict[str, Any]) -> int | None:
    recorded = record.get("childPid")
    pid_file = lease_dir / "child-pid"
    if not pid_file.exists() and not pid_file.is_symlink():
        return recorded if isinstance(recorded, int) else None
    if pid_file.is_symlink() or not pid_file.is_file():
        raise ValueError("child PID metadata is not a regular file")
    value = pid_file.read_text(encoding="utf-8")
    if not re.fullmatch(r"[1-9][0-9]*\n?", value):
        raise ValueError("child PID metadata is invalid")
    observed = int(value)
    if isinstance(recorded, int) and recorded != observed:
        raise ValueError("child PID metadata disagrees with the lease record")
    return observed


def changed_paths(worktree: Path, baseline: str) -> list[str]:
    tracked = bytes(git(worktree, "diff", "--name-only", "-z", "--no-renames", baseline, "--", binary=True))
    untracked = bytes(git(worktree, "ls-files", "--others", "--exclude-standard", "-z", binary=True))
    paths = {
        item.decode("utf-8", errors="surrogateescape")
        for item in tracked.split(b"\0") + untracked.split(b"\0")
        if item
    }
    return sorted(paths)

def assert_no_unsnapshotted_paths(worktree: Path) -> None:
    ignored = bytes(git(worktree, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", binary=True))
    ignored_paths = [
        item.decode("utf-8", errors="surrogateescape")
        for item in ignored.split(b"\0")
        if item
    ]
    if ignored_paths:
        raise RuntimeError(f"worktree contains ignored paths that cannot be snapshotted: {', '.join(ignored_paths)}")
    index = bytes(git(worktree, "ls-files", "--stage", "-z", binary=True))
    for record in index.split(b"\0"):
        if not record:
            continue
        metadata, separator, raw_path = record.partition(b"\t")
        if not separator or not metadata.startswith(b"160000 "):
            continue
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        submodule = worktree.joinpath(*relative.split("/"))
        if submodule.exists() and any(submodule.iterdir()):
            raise RuntimeError(f"worktree contains content inside an uninitialized submodule: {relative}")


def capture_worktree_tree(worktree: Path, baseline: str, index: Path) -> str:
    assert_no_unsnapshotted_paths(worktree)
    index.unlink(missing_ok=True)
    snapshot_env = {"GIT_INDEX_FILE": str(index)}
    git(worktree, "read-tree", baseline, env=snapshot_env)
    git(worktree, "add", "-A", "--", ".", env=snapshot_env)
    return str(git(worktree, "write-tree", env=snapshot_env)).strip()


def verify_owned_container(record: dict[str, Any]) -> tuple[Path, Path]:
    container_value = record.get("worktreeContainer")
    root_value = record.get("worktreeRoot")
    if not isinstance(container_value, str) or not isinstance(root_value, str):
        raise RuntimeError("record has no worktree path")
    container = Path(container_value)
    worktree = Path(root_value)
    if (
        not container.is_absolute()
        or not worktree.is_absolute()
        or container.name != f"ypi_ws_{record['token']}"
        or worktree != container / "checkout"
        or container.is_symlink()
        or not container.is_dir()
    ):
        raise RuntimeError("recorded worktree path is not an owned ypi workspace")
    try:
        marker = container / "owner"
        if marker.is_symlink() or not marker.is_file():
            raise RuntimeError("workspace ownership marker is not a regular file")
        owner = marker.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise RuntimeError(f"workspace ownership marker is unavailable: {error}") from error
    if owner != record["token"]:
        raise RuntimeError("workspace ownership marker does not match the lease")
    return container, worktree


def verify_worktree(record: dict[str, Any], common_git_dir: Path) -> Path:
    _, worktree = verify_owned_container(record)
    discovered = git_optional(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if discovered is None or Path(discovered).resolve() != common_git_dir.resolve():
        raise RuntimeError("worktree does not belong to the requested repository")
    return worktree


def remove_container_without_worktree(record: dict[str, Any]) -> None:
    container_value = record.get("worktreeContainer")
    root_value = record.get("worktreeRoot")
    if not isinstance(container_value, str) or not isinstance(root_value, str):
        raise RuntimeError("record has no worktree path")
    container = Path(container_value)
    worktree = Path(root_value)
    if (
        not container.is_absolute()
        or not worktree.is_absolute()
        or container.name != f"ypi_ws_{record['token']}"
        or worktree != container / "checkout"
    ):
        raise RuntimeError("recorded worktree path is not an owned ypi workspace")
    if worktree.exists():
        raise RuntimeError("worktree still exists")
    if not container.exists():
        return
    try:
        verified_container, _ = verify_owned_container(record)
        shutil.rmtree(verified_container)
        return
    except (OSError, RuntimeError):
        if container.is_symlink() or not container.is_dir():
            raise RuntimeError("partial workspace container is not an owned directory")
        entries = list(container.iterdir())
        if not entries:
            container.rmdir()
            return
        marker = container / "owner"
        if (
            len(entries) != 1
            or entries[0] != marker
            or marker.is_symlink()
            or not marker.is_file()
        ):
            raise RuntimeError("partial workspace container has unexpected content")
        actual = marker.read_bytes()
        expected = f"{record['token']}\n".encode()
        if len(actual) > len(expected) or expected[: len(actual)] != actual:
            raise RuntimeError("partial workspace ownership marker is invalid")
        marker.unlink()
        container.rmdir()


def verify_attempt_ref(repo_root: Path, record: dict[str, Any]) -> str | None:
    attempt_ref = str(record["attemptRef"])
    commit = git_optional(repo_root, "rev-parse", "--verify", f"{attempt_ref}^{{commit}}")
    if not commit:
        return None
    recorded = record.get("attemptCommit")
    if recorded is not None and recorded != commit:
        raise RuntimeError("attempt ref no longer resolves to the recorded commit")
    scope = canonical_scope(record["scope"])
    diff = bytes(git(repo_root, "diff", "--name-only", "-z", "--no-renames", record["baselineHead"], commit, "--", binary=True))
    outside = [
        item.decode("utf-8", errors="surrogateescape")
        for item in diff.split(b"\0")
        if item and not path_in_scope(item.decode("utf-8", errors="surrogateescape"), scope)
    ]
    if outside:
        raise RuntimeError(f"attempt ref contains paths outside scope: {', '.join(outside)}")
    return commit


def snapshot_worktree(worktree: Path, lease_dir: Path, record: dict[str, Any]) -> str:
    scope = canonical_scope(record["scope"])
    outside = [candidate for candidate in changed_paths(worktree, record["baselineHead"]) if not path_in_scope(candidate, scope)]
    if outside:
        raise RuntimeError(f"worktree contains paths outside scope: {', '.join(outside)}")
    index = lease_dir / "cleanup-index"
    snapshot_env = {"GIT_INDEX_FILE": str(index)}
    try:
        tree = capture_worktree_tree(worktree, record["baselineHead"], index)
        commit = str(
            git(
                worktree,
                "commit-tree",
                tree,
                "-p",
                record["baselineHead"],
                "-m",
                f"ypi cleanup salvage {record['token'][:12]}",
                env={
                    **snapshot_env,
                    "GIT_AUTHOR_NAME": "ypi",
                    "GIT_AUTHOR_EMAIL": "ypi@localhost",
                    "GIT_COMMITTER_NAME": "ypi",
                    "GIT_COMMITTER_EMAIL": "ypi@localhost",
                },
            )
        ).strip()
        git(worktree, "update-ref", record["attemptRef"], commit, "0" * len(record["baselineHead"]))
        verified = str(git(worktree, "rev-parse", "--verify", f"{record['attemptRef']}^{{commit}}")).strip()
        verified_tree = str(git(worktree, "rev-parse", f"{verified}^{{tree}}")).strip()
        if verified != commit or verified_tree != tree:
            raise RuntimeError("salvage ref verification did not resolve to the captured tree")
        record["attemptCommit"] = commit
        record["state"] = "ref-verified"
        atomic_write_json(lease_dir / "lease.json", record)
        return commit
    finally:
        index.unlink(missing_ok=True)


def remove_recovered_worktree(repo_root: Path, worktree: Path, lease_dir: Path, record: dict[str, Any]) -> None:
    git(repo_root, "worktree", "remove", "--force", str(worktree))
    record["state"] = "worktree-removed"
    atomic_write_json(lease_dir / "lease.json", record)
    container, _ = verify_owned_container(record)
    if container.exists():
        shutil.rmtree(container)
    retire_lease_directory(lease_dir, record["token"])


def discard_reserved_workspace(repo_root: Path, lease_dir: Path, record: dict[str, Any]) -> None:
    container_value = record.get("worktreeContainer")
    root_value = record.get("worktreeRoot")
    if not isinstance(container_value, str) or not isinstance(root_value, str):
        retire_lease_directory(lease_dir, record["token"])
        return
    container = Path(container_value)
    worktree = Path(root_value)
    if (
        not container.is_absolute()
        or not worktree.is_absolute()
        or container.name != f"ypi_ws_{record['token']}"
        or worktree != container / "checkout"
    ):
        raise RuntimeError("reserved workspace paths are invalid")
    if not container.exists():
        retire_lease_directory(lease_dir, record["token"])
        return
    if not worktree.exists():
        remove_container_without_worktree(record)
        retire_lease_directory(lease_dir, record["token"])
        return
    try:
        container, worktree = verify_owned_container(record)
    except (OSError, RuntimeError):
        if worktree.exists():
            raise RuntimeError("unmarked reserved workspace unexpectedly contains a checkout")
        entries = list(container.iterdir())
        if not entries:
            container.rmdir()
            retire_lease_directory(lease_dir, record["token"])
            return
        marker = container / "owner"
        if (
            len(entries) != 1
            or entries[0] != marker
            or marker.is_symlink()
            or not marker.is_file()
        ):
            raise RuntimeError("unmarked reserved workspace has unexpected content")
        actual = marker.read_bytes()
        expected = f"{record['token']}\n".encode()
        if len(actual) > len(expected) or expected[: len(actual)] != actual:
            raise RuntimeError("partial workspace ownership marker is invalid")
        marker.unlink()
        container.rmdir()
        retire_lease_directory(lease_dir, record["token"])
        return
    if worktree.exists():
        try:
            git(repo_root, "worktree", "remove", "--force", str(worktree))
        except RuntimeError:
            shutil.rmtree(container)
            git(repo_root, "worktree", "prune", "--expire", "now")
    if container.exists():
        shutil.rmtree(container)
    retire_lease_directory(lease_dir, record["token"])


def mutex_owner(lock_path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads((lock_path / "owner.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def acquire_cleanup_mutex(lock_path: Path) -> str:
    token = os.urandom(16).hex()
    lock_path.mkdir(mode=0o700)
    atomic_write_json(
        lock_path / "owner.json",
        {
            "schemaVersion": 1,
            "token": token,
            "pid": os.getpid(),
            "createdAtEpochSeconds": int(time.time()),
        },
    )
    return token


def cleanup(args: argparse.Namespace) -> int:
    repo = Path(args.repo)
    repo_root_value = git_optional(repo, "rev-parse", "--show-toplevel")
    if not repo_root_value:
        print(f"Implementer leases older than {args.age}m: no Git checkout")
        return 0
    repo_root = Path(repo_root_value)
    common_value = git_optional(repo_root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common_value:
        print(f"Implementer leases older than {args.age}m: Git common directory unavailable")
        return 1
    common_git_dir = Path(common_value)
    registry_root = common_git_dir / "ypi-implementers"
    leases_root = registry_root / "leases"
    staging_root = registry_root / "staging"
    retired_root = registry_root / "retired"
    lock_path = common_git_dir / "ypi-implementers.lock"
    cutoff = int(time.time()) - args.age * 60

    for registry_path in (registry_root, leases_root, staging_root, retired_root):
        if registry_path.is_symlink() or (registry_path.exists() and not registry_path.is_dir()):
            print(
                f"Implementer leases older than {args.age}m: "
                f"preserved invalid registry path {registry_path}"
            )
            return 1
    if lock_path.is_symlink() or (lock_path.exists() and not lock_path.is_dir()):
        print(f"Implementer leases older than {args.age}m: preserved invalid registry lock {lock_path}")
        return 1
    owner = mutex_owner(lock_path) if lock_path.exists() else None
    lock_pid = owner.get("pid") if owner else None
    lock_created = owner.get("createdAtEpochSeconds") if owner else None
    unknown_owner_old_enough = (
        owner is None
        and lock_path.exists()
        and lock_path.stat().st_mtime <= min(cutoff, time.time() - 5)
    )
    stale_lock = lock_path.exists() and not process_alive(lock_pid) and (
        (isinstance(lock_created, int) and lock_created <= cutoff)
        or unknown_owner_old_enough
    )
    if lock_path.exists() and not stale_lock:
        print(f"Implementer leases older than {args.age}m: skipped (live or recent registry lock: {lock_path})")
        return 0
    if stale_lock and not args.force:
        print(f"Stale implementer registry lock: {lock_path} (use --force to recover)")
    if stale_lock and args.force:
        shutil.rmtree(lock_path)

    records: list[tuple[Path, dict[str, Any], int | None]] = []
    invalid: list[tuple[Path, str]] = []
    if leases_root.exists():
        for lease_dir in sorted(leases_root.iterdir()):
            if lease_dir.is_symlink() or not lease_dir.is_dir():
                invalid.append((lease_dir, "unexpected non-directory registry entry"))
                continue
            record_path = lease_dir / "lease.json"
            try:
                record = load_record(record_path, common_git_dir)
                records.append((lease_dir, record, registered_child_pid(lease_dir, record)))
            except (OSError, ValueError, json.JSONDecodeError) as error:
                invalid.append((lease_dir, str(error)))

    staged, staged_active, staged_invalid = scan_registry_artifacts(
        staging_root,
        STAGED_LEASE,
        cutoff,
        staged=True,
    )
    retired, retired_active, retired_invalid = scan_registry_artifacts(
        retired_root,
        RETIRED_LEASE,
        cutoff,
        staged=False,
    )
    invalid.extend(staged_invalid)
    invalid.extend(retired_invalid)

    stale: list[tuple[Path, dict[str, Any], int | None]] = []
    active = 0
    now = int(time.time())
    for item in records:
        record = item[1]
        child_pid = item[2]
        eligible = record["createdAtEpochSeconds"] <= cutoff
        launch_started = record.get("childLaunchStartedAtEpochSeconds")
        launch_registration_pending = (
            child_pid is None
            and isinstance(launch_started, int)
            and now - launch_started < 5
        )
        alive = (
            process_alive(record["ownerPid"])
            or process_alive(child_pid)
            or launch_registration_pending
        )
        if eligible and not alive:
            stale.append(item)
        else:
            active += 1
    print(
        f"Implementer leases older than {args.age}m: {len(stale)} "
        f"(active/recent: {active}, staged: {len(staged)}/{staged_active}, "
        f"retired: {len(retired)}/{retired_active}, invalid: {len(invalid)})"
    )
    for lease_dir, reason in invalid:
        print(f"  preserved invalid lease {lease_dir}: {reason}")
    if not args.force:
        for lease_dir, record, _child_pid in stale:
            print(f"  would recover {record['token'][:12]} scope=[{', '.join(record['scope'])}] from {lease_dir}")
        for artifact in staged:
            print(f"  would discard pre-admission staged lease {artifact}")
        for artifact in retired:
            print(f"  would finish removing retired lease {artifact}")
        if stale or staged or retired:
            print("  (use --force to salvage refs and remove recovered worktrees)")
        return 0

    lock_token = ""
    failures = len(invalid)
    try:
        lock_token = acquire_cleanup_mutex(lock_path)
        recovered = 0
        for artifact in staged:
            shutil.rmtree(artifact)
            print(f"  discarded pre-admission staged lease {artifact.name}")
        for artifact in retired:
            shutil.rmtree(artifact)
            print(f"  removed retired lease {artifact.name}")
        for lease_dir, record, _child_pid in stale:
            try:
                worktree_value = record.get("worktreeRoot")
                worktree_exists = isinstance(worktree_value, str) and Path(worktree_value).exists()
                commit = verify_attempt_ref(repo_root, record)
                if record["state"] == "reserved":
                    if commit is not None:
                        raise RuntimeError("reserved lease unexpectedly owns an attempt ref")
                    discard_reserved_workspace(repo_root, lease_dir, record)
                elif worktree_exists:
                    worktree = verify_worktree(record, common_git_dir)
                    if commit is None:
                        commit = snapshot_worktree(worktree, lease_dir, record)
                    ref_tree = str(git(repo_root, "rev-parse", f"{commit}^{{tree}}")).strip()
                    current_tree = capture_worktree_tree(worktree, record["baselineHead"], lease_dir / "cleanup-verify-index")
                    (lease_dir / "cleanup-verify-index").unlink(missing_ok=True)
                    if current_tree != ref_tree:
                        raise RuntimeError("worktree changed after its verified attempt ref was captured")
                    remove_recovered_worktree(repo_root, worktree, lease_dir, record)
                elif commit is not None:
                    remove_container_without_worktree(record)
                    retire_lease_directory(lease_dir, record["token"])
                else:
                    raise RuntimeError("worktree is missing and no verified attempt ref proves recoverability")
                recovered += 1
                destination = f"{record['attemptRef']} ({commit})" if commit else "reserved workspace before child admission"
                print(f"  recovered {record['token'][:12]} at {destination}")
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                failures += 1
                print(f"  preserved {record['token'][:12]}: {error}", file=sys.stderr)
        git(repo_root, "worktree", "prune", "--expire", "now")
        print(f"  recovered leases: {recovered}")
    finally:
        if lock_token:
            current = mutex_owner(lock_path)
            if current and current.get("token") == lock_token:
                shutil.rmtree(lock_path)
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--age", required=True, type=int)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.age < 0:
        parser.error("--age must be non-negative")
    return cleanup(args)


if __name__ == "__main__":
    raise SystemExit(main())

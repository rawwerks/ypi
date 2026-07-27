#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$ROOT" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
registry = json.loads((root / "config/runtime-env.json").read_text())
if registry.get("schema_version") != 1:
    raise SystemExit("config surface: unsupported schema_version")

entries = registry.get("variables", [])
names = [entry["name"] for entry in entries]
if len(names) != len(set(names)):
    raise SystemExit("config surface: duplicate variable names")
allowed_visibility = {"public", "internal", "platform", "unsupported"}
if any(entry.get("visibility") not in allowed_visibility for entry in entries):
    raise SystemExit("config surface: invalid visibility")
registered = set(names)
runtime_registered = {
    entry["name"] for entry in entries if entry["visibility"] != "unsupported"
}

def typescript_inputs():
    found = set()
    patterns = [
        re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)"),
        re.compile(r"""process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]"""),
    ]
    for source in (root / "extensions").rglob("*.ts"):
        text = source.read_text()
        for pattern in patterns:
            for match in pattern.finditer(text):
                prefix = text[max(0, match.start() - 8):match.start()]
                suffix = text[match.end():]
                if re.search(r"delete\s*$", prefix):
                    continue
                if re.match(r"\s*(?:=|\|\|=|\?\?=)", suffix) and not re.match(r"\s*={2,}", suffix):
                    continue
                found.add(match.group(1))
    return found

shell_sources = [
    root / "ypi",
    root / "rlm_query",
    root / "rlm_cost",
    root / "rlm_sessions",
    root / "scripts/doctor",
    root / "scripts/detect-ambient-recursion-conflict",
]
runtime_name = re.compile(
    r"\$(?:\{)?((?:RLM|YPI)_[A-Z0-9_]+|PI_TRACE_FILE|PI_CODING_AGENT_DIR|CONTEXT|HOME|PATH|TMPDIR)"
)
assignment = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=")

def shell_inputs():
    found = set()
    for source in shell_sources:
        assigned = set()
        for line in source.read_text().splitlines():
            assigned_here = assignment.match(line)
            for name in runtime_name.findall(line):
                if name not in assigned or (assigned_here and assigned_here.group(1) == name):
                    found.add(name)
            if assigned_here:
                assigned.add(assigned_here.group(1))
    return found

actual = typescript_inputs() | shell_inputs()
missing = sorted(actual - registered)
stale = sorted(runtime_registered - actual)
if missing or stale:
    details = []
    if missing:
        details.append(f"unregistered runtime inputs: {', '.join(missing)}")
    if stale:
        details.append(f"registry entries absent from runtime: {', '.join(stale)}")
    raise SystemExit("config surface: " + "; ".join(details))

def marked_table(path, start, end):
    text = path.read_text()
    try:
        body = text.split(start, 1)[1].split(end, 1)[0]
    except IndexError:
        raise SystemExit(f"config surface: missing markers in {path.name}")
    return set(re.findall(r"^\|\s*`([^`]+)`\s*\|", body, re.MULTILINE))

readme = root / "README.md"
documented_env = marked_table(
    readme,
    "<!-- runtime-env:start -->",
    "<!-- runtime-env:end -->",
)
public = {entry["name"] for entry in entries if entry["visibility"] == "public"}
if documented_env != public:
    raise SystemExit(
        "config surface: README environment table drift: "
        f"missing={sorted(public - documented_env)} extra={sorted(documented_env - public)}"
    )

node_consumers = {
    str(source.relative_to(root))
    for source in [
        root / "rlm_query",
        root / "rlm_cleanup",
        root / "extensions/ypi/internal/child-process.ts",
    ]
    if "YPI_NODE_BIN" in source.read_text()
}
expected_node_consumers = {
    "rlm_query",
    "rlm_cleanup",
    "extensions/ypi/internal/child-process.ts",
}
if node_consumers != expected_node_consumers:
    raise SystemExit(
        "config surface: YPI_NODE_BIN consumer contract drift: "
        f"actual={sorted(node_consumers)} expected={sorted(expected_node_consumers)}"
    )
node_row = re.search(
    r"^\|\s*`YPI_NODE_BIN`\s*\|[^|]*\|([^|]*)\|$",
    readme.read_text(),
    re.MULTILINE,
)
node_purpose = node_row.group(1).lower() if node_row else ""
required_node_roles = {"shell recursion", "recovery", "implementer launch"}
missing_node_roles = sorted(
    role for role in required_node_roles if role not in node_purpose
)
if missing_node_roles:
    raise SystemExit(
        "config surface: README YPI_NODE_BIN purpose omits runtime roles: "
        + ", ".join(missing_node_roles)
    )

cli_source = (root / "extensions/ypi/cli.ts").read_text()
parse_block = cli_source.split("function parseFlags", 1)[1].split("function parentContext", 1)[0]
actual_flags = set(re.findall(r'case "(--[a-z-]+)"', parse_block))
registered_flags = {entry["name"] for entry in registry.get("cli_flags", [])}
documented_flags = marked_table(
    readme,
    "<!-- rlm-query-flags:start -->",
    "<!-- rlm-query-flags:end -->",
)
if actual_flags != registered_flags or documented_flags != registered_flags:
    raise SystemExit(
        "config surface: rlm_query flag drift: "
        f"runtime={sorted(actual_flags)} registry={sorted(registered_flags)} "
        f"README={sorted(documented_flags)}"
    )

token_pattern = re.compile(r"\b(?:RLM|YPI|PI)_[A-Z0-9_]+\b")
mentioned = set(token_pattern.findall("\n".join((root / "ypi").read_text().splitlines()[:18])))
for surface in [root / "README.md", root / "AGENTS.md", root / "SYSTEM_PROMPT.md"]:
    mentioned.update(token_pattern.findall(surface.read_text()))
unknown = sorted(mentioned - registered)
if unknown:
    raise SystemExit(f"config surface: undocumented runtime ownership for: {', '.join(unknown)}")

print(f"config surface: PASS ({len(registered)} variables, {len(registered_flags)} CLI flags)")
PY

#!/bin/bash
# test_extensions.sh — Verify ypi extensions load cleanly with installed Pi
#
# Tests that our .ts extensions are compatible with the repository-selected Pi.
#
# Run: bash tests/test_extensions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/helpers/resolve_pi_bin.sh"

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

# ─── Check prerequisites ─────────────────────────────────────────────────

PI_BIN="$(resolve_ypi_pi_bin "$PROJECT_DIR")"
if [ -z "$PI_BIN" ] || [ ! -x "$PI_BIN" ]; then
    echo "SKIP: pi not installed"
    exit 0
fi

PI_VERSION=$("$PI_BIN" --version 2>/dev/null | tr -d '[:space:]' || echo "unknown")
echo ""
echo "=== Extension Compatibility Tests (pi $PI_VERSION) ==="
echo ""

# ─── Pi version pin: internal consistency is HARD, "is latest" is advisory ───

echo "--- Pi version pin ---"

KNOWN_GOOD=$(tr -d '[:space:]' < "$PROJECT_DIR/.pi-version")
PINNED=$(node -e "const p=require('$PROJECT_DIR/package.json'); console.log(p.dependencies['@earendil-works/pi-coding-agent'] || '')")
PI_MANIFEST=$(node -e "const p=require('$PROJECT_DIR/package.json'); console.log((p.pi?.extensions || []).join('\\n'))")
PI_SKILLS=$(node -e "const p=require('$PROJECT_DIR/package.json'); console.log((p.pi?.skills || []).join('\\n'))")
# HARD: the pin must be internally consistent — .pi-version and the package.json
# dependency must agree. This can never silently drift.
if [ -n "$KNOWN_GOOD" ] && [ "$KNOWN_GOOD" = "$PINNED" ]; then
    pass "pinned Pi consistent (.pi-version=$KNOWN_GOOD == package.json=$PINNED)"
else
    fail "pinned Pi consistent (.pi-version == package.json)" ".pi-version=$KNOWN_GOOD package.json=$PINNED"
fi
if [ "$PI_VERSION" = "$KNOWN_GOOD" ]; then
    pass "tested Pi matches pin ($PI_VERSION)"
else
    fail "tested Pi matches pin" "binary=$PI_BIN version=$PI_VERSION expected=$KNOWN_GOOD"
fi

if [ "$PI_MANIFEST" = "./extensions/recursive.ts" ]; then
    pass "pi package manifest exposes only canonical extension"
else
    fail "pi package manifest exposes only canonical extension" "pi.extensions=$PI_MANIFEST"
fi
if [ "$PI_SKILLS" = "./skills" ] && grep -q '^name: bounded-recursive-delegation$' "$PROJECT_DIR/skills/bounded-recursive-delegation/SKILL.md"; then
    pass "pi package manifest exposes bounded recursive delegation skill"
else
    fail "pi package manifest exposes bounded recursive delegation skill" "pi.skills=$PI_SKILLS"
fi

echo ""

# ─── Test each extension loads without error ──────────────────────────────

test_extension_loads() {
    local name="$1" path="$2"
    if [ ! -f "$path" ]; then
        fail "$name" "file not found: $path"
        return
    fi

    local stderr_file
    stderr_file=$(mktemp "${TMPDIR:-/tmp}/ext_test.txt.XXXXXX")

    # Load the extension without making an LLM call. --list-models still
    # initializes explicit extensions, so syntax/API breakage is caught.
    local rc
    set +e
    timeout 15 "$PI_BIN" --no-extensions -e "$path" --list-models test \
        >"$stderr_file.stdout" 2>"$stderr_file"
    rc=$?
    set -e

    if [ "$rc" -ne 0 ]; then
        fail "$name loads" "exit=$rc stderr=$(cat "$stderr_file")"
    elif grep -qi "Failed to load extension" "$stderr_file"; then
        local err
        err=$(cat "$stderr_file")
        fail "$name loads" "$err"
    else
        pass "$name loads"
    fi

    rm -f "$stderr_file" "$stderr_file.stdout"
}

# Test the canonical ypi recursive extension.
test_extension_loads "recursive.ts" "$PROJECT_DIR/extensions/recursive.ts"

# Test that recursive.ts works with RLM env vars set (as it would in real usage)
echo ""
echo "--- Environment integration ---"

stderr_file=$(mktemp "${TMPDIR:-/tmp}/ext_test.txt.XXXXXX")
set +e
RLM_DEPTH=0 RLM_MAX_DEPTH=5 \
    timeout 15 "$PI_BIN" --no-extensions \
    -e "$PROJECT_DIR/extensions/recursive.ts" --list-models test \
    >"$stderr_file.stdout" 2>"$stderr_file"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
    fail "recursive.ts with RLM env vars" "exit=$rc stderr=$(cat "$stderr_file")"
elif grep -qi "Failed to load extension\|Error\|TypeError\|ReferenceError" "$stderr_file"; then
    fail "recursive.ts with RLM env vars" "$(cat "$stderr_file")"
else
    pass "recursive.ts with RLM env vars"
fi
rm -f "$stderr_file" "$stderr_file.stdout"

# Test the minimal pure-Pi extension mode: only Pi plus the extension files.
# No ypi launcher, shell helper, or external system prompt.
echo ""
echo "--- Minimal pure-Pi extension mode ---"

mkdir -p "${HOME}/scratch"
MIN_ROOT=$(mktemp -d "${HOME}/scratch/ypi-minimal-extension.XXXXXX")
mkdir -p "$MIN_ROOT/extensions"
cp "$PROJECT_DIR/extensions/recursive.ts" "$MIN_ROOT/extensions/recursive.ts"
cp -R "$PROJECT_DIR/extensions/ypi" "$MIN_ROOT/extensions/ypi"

if [ ! -e "$MIN_ROOT/rlm_query" ] && [ ! -e "$MIN_ROOT/SYSTEM_PROMPT.md" ]; then
    pass "minimal root has no shell helper or external prompt"
else
    fail "minimal root has no shell helper or external prompt" "$(find "$MIN_ROOT" -maxdepth 1 -type f -printf '%f ' 2>/dev/null || true)"
fi

stderr_file="$MIN_ROOT/minimal.stderr"
stdout_file="$MIN_ROOT/minimal.stdout"
set +e
env -u YPI_EXTENSION_ROOT -u YPI_EXTENSION_PATH \
    RLM_DEPTH=0 RLM_MAX_DEPTH=1 \
    YPI_EXTENSION_DEBUG=1 \
    timeout 15 "$PI_BIN" --no-extensions \
    -e "$MIN_ROOT/extensions/recursive.ts" --list-models test \
    >"$stdout_file" 2>"$stderr_file"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
    fail "minimal extension loads without ypi shell files" "exit=$rc stderr=$(cat "$stderr_file")"
elif grep -qi "Failed to load extension\|Error\|TypeError\|ReferenceError" "$stderr_file"; then
    fail "minimal extension loads without ypi shell files" "$(cat "$stderr_file")"
else
    pass "minimal extension loads without ypi shell files"
fi

if grep -q "__YPI_NATIVE_TOOL_REGISTERED__" "$stderr_file" \
    && grep -q "__YPI_EXTENSION_LOADED__" "$stderr_file"; then
    pass "minimal extension registers native recursion tool"
else
    fail "minimal extension registers native recursion tool" "stderr=$(cat "$stderr_file")"
fi

# ─── Results ──────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (pi $PI_VERSION)"
echo "═══════════════════════════════════"

if [ $FAIL -gt 0 ]; then
    echo -e "\nFailures:$ERRORS"
    exit 1
fi

echo ""
echo "All extension tests passed! ✓"

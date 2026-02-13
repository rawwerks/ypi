#!/bin/bash
# test_extensions.sh — Verify ypi extensions load cleanly with installed Pi
#
# Tests that our .ts extensions are compatible with the installed pi version.
# Requires: pi installed and on PATH.
#
# Run: bash tests/test_extensions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

# ─── Check prerequisites ─────────────────────────────────────────────────

if ! command -v pi &>/dev/null; then
    echo "SKIP: pi not installed"
    exit 0
fi

PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")
echo ""
echo "=== Extension Compatibility Tests (pi $PI_VERSION) ==="
echo ""

# ─── Test each extension loads without error ──────────────────────────────

test_extension_loads() {
    local name="$1" path="$2"
    if [ ! -f "$path" ]; then
        fail "$name" "file not found: $path"
        return
    fi

    local stderr_file
    stderr_file=$(mktemp /tmp/ext_test_XXXXXX.txt)

    # Load the extension in print mode with a trivial prompt
    echo "test" | timeout 15 pi -p --no-session --no-extensions -e "$path" "say ok" \
        >"$stderr_file.stdout" 2>"$stderr_file" || true

    if grep -qi "Failed to load extension" "$stderr_file"; then
        local err
        err=$(cat "$stderr_file")
        fail "$name loads" "$err"
    else
        pass "$name loads"
    fi

    rm -f "$stderr_file" "$stderr_file.stdout"
}

# Test ypi status extension
test_extension_loads "ypi.ts" "$PROJECT_DIR/extensions/ypi.ts"

# Test hashline extension (if present — it's in contrib/)
if [ -f "$PROJECT_DIR/contrib/extensions/hashline.ts" ]; then
    test_extension_loads "hashline.ts" "$PROJECT_DIR/contrib/extensions/hashline.ts"
fi

# Test that ypi.ts works with RLM env vars set (as it would in real usage)
echo ""
echo "--- Environment integration ---"

stderr_file=$(mktemp /tmp/ext_test_XXXXXX.txt)
RLM_DEPTH=0 RLM_MAX_DEPTH=5 \
    echo "test" | timeout 15 pi -p --no-session --no-extensions \
    -e "$PROJECT_DIR/extensions/ypi.ts" "say ok" \
    >"$stderr_file.stdout" 2>"$stderr_file" || true

if grep -qi "Failed to load extension\|Error\|TypeError\|ReferenceError" "$stderr_file"; then
    fail "ypi.ts with RLM env vars" "$(cat "$stderr_file")"
else
    pass "ypi.ts with RLM env vars"
fi
rm -f "$stderr_file" "$stderr_file.stdout"

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

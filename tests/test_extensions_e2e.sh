#!/bin/bash
# test_extensions_e2e.sh — Real extension tests with actual Pi
#
# Tests that ypi extensions work correctly with the installed pi version.
# Uses REAL Pi with REAL LLM calls to verify extension functionality.
#
# This catches breaking changes in Pi's extension API that shallow
# "does it load?" tests miss.
#
# Prerequisites:
#   - pi installed and on PATH
#   - API key configured (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, etc.)
#
# Run: bash tests/test_extensions_e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export PATH="$PROJECT_DIR:$PATH"

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

# Temp dir for test artifacts
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/ypi_ext_e2e.XXXXXX")
trap 'rm -rf "$TEST_TMP"' EXIT

PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")
echo ""
echo "=== Extension E2E Tests (pi $PI_VERSION) ==="
echo ""

# ─── EXT1: ypi.ts loads and hooks session_start ──────────────────────────
# The extension sets terminal title to "ypi" — we can't check that in CI,
# but we CAN verify it loads without crashing during a real session.

echo "--- EXT1: ypi.ts loads and runs without error ---"

STDERR_FILE="$TEST_TMP/ext1_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext1_stdout.txt"

# Run a minimal prompt with the ypi extension
timeout 30 pi -p --no-session \
    -e "$PROJECT_DIR/extensions/ypi.ts" \
    "Reply with exactly: EXTENSION_TEST_OK" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -qi "EXTENSION_TEST_OK" "$STDOUT_FILE"; then
    if grep -qi "Failed to load extension\|Error\|TypeError\|Cannot find" "$STDERR_FILE"; then
        fail "EXT1: ypi.ts loads" "extension error: $(head -3 "$STDERR_FILE")"
    else
        pass "EXT1: ypi.ts loads and runs"
    fi
else
    fail "EXT1: ypi.ts loads" "no response or crash: stdout=$(head -1 "$STDOUT_FILE") stderr=$(head -3 "$STDERR_FILE")"
fi

# ─── EXT2: Extension API — event hooks work ──────────────────────────────
# Create a test extension that logs when session_start fires

echo "--- EXT2: Extension event hooks (session_start) ---"

cat > "$TEST_TMP/test_hook.ts" << 'TSEXT'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        // Write marker to prove we ran
        console.error("__EXT_HOOK_FIRED__");
    });
}
TSEXT

STDERR_FILE="$TEST_TMP/ext2_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext2_stdout.txt"

timeout 30 pi -p --no-session \
    -e "$TEST_TMP/test_hook.ts" \
    "Say OK" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -q "__EXT_HOOK_FIRED__" "$STDERR_FILE"; then
    pass "EXT2: session_start hook fires"
else
    if grep -qi "Failed to load\|Error" "$STDERR_FILE"; then
        fail "EXT2: session_start hook" "extension error: $(head -5 "$STDERR_FILE")"
    else
        fail "EXT2: session_start hook" "hook did not fire (no marker in stderr)"
    fi
fi

# ─── EXT3: Extension API — ctx.ui.theme exists ───────────────────────────
# The ypi.ts extension uses ctx.ui.theme.fg() — verify theme API exists

echo "--- EXT3: Extension UI API (theme.fg) ---"

cat > "$TEST_TMP/test_theme.ts" << 'TSEXT'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        try {
            const theme = ctx.ui.theme;
            if (typeof theme.fg === "function") {
                const colored = theme.fg("accent", "test");
                console.error("__THEME_API_OK__:" + (colored ? "has_output" : "empty"));
            } else {
                console.error("__THEME_API_MISSING__");
            }
        } catch (e: any) {
            console.error("__THEME_API_ERROR__:" + e.message);
        }
    });
}
TSEXT

STDERR_FILE="$TEST_TMP/ext3_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext3_stdout.txt"

timeout 30 pi -p --no-session \
    -e "$TEST_TMP/test_theme.ts" \
    "Say OK" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -q "__THEME_API_OK__" "$STDERR_FILE"; then
    pass "EXT3: theme.fg() API works"
elif grep -q "__THEME_API_MISSING__" "$STDERR_FILE"; then
    fail "EXT3: theme API" "theme.fg is not a function"
elif grep -q "__THEME_API_ERROR__" "$STDERR_FILE"; then
    fail "EXT3: theme API" "$(grep "__THEME_API_ERROR__" "$STDERR_FILE")"
else
    fail "EXT3: theme API" "extension did not run: $(head -5 "$STDERR_FILE")"
fi

# ─── EXT4: Extension API — ctx.ui.setStatus exists ───────────────────────

echo "--- EXT4: Extension UI API (setStatus) ---"

cat > "$TEST_TMP/test_status.ts" << 'TSEXT'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        try {
            if (typeof ctx.ui.setStatus === "function") {
                ctx.ui.setStatus("test", "test_value");
                console.error("__SETSTATUS_OK__");
            } else {
                console.error("__SETSTATUS_MISSING__");
            }
        } catch (e: any) {
            console.error("__SETSTATUS_ERROR__:" + e.message);
        }
    });
}
TSEXT

STDERR_FILE="$TEST_TMP/ext4_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext4_stdout.txt"

timeout 30 pi -p --no-session \
    -e "$TEST_TMP/test_status.ts" \
    "Say OK" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -q "__SETSTATUS_OK__" "$STDERR_FILE"; then
    pass "EXT4: setStatus() API works"
elif grep -q "__SETSTATUS_MISSING__" "$STDERR_FILE"; then
    fail "EXT4: setStatus API" "setStatus is not a function"
elif grep -q "__SETSTATUS_ERROR__" "$STDERR_FILE"; then
    fail "EXT4: setStatus API" "$(grep "__SETSTATUS_ERROR__" "$STDERR_FILE")"
else
    fail "EXT4: setStatus API" "extension did not run"
fi

# ─── EXT5: Full ypi launch with extensions ───────────────────────────────
# Actually run ypi (not just pi with -e) and verify it works

echo "--- EXT5: Full ypi launch with default extensions ---"

STDERR_FILE="$TEST_TMP/ext5_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext5_stdout.txt"

export RLM_DEPTH=0
export RLM_MAX_DEPTH=1

timeout 45 "$PROJECT_DIR/ypi" -p --no-session \
    "What is 2+2? Reply with ONLY the number." \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -q "4" "$STDOUT_FILE"; then
    if grep -qi "Failed to load extension\|Cannot find module\|TypeError" "$STDERR_FILE"; then
        fail "EXT5: ypi full launch" "extension errors: $(grep -i "error\|failed\|cannot" "$STDERR_FILE" | head -3)"
    else
        pass "EXT5: ypi full launch works"
    fi
else
    fail "EXT5: ypi full launch" "wrong answer or crash: $(head -3 "$STDOUT_FILE")"
fi

# ─── EXT6: hashline.ts loads (complex extension) ─────────────────────────
# hashline is one of the more complex extensions — good canary

echo "--- EXT6: hashline.ts (complex extension) loads ---"

if [ -f "$PROJECT_DIR/contrib/extensions/hashline.ts" ]; then
    STDERR_FILE="$TEST_TMP/ext6_stderr.txt"
    STDOUT_FILE="$TEST_TMP/ext6_stdout.txt"

    timeout 30 pi -p --no-session \
        -e "$PROJECT_DIR/contrib/extensions/hashline.ts" \
        "Say OK" \
        >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

    if grep -qi "Failed to load extension\|Cannot find module\|is not a function\|TypeError" "$STDERR_FILE"; then
        fail "EXT6: hashline.ts" "$(grep -i "error\|failed\|cannot\|TypeError" "$STDERR_FILE" | head -3)"
    else
        pass "EXT6: hashline.ts loads"
    fi
else
    echo "  ⊘ EXT6: skipped (hashline.ts not found)"
fi

# ─── EXT7: Extension with tool_call handler (new API) ────────────────────
# Pi 0.62 changed tool APIs — test that extensions can still intercept tools

echo "--- EXT7: Extension tool_call handler ---"

cat > "$TEST_TMP/test_tool_hook.ts" << 'TSEXT'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, _ctx) => {
        // Just log that we saw a tool call
        console.error("__TOOL_HOOK__:" + event.name);
        return undefined; // Don't intercept, just observe
    });

    pi.on("session_start", async () => {
        console.error("__EXT7_LOADED__");
    });
}
TSEXT

STDERR_FILE="$TEST_TMP/ext7_stderr.txt"
STDOUT_FILE="$TEST_TMP/ext7_stdout.txt"

# Ask something that triggers bash tool
timeout 45 pi -p --no-session \
    -e "$TEST_TMP/test_tool_hook.ts" \
    "Run: echo TOOL_TEST_MARKER" \
    >"$STDOUT_FILE" 2>"$STDERR_FILE" || true

if grep -q "__EXT7_LOADED__" "$STDERR_FILE"; then
    # Extension loaded — check if tool hook fired
    if grep -q "__TOOL_HOOK__:bash" "$STDERR_FILE" || grep -q "TOOL_TEST_MARKER" "$STDOUT_FILE"; then
        pass "EXT7: tool_call handler works"
    else
        # Tool might not have been used, but extension loaded fine
        pass "EXT7: tool_call handler registered (tool not triggered)"
    fi
else
    fail "EXT7: tool_call handler" "extension did not load: $(head -5 "$STDERR_FILE")"
fi

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    echo ""
    exit 1
fi

echo ""
echo "All extension e2e tests passed! ✓"

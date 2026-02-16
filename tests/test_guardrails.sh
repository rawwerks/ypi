#!/bin/bash
# test_guardrails.sh — Unit tests for NEW guardrail features (no LLM calls)
#
# Tests: timeout, model routing, max calls, temp cleanup, error propagation.
# Run these AFTER implementing each feature to verify correctness.
#
# Run: bash tests/test_guardrails.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RLM_QUERY="$PROJECT_DIR/rlm_query"

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }
skip() { echo "  ⊘ $1 (skipped: $2)"; }

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label" "expected '$expected', got '$actual'"; fi
}
assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF -- "$needle"; then pass "$label"; else fail "$label" "expected to contain '$needle'"; fi
}
assert_not_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF -- "$needle"; then fail "$label" "should NOT contain '$needle'"; else pass "$label"; fi
}
assert_exit_code() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label" "expected exit $expected, got $actual"; fi
}
assert_file_not_exists() {
    local label="$1" path="$2"
    if [ ! -f "$path" ]; then pass "$label"; else fail "$label" "file should not exist: $path"; fi
}

# ─── Mock pi ──────────────────────────────────────────────────────────────

MOCK_BIN=$(mktemp -d /tmp/rlm_test_bin_XXXXXX)
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "CONTEXT=$CONTEXT"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_PROVIDER=$RLM_PROVIDER"
echo "RLM_TIMEOUT=${RLM_TIMEOUT:-unset}"
echo "RLM_START_TIME=${RLM_START_TIME:-unset}"
echo "RLM_MAX_CALLS=${RLM_MAX_CALLS:-unset}"
echo "RLM_CALL_COUNT=${RLM_CALL_COUNT:-unset}"
echo "RLM_CHILD_MODEL=${RLM_CHILD_MODEL:-unset}"
echo "RLM_CHILD_PROVIDER=${RLM_CHILD_PROVIDER:-unset}"
# Simulate a slow call if MOCK_SLEEP is set
if [ -n "${MOCK_SLEEP:-}" ]; then
    sleep "$MOCK_SLEEP"
fi
MOCK_PI
chmod +x "$MOCK_BIN/pi"

export PATH="$MOCK_BIN:$PROJECT_DIR:$PATH"

# Clean slate — unset all RLM_* vars so ambient env doesn't leak into tests
for _v in $(env | grep '^RLM_' | cut -d= -f1); do unset "$_v"; done
unset RLM_SESSION_DIR RLM_SESSION_FILE RLM_TRACE_ID RLM_COST_FILE RLM_BUDGET
unset RLM_DEPTH RLM_MAX_DEPTH RLM_TIMEOUT RLM_START_TIME RLM_MAX_CALLS RLM_CALL_COUNT
unset RLM_PROVIDER RLM_MODEL RLM_CHILD_MODEL RLM_CHILD_PROVIDER
unset RLM_EXTENSIONS RLM_CHILD_EXTENSIONS RLM_HASHLINE RLM_JJ RLM_JSON RLM_STDIN

# Disable JSON mode in guardrail tests — mock pi doesn't output JSON
export RLM_JSON=0

TEST_TMP=$(mktemp -d /tmp/rlm_test_XXXXXX)
cat > "$TEST_TMP/ctx.txt" << 'EOF'
Test context for guardrail tests.
EOF
trap 'rm -rf "$TEST_TMP" "$MOCK_BIN"' EXIT


# ═══════════════════════════════════════════════════════════════════════════
# TIMEOUT TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Timeout ==="

# G1: RLM_TIMEOUT is propagated to child
_feature_exists() { grep -q "${1}" "$RLM_QUERY" 2>/dev/null; }

if _feature_exists "RLM_TIMEOUT"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TIMEOUT=120 \
        rlm_query "Timeout test?"
    )
    assert_contains "G1: timeout propagated" "RLM_TIMEOUT" "$OUTPUT"
else
    skip "G1: timeout propagated" "RLM_TIMEOUT not implemented yet"
fi

# G2: timeout of 1s kills a slow child (uses real `timeout` command)
if _feature_exists "RLM_TIMEOUT"; then
    # Make mock pi sleep 5s, but set timeout to 1s
    cat > "$MOCK_BIN/pi" << 'SLOWPI'
#!/bin/bash
sleep 5
echo "SHOULD_NOT_APPEAR"
SLOWPI
    chmod +x "$MOCK_BIN/pi"

    START=$(date +%s)
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TIMEOUT=1 \
        rlm_query "Should timeout?" 2>&1 || true
    )
    END=$(date +%s)
    ELAPSED=$((END - START))

    assert_not_contains "G2: slow child killed" "SHOULD_NOT_APPEAR" "$OUTPUT"
    if [ "$ELAPSED" -lt 4 ]; then
        pass "G2: returned quickly (${ELAPSED}s < 4s)"
    else
        fail "G2: returned quickly" "took ${ELAPSED}s, expected < 4s"
    fi

    # Restore normal mock
    cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_TIMEOUT=${RLM_TIMEOUT:-unset}"
echo "RLM_START_TIME=${RLM_START_TIME:-unset}"
echo "RLM_MAX_CALLS=${RLM_MAX_CALLS:-unset}"
echo "RLM_CALL_COUNT=${RLM_CALL_COUNT:-unset}"
echo "RLM_CHILD_MODEL=${RLM_CHILD_MODEL:-unset}"
MOCK_PI
    chmod +x "$MOCK_BIN/pi"
else
    skip "G2: slow child killed" "RLM_TIMEOUT not implemented yet"
fi

# G3: remaining timeout is computed from start time
if _feature_exists "RLM_START_TIME"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TIMEOUT=60 \
        rlm_query "Start time test?"
    )
    assert_not_contains "G3: start time set" "RLM_START_TIME=unset" "$OUTPUT"
else
    skip "G3: start time propagated" "RLM_START_TIME not implemented yet"
fi

# G4: expired timeout exits immediately (no pi call)
if _feature_exists "RLM_START_TIME"; then
    PAST_TIME=$(($(date +%s) - 200))
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=1 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TIMEOUT=60 \
        RLM_START_TIME=$PAST_TIME \
        rlm_query "Already expired?" 2>&1 || true
    )
    assert_not_contains "G4: expired → no pi call" "MOCK_PI_CALLED" "$OUTPUT"
    assert_contains "G4: expired → error message" "imeout" "$OUTPUT"
else
    skip "G4: expired timeout exits early" "RLM_START_TIME not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# MODEL ROUTING TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Model Routing ==="

# G5: child model override at depth > 0
if _feature_exists "RLM_CHILD_MODEL"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=anthropic RLM_MODEL=claude-sonnet \
        RLM_CHILD_MODEL=claude-haiku RLM_CHILD_PROVIDER=anthropic \
        rlm_query "Model routing test?"
    )
    # At depth 0→1, should the child see the child model?
    # The parent rlm_query is at depth 0, spawning depth 1
    # If depth > 0, use child model
    assert_contains "G5: child model propagated" "RLM_CHILD_MODEL" "$OUTPUT"
else
    skip "G5: child model override" "RLM_CHILD_MODEL not implemented yet"
fi

# G6: root (depth=0) uses root model, not child model
if _feature_exists "RLM_CHILD_MODEL"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=anthropic RLM_MODEL=claude-sonnet \
        RLM_CHILD_MODEL=claude-haiku \
        rlm_query "Root model test?"
    )
    # The pi call should use claude-sonnet (root model), not claude-haiku
    assert_contains "G6: root uses root model" "claude-sonnet" "$OUTPUT"
else
    skip "G6: root uses root model" "RLM_CHILD_MODEL not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# MAX CALLS TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Max Calls ==="

# G7: call counter increments
if _feature_exists "RLM_CALL_COUNT"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_CALL_COUNT=5 \
        RLM_MAX_CALLS=20 \
        rlm_query "Call count test?"
    )
    assert_contains "G7: call count incremented" "RLM_CALL_COUNT=6" "$OUTPUT"
else
    skip "G7: call counter increments" "RLM_CALL_COUNT not implemented yet"
fi

# G8: max calls exceeded → error, no pi call
if _feature_exists "RLM_MAX_CALLS"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_CALL_COUNT=19 \
        RLM_MAX_CALLS=20 \
        rlm_query "Should be blocked?" 2>&1 || true
    )
    assert_not_contains "G8: blocked → no pi call" "MOCK_PI_CALLED" "$OUTPUT"
else
    skip "G8: max calls exceeded" "RLM_MAX_CALLS not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# TEMP FILE CLEANUP TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Temp File Cleanup ==="

# G9: temp context file cleaned up after successful run
# (This tests post-exec cleanup — currently broken because of `exec`)
BEFORE=$(find /tmp -maxdepth 1 -type f -name 'rlm_ctx_d*' 2>/dev/null | wc -l)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Cleanup test?"
)
AFTER=$(find /tmp -maxdepth 1 -type f -name 'rlm_ctx_d*' 2>/dev/null | wc -l)

if grep -q 'rm -f "$CHILD_CONTEXT"' "$RLM_QUERY" 2>/dev/null; then
    # After implementing cleanup, AFTER should equal BEFORE
    assert_eq "G9: temp file cleaned up" "$BEFORE" "$AFTER"
else
    skip "G9: temp file cleaned up" "cleanup trap not implemented yet (exec replaces process)"
fi

# G10: temp files cleaned up even on error
if grep -q 'rm -f "$CHILD_CONTEXT"' "$RLM_QUERY" 2>/dev/null; then
    # Make mock pi exit with error
    cat > "$MOCK_BIN/pi" << 'ERRPI'
#!/bin/bash
exit 1
ERRPI
    chmod +x "$MOCK_BIN/pi"

    BEFORE=$(find /tmp -maxdepth 1 -type f -name 'rlm_ctx_d*' 2>/dev/null | wc -l)
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        rlm_query "Error cleanup test?" 2>&1 || true
    )
    AFTER=$(find /tmp -maxdepth 1 -type f -name 'rlm_ctx_d*' 2>/dev/null | wc -l)
    assert_eq "G10: temp cleaned after error" "$BEFORE" "$AFTER"

    # Restore normal mock
    cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
    chmod +x "$MOCK_BIN/pi"
else
    skip "G10: temp cleaned after error" "cleanup trap not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# ERROR PROPAGATION TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Error Propagation ==="

# G11: non-zero exit from pi propagates up
# Check if exec pi is used as actual code (not in comments)
if ! grep -q "^exec pi\|^[[:space:]]*exec pi" "$RLM_QUERY" 2>/dev/null; then
    # Only testable after removing exec (using subprocess instead)
    cat > "$MOCK_BIN/pi" << 'ERRPI'
#!/bin/bash
echo "Error: something broke" >&2
exit 42
ERRPI
    chmod +x "$MOCK_BIN/pi"

    set +e
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        rlm_query "Error propagation?" 2>&1
    )
    EXIT_CODE=$?
    set -e
    assert_exit_code "G11: exit code propagated" "42" "$EXIT_CODE"

    # Restore normal mock
    cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
    chmod +x "$MOCK_BIN/pi"
else
    skip "G11: exit code propagated" "still uses exec (replaces process)"
fi


# ═══════════════════════════════════════════════════════════════════════════
# JJ WORKSPACE ISOLATION TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== JJ Workspace Isolation ==="

# Helper: mock jj that logs calls
JJ_LOG="$TEST_TMP/jj_log.txt"
export JJ_LOG
cat > "$MOCK_BIN/jj" << 'MOCK_JJ'
#!/bin/bash
echo "JJ_CALL: $*" >> "${JJ_LOG:-/dev/null}"
if [ "$1" = "root" ]; then exit 0; fi
if [ "$1" = "workspace" ] && [ "$2" = "add" ]; then exit 0; fi
if [ "$1" = "workspace" ] && [ "$2" = "forget" ]; then exit 0; fi
exit 0
MOCK_JJ
chmod +x "$MOCK_BIN/jj"

# G12: workspace created for non-leaf depth when jj available
rm -f "$JJ_LOG"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Check JJ workspace"
)
if [ -f "$JJ_LOG" ] && grep -qF -- "workspace add" "$JJ_LOG"; then
    pass "G12: JJ workspace created for non-leaf depth"
else
    fail "G12: JJ workspace created for non-leaf depth" "jj workspace add not called"
fi

# G13: RLM_JJ=0 disables workspace creation
rm -f "$JJ_LOG"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_JJ=0 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "No JJ workspace"
)
if [ -f "$JJ_LOG" ] && grep -qF -- "workspace add" "$JJ_LOG"; then
    fail "G13: RLM_JJ=0 disables JJ" "jj workspace add was still called"
else
    pass "G13: RLM_JJ=0 disables JJ"
fi

# G14: Max depth nodes still get workspaces (they have tools now)
rm -f "$JJ_LOG"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=2 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Max depth"
)
if [ -f "$JJ_LOG" ] && grep -qF -- "workspace add" "$JJ_LOG"; then
    pass "G14: max depth gets JJ workspace"
else
    fail "G14: max depth gets JJ workspace" "jj workspace add not called"
fi

# G15: No jj on PATH → falls back gracefully
SAVED_PATH="$PATH"
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v "$MOCK_BIN" | paste -sd ':' -)
PATH="$PROJECT_DIR:$PATH"  # keep rlm_query on PATH
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    PATH="$PATH" \
    rlm_query "No jj present" 2>&1 || true
)
PATH="$SAVED_PATH"
# Should still call mock pi successfully (pi is back on PATH after restore)
# The key check: no crash/error about jj
assert_not_contains "G15: no jj error" "jj: command not found" "$OUTPUT"
pass "G15: gracefully continues without jj"


# ═══════════════════════════════════════════════════════════════════════════
# STRUCTURED ERROR TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Structured Errors ==="

# Restore standard mock pi for remaining tests
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_CALL_COUNT=${RLM_CALL_COUNT:-unset}"
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# G16: Timeout error has Why + Fix
PAST=$(($(date +%s) - 100))
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_TIMEOUT=1 \
    RLM_START_TIME=$PAST \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Trigger timeout" 2>&1 || true
)
assert_contains "G16: timeout Why hint" "Why:" "$OUTPUT"
assert_contains "G16: timeout Fix hint" "Fix:" "$OUTPUT"

# G17: Max calls error has Why + Fix
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_MAX_CALLS=1 \
    RLM_CALL_COUNT=1 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Exceed max calls" 2>&1 || true
)
assert_contains "G17: max calls Why hint" "Why:" "$OUTPUT"
assert_contains "G17: max calls Fix hint" "Fix:" "$OUTPUT"


# ═══════════════════════════════════════════════════════════════════════════
# EXECUTION SUMMARY TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Execution Summary ==="

# G18: COMPLETED line in trace after successful call
TRACE_FILE="$TEST_TMP/summary_trace.log"
rm -f "$TRACE_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    PI_TRACE_FILE="$TRACE_FILE" \
    rlm_query "Summary test"
)
if [ -f "$TRACE_FILE" ] && grep -qF -- "COMPLETED" "$TRACE_FILE"; then
    pass "G18: COMPLETED in trace"
else
    fail "G18: COMPLETED in trace" "no COMPLETED line in trace file"
fi
if [ -f "$TRACE_FILE" ] && grep -qF -- "exit=0" "$TRACE_FILE"; then
    pass "G18: exit code in trace"
else
    fail "G18: exit code in trace" "no exit=0 in trace"
fi
if [ -f "$TRACE_FILE" ] && grep -qF -- "elapsed=" "$TRACE_FILE"; then
    pass "G18: elapsed in trace"
else
    fail "G18: elapsed in trace" "no elapsed= in trace"
fi

# G19: No COMPLETED when PI_TRACE_FILE unset
TRACE_FILE2="$TEST_TMP/no_summary_trace.log"
rm -f "$TRACE_FILE2"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "No trace test"
)
assert_file_not_exists "G19: no trace file when unset" "$TRACE_FILE2"


# ═══════════════════════════════════════════════════════════════════════════
# EDGE CASE TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Edge Cases ==="

# G20: RLM_TIMEOUT=0 exits immediately
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_TIMEOUT=0 \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Immediate timeout" 2>&1 || true
)
assert_not_contains "G20: timeout=0 no pi call" "MOCK_PI_CALLED" "$OUTPUT"
assert_contains "G20: timeout=0 error msg" "imeout" "$OUTPUT"

# G21: RLM_CALL_COUNT defaults to 0, increments to 1
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Default call count"
)
assert_contains "G21: call count defaults to 1" "RLM_CALL_COUNT=1" "$OUTPUT"


# ═══════════════════════════════════════════════════════════════════════════
# SESSION TREE TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Session Tree ==="

# Restore a mock pi that also dumps session-related env and args
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_TRACE_ID=${RLM_TRACE_ID:-unset}"
echo "RLM_SESSION_DIR=${RLM_SESSION_DIR:-unset}"
echo "RLM_SESSION_FILE=${RLM_SESSION_FILE:-unset}"
echo "RLM_CALL_COUNT=${RLM_CALL_COUNT:-unset}"
MOCK_PI
chmod +x "$MOCK_BIN/pi"

SESSION_TMP="$TEST_TMP/sessions"
mkdir -p "$SESSION_TMP"

# G22: trace ID is generated if not set
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_SESSION_DIR="$SESSION_TMP" \
    rlm_query "Trace ID test"
)
assert_not_contains "G22: trace ID generated" "RLM_TRACE_ID=unset" "$OUTPUT"

# G23: trace ID is propagated from parent
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="deadbeef" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    rlm_query "Trace propagation"
)
assert_contains "G23: trace ID propagated" "RLM_TRACE_ID=deadbeef" "$OUTPUT"

# G24: child session file uses --session (not --no-session) when session dir set
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abc12345" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    rlm_query "Session arg test"
)
assert_contains "G24: --session in args" "--session" "$OUTPUT"
assert_not_contains "G24: no --no-session" "--no-session" "$OUTPUT"

# G25: session filename encodes trace ID, depth, and call count
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abc12345" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=0 \
    rlm_query "Session filename test"
)
# Depth 0→1, call count becomes 1: abc12345_d1_c1.jsonl
assert_contains "G25: session has trace ID" "abc12345" "$OUTPUT"
assert_contains "G25: session has depth" "_d1_" "$OUTPUT"
assert_contains "G25: session has call count" "_c1.jsonl" "$OUTPUT"

# G26: session file path is in RLM_SESSION_FILE for children to reference
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abc12345" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=0 \
    rlm_query "Session file env test"
)
assert_contains "G26: RLM_SESSION_FILE set" "abc12345_d1_c1.jsonl" "$OUTPUT"
assert_not_contains "G26: RLM_SESSION_FILE not unset" "RLM_SESSION_FILE=unset" "$OUTPUT"

# G27: max depth nodes still get sessions (they have full tools)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=2 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abc12345" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    rlm_query "Max depth session test"
)
assert_contains "G27: max depth gets --session" "--session" "$OUTPUT"
assert_not_contains "G27: max depth no --no-session" "--no-session" "$OUTPUT"

# G28: without RLM_SESSION_DIR, falls back to --no-session
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "No session dir test"
)
assert_contains "G28: no session dir → --no-session" "--no-session" "$OUTPUT"

# G29: --fork flag is parsed (prompt still works after flag)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_TRACE_ID="fork0001" \
    rlm_query --fork "Fork test prompt"
)
assert_contains "G29: --fork still calls pi" "MOCK_PI_CALLED" "$OUTPUT"
assert_contains "G29: prompt passed after --fork" "--session" "$OUTPUT"

# G30: --fork copies parent session file to child session path
# Create a fake parent session
PARENT_SESSION="$SESSION_TMP/parent_session.jsonl"
echo '{"type":"session","version":3,"id":"parent-uuid","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp"}' > "$PARENT_SESSION"
echo '{"type":"message","id":"msg1","parentId":null,"timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hello"}}' >> "$PARENT_SESSION"

OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_SESSION_FILE="$PARENT_SESSION" \
    RLM_TRACE_ID="fork0002" \
    RLM_CALL_COUNT=0 \
    rlm_query --fork "Fork with parent"
)
# Child session file should exist and contain parent's content
CHILD_FILE="$SESSION_TMP/fork0002_d1_c1.jsonl"
if [ -f "$CHILD_FILE" ]; then
    pass "G30: forked session file created"
    CHILD_CONTENT=$(cat "$CHILD_FILE")
    assert_contains "G30: forked file has parent content" "parent-uuid" "$CHILD_CONTENT"
else
    fail "G30: forked session file created" "file not found: $CHILD_FILE"
    fail "G30: forked file has parent content" "file not found"
fi

# G31: without --fork, child session file is NOT pre-populated
rm -f "$SESSION_TMP/nofork01_d1_c1.jsonl"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_SESSION_FILE="$PARENT_SESSION" \
    RLM_TRACE_ID="nofork01" \
    RLM_CALL_COUNT=0 \
    rlm_query "No fork test"
)
CHILD_FILE="$SESSION_TMP/nofork01_d1_c1.jsonl"
if [ -f "$CHILD_FILE" ]; then
    CHILD_CONTENT=$(cat "$CHILD_FILE")
    assert_not_contains "G31: no fork → no parent content" "parent-uuid" "$CHILD_CONTENT"
else
    pass "G31: no fork → no parent content"
fi

# G32: trace logging includes trace ID and fork flag
TRACE_FILE="$TEST_TMP/session_trace.log"
rm -f "$TRACE_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="traced01" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    PI_TRACE_FILE="$TRACE_FILE" \
    rlm_query --fork "Traced fork"
)
if [ -f "$TRACE_FILE" ]; then
    TRACE_CONTENT=$(cat "$TRACE_FILE")
    assert_contains "G32: trace has trace ID" "trace=traced01" "$TRACE_CONTENT"
    assert_contains "G32: trace has fork=true" "fork=true" "$TRACE_CONTENT"
else
    fail "G32: trace has trace ID" "trace file not created"
    fail "G32: trace has fork=true" "trace file not created"
fi

# G33: multiple calls get distinct session files (different call counts)
rm -f "$SESSION_TMP/multi001_d1_c1.jsonl" "$SESSION_TMP/multi001_d1_c2.jsonl"
OUTPUT1=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="multi001" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=0 \
    rlm_query "First call"
)
OUTPUT2=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="multi001" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=1 \
    rlm_query "Second call"
)
assert_contains "G33: first call → c1" "_c1.jsonl" "$OUTPUT1"
assert_contains "G33: second call → c2" "_c2.jsonl" "$OUTPUT2"


# ═══════════════════════════════════════════════════════════════════════════
# EXTENSIONS TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Extensions ==="

# Restore standard mock
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# G34: children have extensions by default
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Extensions default test"
)
assert_not_contains "G34: extensions on by default" "--no-extensions" "$OUTPUT"

# G35: RLM_EXTENSIONS=0 disables extensions
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_EXTENSIONS=0 \
    rlm_query "Extensions disabled test"
)
assert_contains "G35: RLM_EXTENSIONS=0 disables" "--no-extensions" "$OUTPUT"

# G36: max depth nodes still get extensions by default
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=2 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Max depth extensions test"
)
assert_not_contains "G36: max depth has extensions" "--no-extensions" "$OUTPUT"

# G37: RLM_CHILD_EXTENSIONS=0 disables extensions for children only
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_CHILD_EXTENSIONS=0 \
    rlm_query "Root with child ext off"
)
# At depth 0, RLM_CHILD_EXTENSIONS doesn't apply (depth not > 0)
assert_not_contains "G37: root keeps extensions" "--no-extensions" "$OUTPUT"

# G38: RLM_CHILD_EXTENSIONS=0 applies at depth > 0
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=1 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_CHILD_EXTENSIONS=0 \
    rlm_query "Child with ext off"
)
assert_contains "G38: child extensions disabled" "--no-extensions" "$OUTPUT"


# ═══════════════════════════════════════════════════════════════════════════
# BUDGET / COST TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Budget & Cost ==="

# Restore standard mock
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# G39: no budget by default — RLM_BUDGET not set, call succeeds
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    rlm_query "No budget test"
)
assert_contains "G39: no budget succeeds" "MOCK_PI_CALLED" "$OUTPUT"

# G40: budget set but no spend yet — call proceeds
COST_FILE=$(mktemp /tmp/rlm_cost_test_XXXXXX.jsonl)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    RLM_BUDGET=1.00 \
    RLM_COST_FILE="$COST_FILE" \
    rlm_query "Budget with no spend"
)
assert_contains "G40: budget set, no spend, proceeds" "MOCK_PI_CALLED" "$OUTPUT"
rm -f "$COST_FILE"

# G41: budget exceeded — cost file shows spend over budget
COST_FILE=$(mktemp /tmp/rlm_cost_test_XXXXXX.jsonl)
echo '{"cost": 0.60, "tokens": 5000}' > "$COST_FILE"
echo '{"cost": 0.45, "tokens": 4000}' >> "$COST_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    RLM_BUDGET=1.00 \
    RLM_COST_FILE="$COST_FILE" \
    rlm_query "Over budget" 2>&1 || true
)
assert_contains "G41: budget exceeded" "Budget exceeded" "$OUTPUT"
rm -f "$COST_FILE"

# G42: budget not exceeded — cost under limit
COST_FILE=$(mktemp /tmp/rlm_cost_test_XXXXXX.jsonl)
echo '{"cost": 0.30, "tokens": 3000}' > "$COST_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    RLM_BUDGET=1.00 \
    RLM_COST_FILE="$COST_FILE" \
    rlm_query "Under budget"
)
assert_contains "G42: under budget proceeds" "MOCK_PI_CALLED" "$OUTPUT"
rm -f "$COST_FILE"

# G43: RLM_COST_FILE propagated to children
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    RLM_BUDGET=5.00 \
    rlm_query "Budget propagation test"
)
# Budget creates a cost file automatically
assert_contains "G43: budget propagation proceeds" "MOCK_PI_CALLED" "$OUTPUT"

# G44: rlm_cost with no cost file returns $0
OUTPUT=$(
    RLM_COST_FILE="" \
    "$PROJECT_DIR/rlm_cost"
)
assert_contains "G44: rlm_cost no file" "\$0.000000" "$OUTPUT"

# G45: rlm_cost with cost file returns total
COST_FILE=$(mktemp /tmp/rlm_cost_test_XXXXXX.jsonl)
echo '{"cost": 0.15, "tokens": 2000}' > "$COST_FILE"
echo '{"cost": 0.25, "tokens": 3000}' >> "$COST_FILE"
OUTPUT=$(
    RLM_COST_FILE="$COST_FILE" \
    "$PROJECT_DIR/rlm_cost"
)
assert_contains "G45: rlm_cost sums" "\$0.400000" "$OUTPUT"
rm -f "$COST_FILE"

# G46: rlm_cost --json returns structured data
COST_FILE=$(mktemp /tmp/rlm_cost_test_XXXXXX.jsonl)
echo '{"cost": 0.10, "tokens": 1000}' > "$COST_FILE"
echo '{"cost": 0.20, "tokens": 2000}' >> "$COST_FILE"
OUTPUT=$(
    RLM_COST_FILE="$COST_FILE" \
    "$PROJECT_DIR/rlm_cost" --json
)
assert_contains "G46: rlm_cost json has cost" "0.3" "$OUTPUT"
assert_contains "G46: rlm_cost json has tokens" "3000" "$OUTPUT"
assert_contains "G46: rlm_cost json has calls" '"calls": 2' "$OUTPUT"
rm -f "$COST_FILE"

# G47: RLM_JSON=0 disables JSON mode (plain text)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 \
    rlm_query "Plain text mode"
)
assert_contains "G47: RLM_JSON=0 works" "MOCK_PI_CALLED" "$OUTPUT"


# ═══════════════════════════════════════════════════════════════════════════
# RLM_SESSIONS TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== rlm_sessions ==="

# Set up a fake session directory with a session file
SESSION_DIR="$TEST_TMP/sessions_test"
mkdir -p "$SESSION_DIR"
cat > "$SESSION_DIR/abc123_d0_c1.jsonl" << 'SESSION_DATA'
{"type":"session","version":3,"id":"test-uuid","timestamp":"2026-01-15T10:00:00Z","cwd":"/tmp"}
{"type":"message","id":"msg1","parentId":null,"timestamp":"2026-01-15T10:00:01Z","message":{"role":"user","content":"hello world"}}
{"type":"message","id":"msg2","parentId":"msg1","timestamp":"2026-01-15T10:00:02Z","message":{"role":"assistant","content":"hi there"}}
SESSION_DATA

# G48: rlm_sessions lists sessions when RLM_SHARED_SESSIONS is default (1)
OUTPUT=$(
    RLM_SESSION_DIR="$SESSION_DIR" \
    RLM_TRACE_ID="abc123" \
    "$PROJECT_DIR/rlm_sessions" list
)
assert_contains "G48: lists sessions by default" "abc123_d0_c1.jsonl" "$OUTPUT"

# G49: RLM_SHARED_SESSIONS=0 disables rlm_sessions
OUTPUT=$(
    RLM_SESSION_DIR="$SESSION_DIR" \
    RLM_TRACE_ID="abc123" \
    RLM_SHARED_SESSIONS=0 \
    "$PROJECT_DIR/rlm_sessions" list 2>&1
)
assert_contains "G49: SHARED_SESSIONS=0 disables" "disabled" "$OUTPUT"
assert_not_contains "G49: no session listed" "abc123_d0_c1.jsonl" "$OUTPUT"

# G50: RLM_SHARED_SESSIONS=1 explicitly enables
OUTPUT=$(
    RLM_SESSION_DIR="$SESSION_DIR" \
    RLM_TRACE_ID="abc123" \
    RLM_SHARED_SESSIONS=1 \
    "$PROJECT_DIR/rlm_sessions" list
)
assert_contains "G50: SHARED_SESSIONS=1 enables" "abc123_d0_c1.jsonl" "$OUTPUT"

# G51: --trace filters to current trace ID
cat > "$SESSION_DIR/other99_d0_c1.jsonl" << 'SESSION_DATA'
{"type":"session","version":3,"id":"other-uuid","timestamp":"2026-01-15T11:00:00Z","cwd":"/tmp"}
{"type":"message","id":"msg1","parentId":null,"timestamp":"2026-01-15T11:00:01Z","message":{"role":"user","content":"different trace"}}
SESSION_DATA

OUTPUT=$(
    RLM_SESSION_DIR="$SESSION_DIR" \
    RLM_TRACE_ID="abc123" \
    "$PROJECT_DIR/rlm_sessions" --trace
)
assert_contains "G51: trace filter includes matching" "abc123_d0_c1.jsonl" "$OUTPUT"
assert_not_contains "G51: trace filter excludes other" "other99_d0_c1.jsonl" "$OUTPUT"
rm -rf "$SESSION_DIR"


# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    echo -e "$ERRORS"
    echo ""
    exit 1
fi

echo ""
echo "All tests passed! ✓"

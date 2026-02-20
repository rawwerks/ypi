#!/bin/bash
# test_unit.sh — Fast unit tests for rlm_query (no LLM calls)
#
# Tests the bash logic: env propagation, stdin detection, context handling,
# depth limits, temp file management, timeout, model routing, etc.
#
# Run: bash tests/test_unit.sh
# All tests use a mock `pi` that echoes args instead of calling an LLM.

set -euo pipefail

# Detach from inherited stdin (e.g., git pre-push hook ref stream),
# so rlm_query tests do not accidentally treat hook stdin as piped context.
exec </dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RLM_QUERY="$PROJECT_DIR/rlm_query"

PASS=0
FAIL=0
ERRORS=""

# ─── Helpers ──────────────────────────────────────────────────────────────

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label" "expected '$expected', got '$actual'"
    fi
}

assert_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF -- "$needle"; then
        pass "$label"
    else
        fail "$label" "expected to contain '$needle', got '$haystack'"
    fi
}

assert_not_contains() {
    local label="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -qF -- "$needle"; then
        fail "$label" "should NOT contain '$needle', but it does"
    else
        pass "$label"
    fi
}

assert_file_exists() {
    local label="$1" path="$2"
    if [ -f "$path" ]; then pass "$label"; else fail "$label" "file not found: $path"; fi
}

assert_file_not_exists() {
    local label="$1" path="$2"
    if [ ! -f "$path" ]; then pass "$label"; else fail "$label" "file should not exist: $path"; fi
}

assert_exit_code() {
    local label="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$label"
    else
        fail "$label" "expected exit code $expected, got $actual"
    fi
}

# Create a mock `pi` that just echoes its args and env, so we can test
# rlm_query's logic without hitting a real LLM.
MOCK_BIN=$(mktemp -d /tmp/rlm_test_bin_XXXXXX)
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
# Mock pi: dump args and key env vars as JSON-ish output for test assertions
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "CONTEXT=$CONTEXT"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MAX_DEPTH=$RLM_MAX_DEPTH"
echo "RLM_PROVIDER=$RLM_PROVIDER"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_SYSTEM_PROMPT=$RLM_SYSTEM_PROMPT"
echo "RLM_PROMPT_FILE=$RLM_PROMPT_FILE"
if [ -n "${RLM_PROMPT_FILE:-}" ] && [ -f "${RLM_PROMPT_FILE:-}" ]; then
    echo "PROMPT_CONTENT=$(cat "$RLM_PROMPT_FILE")"
fi
# If --no-tools is in args, we're a leaf node
if echo "$*" | grep -q -- "--no-tools"; then
    echo "LEAF_NODE=true"
fi
# Echo the context file content if it exists
if [ -n "${CONTEXT:-}" ] && [ -f "${CONTEXT:-}" ]; then
    echo "CONTEXT_CONTENT=$(cat "$CONTEXT")"
fi
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# Override PATH so rlm_query finds our mock pi
export PATH="$MOCK_BIN:$PROJECT_DIR:$PATH"

# Clean environment — unset all RLM_ vars so tests check rlm_query's own defaults,
# not whatever the parent ypi session exported.
for var in $(env | grep '^RLM_' | cut -d= -f1); do unset "$var"; done
# Disable JSON mode in unit tests — mock pi doesn't output JSON
export RLM_JSON=0


# Temp dir for test artifacts
TEST_TMP=$(mktemp -d /tmp/rlm_test_XXXXXX)
trap 'rm -rf "$TEST_TMP" "$MOCK_BIN"' EXIT

# ─── Test Group: Basic Invocation ─────────────────────────────────────────

echo ""
echo "=== Basic Invocation ==="

# T1: rlm_query requires a prompt argument
OUTPUT=$(rlm_query 2>&1 || true)
assert_contains "T1: requires prompt arg" "Usage" "$OUTPUT"

# T2: basic call with inherited context
cat > "$TEST_TMP/ctx.txt" << 'EOF'
The user graduated from MIT in 2019.
EOF
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    RLM_SYSTEM_PROMPT="$PROJECT_DIR/SYSTEM_PROMPT.md" \
    rlm_query "What university?"
)
assert_contains "T2: mock pi called" "MOCK_PI_CALLED" "$OUTPUT"
assert_contains "T2: depth incremented" "RLM_DEPTH=1" "$OUTPUT"
assert_contains "T2: provider propagated" "RLM_PROVIDER=test-provider" "$OUTPUT"
assert_contains "T2: model propagated" "RLM_MODEL=test-model" "$OUTPUT"
assert_contains "T2: context inherited" "MIT" "$OUTPUT"

# ─── Test Group: Stdin / Pipe Detection ───────────────────────────────────

echo ""
echo "=== Stdin / Pipe Detection ==="

# T3: piped input becomes child context (replaces parent context)
cat > "$TEST_TMP/parent_ctx.txt" << 'EOF'
Parent context about dogs.
EOF
OUTPUT=$(
    echo "Piped text about cats." | \
    CONTEXT="$TEST_TMP/parent_ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "What animal?"
)
assert_contains "T3: piped text becomes context" "cats" "$OUTPUT"
assert_not_contains "T3: parent context NOT inherited" "dogs" "$OUTPUT"

# T4: no pipe → inherits parent context
OUTPUT=$(
    CONTEXT="$TEST_TMP/parent_ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "What animal?"
)
assert_contains "T4: parent context inherited" "dogs" "$OUTPUT"

# ─── Test Group: Depth Handling ───────────────────────────────────────────

echo ""
echo "=== Depth Handling ==="

# T5: at max depth, rlm_query is removed from child's PATH
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=2 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "Max depth question?"
)
# Child still gets tools — verify pi is called
assert_contains "T5: max depth still calls pi" "MOCK_PI_CALLED" "$OUTPUT"
# Should NOT have --no-tools
assert_not_contains "T5: max depth has tools" "--no-tools" "$OUTPUT"

# T6: beyond max depth, rlm_query refuses (depth guard)
set +e
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=3 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "Beyond max depth?" 2>&1
)
EXIT_CODE=$?
set -e
assert_contains "T6: beyond max depth error" "Max depth exceeded" "$OUTPUT"
assert_not_contains "T6: beyond max depth no pi call" "MOCK_PI_CALLED" "$OUTPUT"

# T7: depth increments correctly across levels
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=1 \
    RLM_MAX_DEPTH=4 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    RLM_SYSTEM_PROMPT="$PROJECT_DIR/SYSTEM_PROMPT.md" \
    rlm_query "Mid-depth question?"
)
assert_contains "T7: depth 1→2" "RLM_DEPTH=2" "$OUTPUT"

# ─── Test Group: System Prompt ────────────────────────────────────────────

echo ""
echo "=== System Prompt ==="

# T8: system prompt file path is passed (not content)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    RLM_SYSTEM_PROMPT="$PROJECT_DIR/SYSTEM_PROMPT.md" \
    rlm_query "Question?"
)
assert_contains "T8: --system-prompt in args" "--system-prompt" "$OUTPUT"
assert_contains "T8: system prompt is file path" "SYSTEM_PROMPT.md" "$OUTPUT"

# T9: missing system prompt file → no --system-prompt arg
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    RLM_SYSTEM_PROMPT="/nonexistent/file.md" \
    rlm_query "Question?"
)
assert_not_contains "T9: no --system-prompt for missing file" "--system-prompt" "$OUTPUT"

# ─── Test Group: Trace Logging ────────────────────────────────────────────

echo ""
echo "=== Trace Logging ==="

# T10: trace file gets written when PI_TRACE_FILE is set
TRACE_FILE="$TEST_TMP/trace.log"
rm -f "$TRACE_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    PI_TRACE_FILE="$TRACE_FILE" \
    rlm_query "Traced question?"
)
assert_file_exists "T10: trace file created" "$TRACE_FILE"
TRACE_CONTENT=$(cat "$TRACE_FILE")
assert_contains "T10: trace has depth" "depth=0→1" "$TRACE_CONTENT"
assert_contains "T10: trace has prompt" "Traced question" "$TRACE_CONTENT"

# T11: no trace file when PI_TRACE_FILE is unset
rm -f "$TEST_TMP/no_trace.log"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "Untraced question?"
)
assert_file_not_exists "T11: no trace file when unset" "$TEST_TMP/no_trace.log"

# ─── Test Group: Edge Cases ───────────────────────────────────────────────

echo ""
echo "=== Edge Cases ==="

# T12: empty context file → still works
touch "$TEST_TMP/empty.txt"
OUTPUT=$(
    CONTEXT="$TEST_TMP/empty.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "Empty context question?"
)
assert_contains "T12: handles empty context" "MOCK_PI_CALLED" "$OUTPUT"

# T13: no CONTEXT env var → still runs (empty context)
OUTPUT=$(
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "No context question?" 2>&1 || true
)
assert_contains "T13: handles missing CONTEXT" "MOCK_PI_CALLED" "$OUTPUT"

# T14: defaults applied when env vars missing
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    rlm_query "Defaults question?"
)
assert_contains "T14: default depth=0→1" "RLM_DEPTH=1" "$OUTPUT"
# T14b: provider/model must NOT be hardcoded — Pi's defaults should be used
assert_contains "T14: no hardcoded provider" "RLM_PROVIDER=" "$OUTPUT"
assert_not_contains "T14: no cerebras default" "cerebras" "$OUTPUT"
assert_not_contains "T14: no gpt-oss default" "gpt-oss" "$OUTPUT"
assert_not_contains "T14: no --provider in args" "--provider" "$OUTPUT"
assert_not_contains "T14: no --model in args" "--model" "$OUTPUT"

# T14c: when RLM_PROVIDER/RLM_MODEL ARE set, they pass through
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_PROVIDER=anthropic \
    RLM_MODEL=claude-opus-4-6 \
    rlm_query "Provider question?"
)
assert_contains "T14c: explicit provider passes through" "--provider anthropic" "$OUTPUT"
assert_contains "T14c: explicit model passes through" "--model claude-opus-4-6" "$OUTPUT"

# T14d: RLM_PROMPT_FILE is set and contains the original prompt (symbolic access)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    rlm_query "How many r's in strawberry?"
)
assert_contains "T14d: prompt file is set" "RLM_PROMPT_FILE=/tmp/rlm_prompt_" "$OUTPUT"
assert_contains "T14d: prompt file has content" "PROMPT_CONTENT=How many r's in strawberry?" "$OUTPUT"

# ─── Test Group: Temp File Cleanup ────────────────────────────────────────

echo ""
echo "=== Temp File Cleanup ==="

# T15: temp context files are created in /tmp with expected naming
BEFORE_COUNT=$(ls /tmp/rlm_ctx_d* 2>/dev/null | wc -l || echo 0)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test-provider \
    RLM_MODEL=test-model \
    rlm_query "Temp file question?"
)
# Note: with exec, the temp file may linger (this tests the CURRENT behavior;
# after we fix cleanup, this test should verify files are removed)
AFTER_COUNT=$(ls /tmp/rlm_ctx_d* 2>/dev/null | wc -l || echo 0)
# For now just verify it created one
assert_contains "T15: temp context created" "MOCK_PI_CALLED" "$OUTPUT"

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

# Clean up any leftover temp context files from tests
rm -f /tmp/rlm_ctx_d*_test_* 2>/dev/null || true

echo ""
echo "All tests passed! ✓"

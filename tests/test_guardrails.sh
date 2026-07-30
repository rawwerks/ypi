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
assert_file_exists() {
    local label="$1" path="$2"
    if [ -f "$path" ]; then pass "$label"; else fail "$label" "file should exist: $path"; fi
}
assert_file_not_exists() {
    local label="$1" path="$2"
    if [ ! -f "$path" ]; then pass "$label"; else fail "$label" "file should not exist: $path"; fi
}

# ─── Mock pi ──────────────────────────────────────────────────────────────

MOCK_BIN=$(mktemp -d "${TMPDIR:-/tmp}/rlm_test_bin.XXXXXX")
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "CONTEXT=$CONTEXT"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
echo "RLM_PROVIDER=$RLM_PROVIDER"
echo "RLM_THINKING_LEVEL=${RLM_THINKING_LEVEL:-unset}"
echo "RLM_TIMEOUT=${RLM_TIMEOUT:-unset}"
echo "RLM_START_TIME=${RLM_START_TIME:-unset}"
echo "RLM_MAX_CALLS=${RLM_MAX_CALLS:-unset}"
echo "RLM_CALL_COUNT=${RLM_CALL_COUNT:-unset}"
echo "RLM_CHILD_MODEL=${RLM_CHILD_MODEL:-unset}"
echo "RLM_CHILD_PROVIDER=${RLM_CHILD_PROVIDER:-unset}"
echo "RLM_CHILD_MODELS=${RLM_CHILD_MODELS:-unset}"
echo "RLM_CHILD_PROVIDERS=${RLM_CHILD_PROVIDERS:-unset}"
echo "RLM_CHILD_THINKING_LEVEL=${RLM_CHILD_THINKING_LEVEL:-unset}"
echo "RLM_CHILD_THINKING_LEVELS=${RLM_CHILD_THINKING_LEVELS:-unset}"
echo "RLM_TRACE_ID=${RLM_TRACE_ID:-unset}"
echo "RLM_SESSION_FILE=${RLM_SESSION_FILE:-unset}"
# Simulate a slow call if MOCK_SLEEP is set
if [ -n "${MOCK_SLEEP:-}" ]; then
    sleep "$MOCK_SLEEP"
fi
MOCK_PI
chmod +x "$MOCK_BIN/pi"

export PATH="$MOCK_BIN:$PROJECT_DIR:$PATH"

# Clean slate — unset inherited ypi/rlm vars so ambient live-session env doesn't
# bypass the mock or leak into tests.
for _v in $(env | grep '^RLM_' | cut -d= -f1); do unset "$_v"; done
for _v in $(env | grep '^YPI_' | cut -d= -f1); do unset "$_v"; done
unset RLM_SESSION_DIR RLM_SESSION_FILE RLM_TRACE_ID RLM_COST_FILE RLM_BUDGET
unset RLM_DEPTH RLM_MAX_DEPTH RLM_TIMEOUT RLM_START_TIME RLM_MAX_CALLS RLM_CALL_COUNT
unset RLM_PROVIDER RLM_MODEL RLM_THINKING_LEVEL RLM_CHILD_MODEL RLM_CHILD_PROVIDER
unset RLM_CHILD_MODELS RLM_CHILD_PROVIDERS RLM_CHILD_THINKING_LEVEL RLM_CHILD_THINKING_LEVELS
unset RLM_EXTENSIONS RLM_CHILD_EXTENSIONS RLM_CHILD_DISCOVERY RLM_HASHLINE RLM_JSON RLM_STDIN
# Force rlm_query to use the mock even when a parent ypi session exported
# YPI_PI_BIN to a real pi binary.
export YPI_PI_BIN="$MOCK_BIN/pi"

# Disable JSON mode for ordinary guardrail probes.
export RLM_JSON=0

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/rlm_test.XXXXXX")
export TMPDIR="$TEST_TMP"
TREE_AUTHORITY_RUNNER="$PROJECT_DIR/tests/tree_authority_runner.ts"
with_tree_authority() {
    local depth="$1"
    shift
    bun "$TREE_AUTHORITY_RUNNER" "$depth" -- "$@"
}
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
_feature_exists() {
    grep -q "${1}" \
        "$RLM_QUERY" \
        "$PROJECT_DIR/extensions/ypi/cli.ts" \
        "$PROJECT_DIR/extensions/ypi/runtime-core.ts" \
        "$PROJECT_DIR/extensions/ypi/guardrails.ts" \
        "$PROJECT_DIR/extensions/ypi/env.ts" \
        "$PROJECT_DIR/extensions/ypi/internal/"*.ts 2>/dev/null
}

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

# G4b: depth-0 timeout starts at CLI invocation, including stdin spooling, and
# preflight timeout has the conventional exit status 124.
STDIN_FIFO="$TEST_TMP/open-stdin.fifo"
mkfifo "$STDIN_FIFO"
( exec 3>"$STDIN_FIFO"; sleep 30 ) &
STDIN_WRITER_PID=$!
START_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
set +e
	OUTPUT=$(
	    env RLM_STDIN=1 RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_TIMEOUT=1 \
	        RLM_CALL_COUNTER_FILE="$TEST_TMP/stdin-timeout.counter" \
	        rlm_query "Open input must obey timeout" <"$STDIN_FIFO" 2>&1
	)
STDIN_TIMEOUT_RC=$?
set -e
END_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
kill "$STDIN_WRITER_PID" 2>/dev/null || true
wait "$STDIN_WRITER_PID" 2>/dev/null || true
rm -f "$STDIN_FIFO"
STDIN_TIMEOUT_MS=$(( (END_NS - START_NS) / 1000000 ))
assert_eq "G4b: stdin/setup timeout exits 124" "124" "$STDIN_TIMEOUT_RC"
assert_not_contains "G4b: expired stdin budget spawns no child" "MOCK_PI_CALLED" "$OUTPUT"
assert_contains "G4b: expired stdin budget is explicit" "Timeout exceeded" "$OUTPUT"
if [ "$STDIN_TIMEOUT_MS" -lt 1800 ]; then pass "G4b: active deadline interrupts an open stdin pipe"; else fail "G4b: active deadline interrupts an open stdin pipe" "elapsed=${STDIN_TIMEOUT_MS}ms"; fi

# G4c: read-only review never invokes Git workspace setup, so a slow or broken
# VCS command cannot delay normal recursion or change repository state.
cat > "$MOCK_BIN/git" <<'SLOWGIT'
#!/bin/bash
printf 'unexpected git call\n' >> "$YPI_GIT_REGISTRY_FILE"
sleep 30
SLOWGIT
chmod +x "$MOCK_BIN/git"
START_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
OUTPUT=$(
	    CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
	    RLM_CALL_COUNTER_FILE="$TEST_TMP/git-review.counter" YPI_GIT_REGISTRY_FILE="$TEST_TMP/git-registry" \
	    rlm_query "Read-only review skips workspace setup" 2>&1
)
END_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
GIT_REVIEW_MS=$(( (END_NS - START_NS) / 1000000 ))
rm -f "$MOCK_BIN/git"
assert_contains "G4c: read-only review still runs child" "MOCK_PI_CALLED" "$OUTPUT"
if [ -e "$TEST_TMP/git-registry" ]; then fail "G4c: read-only review never invokes Git" "git was called"; else pass "G4c: read-only review never invokes Git"; fi
if [ "$GIT_REVIEW_MS" -lt 3000 ]; then pass "G4c: unavailable Git adds no review delay"; else fail "G4c: unavailable Git adds no review delay" "elapsed=${GIT_REVIEW_MS}ms"; fi

# G4d moved to concurrency_harness.ts: the coordinator queue, rather than an
# ownerless filesystem lock, must obey the tree deadline and fail with 124.


# ═══════════════════════════════════════════════════════════════════════════
# MODEL ROUTING TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Model Routing ==="

# G5: child model override applies to root-to-child calls
if _feature_exists "RLM_CHILD_MODEL"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=anthropic RLM_MODEL=claude-sonnet \
        RLM_CHILD_MODEL=claude-haiku RLM_CHILD_PROVIDER=anthropic \
        rlm_query "Model routing test?"
    )
    assert_contains "G5: root-to-child uses child model" "--model claude-haiku" "$OUTPUT"
    assert_contains "G5: root-to-child uses child provider" "--provider anthropic" "$OUTPUT"
else
    skip "G5: child model override" "RLM_CHILD_MODEL not implemented yet"
fi

# G6: root model is used when no child override is set
if _feature_exists "RLM_CHILD_MODEL"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=anthropic RLM_MODEL=claude-sonnet RLM_THINKING_LEVEL=xhigh \
        rlm_query "Root model test without child override?"
    )
    assert_contains "G6: root model passes through without override" "--model claude-sonnet" "$OUTPUT"
    assert_contains "G6: root thinking passes through without override" "--thinking xhigh" "$OUTPUT"
else
    skip "G6: root uses root model" "RLM_CHILD_MODEL not implemented yet"
fi

# G6b: per-depth child model/thinking lists override by child depth
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=openai RLM_MODEL=gpt-5.5:xhigh RLM_THINKING_LEVEL=xhigh \
    RLM_CHILD_MODELS='gpt-5.5:high,gpt-5.5:medium' \
    RLM_CHILD_THINKING_LEVELS='high,medium' \
    with_tree_authority 1 rlm_query "Depth-specific model routing?"
)
assert_contains "G6b: second-depth model selected" "--model gpt-5.5:medium" "$OUTPUT"
assert_contains "G6b: second-depth thinking selected" "--thinking medium" "$OUTPUT"
assert_contains "G6b: provider inherited" "--provider openai" "$OUTPUT"


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

# G8: the (N+1)th call is blocked → error, no pi call
if _feature_exists "RLM_MAX_CALLS"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_CALL_COUNT=20 \
        RLM_MAX_CALLS=20 \
        rlm_query "Should be blocked?" 2>&1 || true
    )
    assert_not_contains "G8: blocked → no pi call" "MOCK_PI_CALLED" "$OUTPUT"
    assert_contains "G8: blocked → error message" "Max calls exceeded" "$OUTPUT"
else
    skip "G8: max calls exceeded" "RLM_MAX_CALLS not implemented yet"
fi

# G8b: RLM_MAX_CALLS=N permits exactly N calls (the boundary call is allowed)
if _feature_exists "RLM_MAX_CALLS"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_CALL_COUNT=0 \
        RLM_MAX_CALLS=1 \
        rlm_query "First call allowed?" 2>&1 || true
    )
    assert_contains "G8b: RLM_MAX_CALLS=1 allows the first call" "MOCK_PI_CALLED" "$OUTPUT"
else
    skip "G8b: max calls boundary" "RLM_MAX_CALLS not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# TEMP FILE CLEANUP TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Temp File Cleanup ==="

# G9: canonical context-resource directories are cleaned after successful runs.
BEFORE=$(find "$TMPDIR" -maxdepth 1 -type d -name 'ypi_ctx_*' 2>/dev/null | wc -l)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Cleanup test?"
)
AFTER=$(find "$TMPDIR" -maxdepth 1 -type d -name 'ypi_ctx_*' 2>/dev/null | wc -l)
assert_eq "G9: temp file cleaned up" "$BEFORE" "$AFTER"

# G10: canonical resources are cleaned even when child execution fails.
cat > "$MOCK_BIN/pi" << 'ERRPI'
#!/bin/bash
exit 1
ERRPI
chmod +x "$MOCK_BIN/pi"

BEFORE=$(find "$TMPDIR" -maxdepth 1 -type d -name 'ypi_ctx_*' 2>/dev/null | wc -l)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Error cleanup test?" 2>&1 || true
)
AFTER=$(find "$TMPDIR" -maxdepth 1 -type d -name 'ypi_ctx_*' 2>/dev/null | wc -l)
assert_eq "G10: temp cleaned after error" "$BEFORE" "$AFTER"

# G10b: age is not authority to destroy generic runtime state. Both dry-run and
# forced cleanup preserve untyped paths and leave the real repository untouched.
CLEANUP_CWD="$TEST_TMP/cleanup-cwd"
mkdir "$CLEANUP_CWD"
CLEANUP_REAL_STATUS_BEFORE=$(git -C "$PROJECT_DIR" status --porcelain=v2 --untracked-files=all)
CLEANUP_REAL_WORKTREES_BEFORE=$(git -C "$PROJECT_DIR" worktree list --porcelain)
CLEANUP_REAL_REFS_BEFORE=$(git -C "$PROJECT_DIR" for-each-ref --format='%(refname) %(objectname)' refs/ypi/)
ASYNC_OWNED="$TMPDIR/rlm_async_cleanup_ABC123"
ASYNC_LOOKALIKE="$TMPDIR/rlm_async_unrelated_DEF456"
STALE_COUNTER_LOCK="$TMPDIR/rlm_calls_cleanup.counter.lock"
mkdir -p "$ASYNC_OWNED" "$ASYNC_LOOKALIKE" "$STALE_COUNTER_LOCK"
printf '%s\n' done > "$ASYNC_OWNED/output.txt"
printf '%s\n' keep > "$ASYNC_LOOKALIKE/unrelated.txt"
touch -d '3 hours ago' "$ASYNC_OWNED" "$ASYNC_LOOKALIKE" "$STALE_COUNTER_LOCK"
CLEANUP_DRY=$(cd "$CLEANUP_CWD" && TMPDIR="$TMPDIR" "$PROJECT_DIR/rlm_cleanup" --age 60)
assert_contains "G10b: cleanup publishes conservative authority policy" "Generic temp, call-counter, async, and legacy workspace paths: preserved (age is not deletion authority)" "$CLEANUP_DRY"
if [ -d "$ASYNC_OWNED" ] && [ -d "$ASYNC_LOOKALIKE" ] && [ -d "$STALE_COUNTER_LOCK" ]; then pass "G10b: cleanup dry-run preserves untyped runtime state"; else fail "G10b: cleanup dry-run preserves untyped runtime state" "runtime state removed"; fi
CLEANUP_FORCED=$(cd "$CLEANUP_CWD" && TMPDIR="$TMPDIR" "$PROJECT_DIR/rlm_cleanup" --age 60 --force)
assert_contains "G10b: forced cleanup retains conservative authority policy" "Generic temp, call-counter, async, and legacy workspace paths: preserved (age is not deletion authority)" "$CLEANUP_FORCED"
if [ -d "$ASYNC_OWNED" ] && [ -d "$ASYNC_LOOKALIKE" ] && [ -d "$STALE_COUNTER_LOCK" ]; then pass "G10b: forced cleanup preserves untyped runtime state"; else fail "G10b: forced cleanup preserves untyped runtime state" "runtime state removed"; fi
CLEANUP_REAL_STATUS_AFTER=$(git -C "$PROJECT_DIR" status --porcelain=v2 --untracked-files=all)
CLEANUP_REAL_WORKTREES_AFTER=$(git -C "$PROJECT_DIR" worktree list --porcelain)
CLEANUP_REAL_REFS_AFTER=$(git -C "$PROJECT_DIR" for-each-ref --format='%(refname) %(objectname)' refs/ypi/)
assert_eq "G10b: cleanup leaves the real checkout status unchanged" "$CLEANUP_REAL_STATUS_BEFORE" "$CLEANUP_REAL_STATUS_AFTER"
assert_eq "G10b: cleanup leaves the real worktree registry unchanged" "$CLEANUP_REAL_WORKTREES_BEFORE" "$CLEANUP_REAL_WORKTREES_AFTER"
assert_eq "G10b: cleanup leaves real ypi refs unchanged" "$CLEANUP_REAL_REFS_BEFORE" "$CLEANUP_REAL_REFS_AFTER"
rm -rf "$ASYNC_OWNED" "$ASYNC_LOOKALIKE" "$STALE_COUNTER_LOCK"

# Restore normal mock
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
chmod +x "$MOCK_BIN/pi"


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

# G11b: canonical CLI preserves incremental stdout rather than buffering until
# child exit.
cat > "$MOCK_BIN/pi" << 'STREAMPI'
#!/bin/bash
printf '%s\n' STREAM_FIRST
sleep 2
printf '%s\n' STREAM_SECOND
STREAMPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/stream.counter" python3 <<'PY'
import os, subprocess, time
start=time.monotonic()
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"streaming"})
p=subprocess.Popen([os.environ["RLM_QUERY_PATH"],"Streaming output?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
first=p.stdout.readline().strip()
elapsed=time.monotonic()-start
rest,err=p.communicate(timeout=5)
assert p.returncode==0,(p.returncode,err)
assert first=="STREAM_FIRST",first
assert elapsed<1.0,elapsed
assert "STREAM_SECOND" in rest,rest
PY
then
    pass "G11b: CLI streams stdout before child exit"
else
    fail "G11b: CLI streams stdout before child exit" "streaming probe failed"
fi

# G11c: successful child stderr remains stderr and never contaminates captured
# answer stdout.
cat > "$MOCK_BIN/pi" << 'SPLITPI'
#!/bin/bash
printf '%s\n' STDOUT_ONLY
printf '%s\n' STDERR_ONLY >&2
SPLITPI
chmod +x "$MOCK_BIN/pi"
SPLIT_ERR="$TEST_TMP/split.stderr"
SPLIT_OUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=0 \
 RLM_SHARED_SESSIONS=0 \
    RLM_CALL_COUNTER_FILE="$TEST_TMP/split.counter" RLM_TRACE_ID=split \
    rlm_query "Split output?" 2>"$SPLIT_ERR"
)
assert_contains "G11c: child stdout remains stdout" "STDOUT_ONLY" "$SPLIT_OUT"
assert_not_contains "G11c: child stderr excluded from stdout" "STDERR_ONLY" "$SPLIT_OUT"
assert_contains "G11c: child stderr remains stderr" "STDERR_ONLY" "$(cat "$SPLIT_ERR")"

# G11d: SIGINT reaches the detached child process group and the CLI exits 130.
cat > "$MOCK_BIN/pi" << 'CANCELPI'
#!/bin/bash
printf '%s\n' "$$" > "$YPI_FAKE_PID_FILE"
sleep 30
CANCELPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/cancel.counter" TEST_PID_FILE="$TEST_TMP/cancel.pid" python3 <<'PY'
import os, signal, subprocess, time
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"cancel","YPI_FAKE_PID_FILE":os.environ["TEST_PID_FILE"]})
p=subprocess.Popen([os.environ["RLM_QUERY_PATH"],"Cancel child?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
for _ in range(60):
    if os.path.exists(os.environ["TEST_PID_FILE"]): break
    time.sleep(.05)
assert os.path.exists(os.environ["TEST_PID_FILE"]),"child pid not recorded"
child_pid=int(open(os.environ["TEST_PID_FILE"]).read())
p.send_signal(signal.SIGINT)
p.communicate(timeout=5)
assert p.returncode==130,p.returncode
try:
    os.kill(child_pid,0)
except ProcessLookupError:
    pass
else:
    raise AssertionError(f"child still alive: {child_pid}")
PY
then
    pass "G11d: CLI cancellation terminates child and exits 130"
else
    fail "G11d: CLI cancellation terminates child and exits 130" "cancellation probe failed"
fi

# G11d2: a descendant that closes inherited stdio and ignores SIGTERM must
# still receive the scheduled process-group SIGKILL after the leader exits.
cat > "$MOCK_BIN/pi" << 'DESCENDANTPI'
#!/bin/bash
(
  trap '' TERM
  exec </dev/null >/dev/null 2>&1
  while :; do sleep 30; done
) &
printf '%s\n' "$!" > "$YPI_DESCENDANT_PID_FILE"
printf '%s\n' "$$" > "$YPI_FAKE_PID_FILE"
sleep 30
DESCENDANTPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/descendant-cancel.counter" TEST_PID_FILE="$TEST_TMP/descendant-parent.pid" TEST_DESC_FILE="$TEST_TMP/descendant.pid" python3 <<'PY'
import os, signal, subprocess, time
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"descendant-cancel","YPI_FAKE_PID_FILE":os.environ["TEST_PID_FILE"],"YPI_DESCENDANT_PID_FILE":os.environ["TEST_DESC_FILE"]})
p=subprocess.Popen([os.environ["RLM_QUERY_PATH"],"Cancel descendant group?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
for _ in range(100):
    if os.path.exists(os.environ["TEST_DESC_FILE"]): break
    time.sleep(.02)
assert os.path.exists(os.environ["TEST_DESC_FILE"]),"descendant pid not recorded"
descendant=int(open(os.environ["TEST_DESC_FILE"]).read())
p.send_signal(signal.SIGINT)
p.communicate(timeout=6)
assert p.returncode==130,p.returncode
try:
    os.kill(descendant,0)
except ProcessLookupError:
    pass
else:
    raise AssertionError(f"SIGTERM-ignoring descendant still alive: {descendant}")
PY
then
    pass "G11d2: cancellation escalates against surviving process-group descendants"
else
    fail "G11d2: cancellation escalates against surviving process-group descendants" "descendant cancellation probe failed"
fi

# G11e: the thin CLI does not invent a trailing newline that the child did not
# emit; byte presentation remains pipe-compatible with the retained CLI.
cat > "$MOCK_BIN/pi" << 'BYTESPI'
#!/bin/bash
printf '%s' NO_TRAILING_NEWLINE
BYTESPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/bytes.counter" python3 <<'PY'
import os, subprocess
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"bytes"})
r=subprocess.run([os.environ["RLM_QUERY_PATH"],"Exact bytes?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert r.returncode==0,(r.returncode,r.stderr)
assert r.stdout==b"NO_TRAILING_NEWLINE",repr(r.stdout)
PY
then
    pass "G11e: CLI preserves exact child stdout bytes"
else
    fail "G11e: CLI preserves exact child stdout bytes" "byte probe failed"
fi

cat > "$MOCK_BIN/pi" << 'FULLSTREAMPI'
#!/bin/bash
python3 -c 'import sys; sys.stdout.write("A" * 100000)'
FULLSTREAMPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/full-stream.counter" python3 <<'PY'
import os, subprocess
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"full-stream"})
r=subprocess.run([os.environ["RLM_QUERY_PATH"],"Full stream?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert r.returncode==0,(r.returncode,r.stderr[-500:])
assert len(r.stdout)==100000,len(r.stdout)
PY
then
    pass "G11e2: CLI streams bytes beyond the retained answer cap"
else
    fail "G11e2: CLI streams bytes beyond the retained answer cap" "full stream probe failed"
fi

# G11f: downstream pipe closure is handled as normal pipeline termination; it
# aborts paid child work instead of crashing Node with an unhandled EPIPE.
cat > "$MOCK_BIN/pi" << 'PIPEPI'
#!/bin/bash
python3 - <<'PY'
for i in range(200000):
    print(f"line-{i:06d}-" + "x" * 200)
PY
PIPEPI
chmod +x "$MOCK_BIN/pi"
if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/epipe.counter" python3 <<'PY'
import os, subprocess
env=os.environ.copy()
env.update({"CONTEXT":os.environ["TEST_CONTEXT"],"RLM_DEPTH":"0","RLM_MAX_DEPTH":"3","RLM_JSON":"0","RLM_SHARED_SESSIONS":"0","RLM_CALL_COUNTER_FILE":os.environ["TEST_COUNTER"],"RLM_TRACE_ID":"epipe"})
p=subprocess.Popen([os.environ["RLM_QUERY_PATH"],"Pipe close?"],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.stdout is not None
assert p.stdout.readline()
p.stdout.close()
stderr=p.stderr.read() if p.stderr else b""
rc=p.wait(timeout=5)
assert rc==0,(rc,stderr[-500:])
assert b"EPIPE" not in stderr,stderr[-500:]
PY
then
    pass "G11f: downstream EPIPE cancels cleanly without an unhandled error"
else
    fail "G11f: downstream EPIPE cancels cleanly without an unhandled error" "pipe closure probe failed"
fi

# Restore normal mock before subsequent sections.
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
echo "ARGS: $*"
echo "RLM_DEPTH=$RLM_DEPTH"
echo "RLM_MODEL=$RLM_MODEL"
MOCK_PI
chmod +x "$MOCK_BIN/pi"


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

# G16: Timeout error has Why + Fix (depth>0 child inheriting an expired tree budget)
PAST=$(($(date +%s) - 100))
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=1 RLM_MAX_DEPTH=3 \
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

# G19: Automatic trace captures lifecycle when no explicit path is supplied.
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_TRACE_ID=auto-summary \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Private auto trace text"
)
AUTO_SUMMARY_LABEL=$(printf '%s' auto-summary | sha256sum | cut -c1-8)
mapfile -t AUTO_SUMMARY_TRACES < <(
    find "$TEST_TMP" -mindepth 2 -maxdepth 2 \
        -path "$TEST_TMP/ypi_runtime_${AUTO_SUMMARY_LABEL}_*/trace.jsonl" \
        -type f -print
)
if [ "${#AUTO_SUMMARY_TRACES[@]}" -eq 1 ]; then
    TRACE_FILE2="${AUTO_SUMMARY_TRACES[0]}"
    pass "G19: exactly one randomized lifecycle trace exists"
else
    TRACE_FILE2="$TEST_TMP/missing-auto-summary"
    fail "G19: exactly one randomized lifecycle trace exists" "count=${#AUTO_SUMMARY_TRACES[@]}"
fi
assert_file_exists "G19: automatic lifecycle trace exists" "$TRACE_FILE2"
assert_contains "G19: automatic trace records completion" "COMPLETED" "$(cat "$TRACE_FILE2")"
assert_not_contains "G19: automatic trace excludes prompt text" "Private auto trace text" "$(cat "$TRACE_FILE2")"


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
    RLM_TRACE_ID="abcg25" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=0 \
    rlm_query "Session filename test"
)
# Depth 0→1, call count becomes 1: abcg25_d1_c1.jsonl
assert_contains "G25: session has trace ID" "abcg25" "$OUTPUT"
assert_contains "G25: session has depth" "_d1_" "$OUTPUT"
assert_contains "G25: session has call count" "_c1.jsonl" "$OUTPUT"

# G26: session file path is in RLM_SESSION_FILE for children to reference
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abcg26" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    RLM_CALL_COUNT=0 \
    rlm_query "Session file env test"
)
assert_contains "G26: RLM_SESSION_FILE set" "abcg26_d1_c1.jsonl" "$OUTPUT"
assert_not_contains "G26: RLM_SESSION_FILE not unset" "RLM_SESSION_FILE=unset" "$OUTPUT"

# G27: max depth nodes still get sessions (they have full tools)
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_TRACE_ID="abc12345" \
    RLM_SESSION_DIR="$SESSION_TMP" \
    with_tree_authority 2 rlm_query "Max depth session test"
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
echo "PI_CODING_AGENT_DIR=${PI_CODING_AGENT_DIR:-unset}"
echo "PI_PACKAGE_DIR=${PI_PACKAGE_DIR:-unset}"
echo "PI_OFFLINE=${PI_OFFLINE:-unset}"
if [ -f "${PI_CODING_AGENT_DIR:-}/auth.json" ]; then
	echo "AUTH_FILE=present"
	echo "AUTH_MODE=$(stat -c '%a' "$PI_CODING_AGENT_DIR/auth.json")"
	grep -q '"anthropic"' "$PI_CODING_AGENT_DIR/auth.json" && echo "AUTH_SELECTED=present" || echo "AUTH_SELECTED=absent"
	grep -q '"other"' "$PI_CODING_AGENT_DIR/auth.json" && echo "AUTH_OTHER=present" || echo "AUTH_OTHER=absent"
	[ -e "$PI_CODING_AGENT_DIR/settings.json" ] && echo "SETTINGS_FILE=present" || echo "SETTINGS_FILE=absent"
else
	echo "AUTH_FILE=absent"
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] && echo "ANTHROPIC_ENV=present" || echo "ANTHROPIC_ENV=absent"
[ -n "${OPENAI_API_KEY:-}" ] && echo "OPENAI_ENV=present" || echo "OPENAI_ENV=absent"
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# G34: children isolate ambient extension copies by default and load only exact ypi; non-extension discovery remains enabled
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=test RLM_MODEL=test \
    rlm_query "Extensions default test"
)
assert_contains "G34: ambient extension copies disabled by default" "--no-extensions" "$OUTPUT"
assert_not_contains "G34: skill discovery enabled by default" "--no-skills" "$OUTPUT"
assert_contains "G34: ypi extension explicitly loaded" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" RLM_AMBIENT_EXTENSIONS=1 \
    RLM_PROVIDER=test RLM_MODEL=test rlm_query "Ambient extension compatibility"
)
assert_not_contains "G34b: ambient extension compatibility is explicit" "--no-extensions" "$OUTPUT"

# G35: RLM_EXTENSIONS=0 disables even ypi's explicit extension
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_EXTENSIONS=0 \
    rlm_query "Extensions disabled test"
)
assert_contains "G35: RLM_EXTENSIONS=0 disables" "--no-extensions" "$OUTPUT"
assert_not_contains "G35: no explicit extension when disabled" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"

# G36: max depth nodes keep the exact ypi extension while ambient copies stay disabled
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=test RLM_MODEL=test \
    with_tree_authority 2 rlm_query "Max depth extensions test"
)
assert_contains "G36: max depth disables ambient extension copies" "--no-extensions" "$OUTPUT"
assert_contains "G36: max depth has ypi extension" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"

# G37: RLM_CHILD_EXTENSIONS=0 disables root-to-child extension loading
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_CHILD_EXTENSIONS=0 \
    rlm_query "Root with child ext off"
)
assert_contains "G37: root-to-child extensions disabled" "--no-extensions" "$OUTPUT"
assert_not_contains "G37: root-to-child no explicit extension" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"

# G38: RLM_CHILD_EXTENSIONS=0 applies at depth > 0
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_CHILD_EXTENSIONS=0 \
    with_tree_authority 1 rlm_query "Child with ext off"
)
assert_contains "G38: child extensions disabled" "--no-extensions" "$OUTPUT"

# G38b: RLM_CHILD_DISCOVERY=0 disables non-extension skill/context discovery surfaces
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_CHILD_DISCOVERY=0 \
    rlm_query "Child discovery off"
)
assert_contains "G38b: child discovery off disables non-extension skills" "--no-skills" "$OUTPUT"
assert_contains "G38b: child discovery off disables context files" "--no-context-files" "$OUTPUT"
assert_contains "G38b: child discovery off retains canonical-only extension mode" "--no-extensions" "$OUTPUT"
assert_contains "G38b: child discovery off still loads exact ypi" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"

# G38c: combine child discovery and extension opt-outs for full package/resource isolation
G38C_PARENT_AGENT="$TEST_TMP/g38c-parent-agent"
mkdir -m 700 "$G38C_PARENT_AGENT"
printf '%s\n' '{"anthropic":{"type":"oauth","access":"G38C_SECRET_MUST_NOT_LEAK"},"other":{"type":"api_key","key":"OTHER_SECRET_MUST_NOT_LEAK"}}' > "$G38C_PARENT_AGENT/auth.json"
chmod 600 "$G38C_PARENT_AGENT/auth.json"
printf '%s\n' '{"packages":["ambient-must-not-project"]}' > "$G38C_PARENT_AGENT/settings.json"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    HOME="$TEST_TMP" \
    PI_CODING_AGENT_DIR="~/g38c-parent-agent" \
    ANTHROPIC_API_KEY="SELECTED_ENV_CANARY_MUST_NOT_LEAK" \
    OPENAI_API_KEY="OTHER_ENV_CANARY_MUST_NOT_LEAK" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    YPI_EXTENSION_PATH="$PROJECT_DIR/extensions/recursive.ts" \
    RLM_PROVIDER=anthropic RLM_MODEL=test \
    RLM_CHILD_DISCOVERY=0 \
    RLM_CHILD_EXTENSIONS=0 \
    rlm_query "Full child isolation"
)
assert_contains "G38c: full child isolation disables extensions" "--no-extensions" "$OUTPUT"
assert_contains "G38c: full child isolation disables non-extension skills" "--no-skills" "$OUTPUT"
assert_not_contains "G38c: full child isolation avoids explicit ypi extension" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"
assert_not_contains "G38c: full isolation replaces the ambient Pi agent root" "PI_CODING_AGENT_DIR=~/g38c-parent-agent" "$OUTPUT"
assert_contains "G38c: full isolation prevents package installation" "PI_OFFLINE=1" "$OUTPUT"
assert_contains "G38c: selected provider auth is projected" "AUTH_SELECTED=present" "$OUTPUT"
assert_contains "G38c: projected auth is private" "AUTH_MODE=600" "$OUTPUT"
assert_contains "G38c: unselected provider auth is excluded" "AUTH_OTHER=absent" "$OUTPUT"
assert_contains "G38c: selected provider environment is retained" "ANTHROPIC_ENV=present" "$OUTPUT"
assert_contains "G38c: other provider environment is excluded" "OPENAI_ENV=absent" "$OUTPUT"
assert_contains "G38c: ambient settings are excluded" "SETTINGS_FILE=absent" "$OUTPUT"
assert_not_contains "G38c: auth secret is absent from child diagnostics" "G38C_SECRET_MUST_NOT_LEAK" "$OUTPUT"
assert_not_contains "G38c: selected environment secret is absent from child diagnostics" "SELECTED_ENV_CANARY_MUST_NOT_LEAK" "$OUTPUT"
assert_not_contains "G38c: other environment secret is absent from child diagnostics" "OTHER_ENV_CANARY_MUST_NOT_LEAK" "$OUTPUT"

# G39: root launcher ambient-extension auto-detection.
# The `ypi` wrapper allows the user's ambient toolbelt unless a conflicting
# recursion-extension copy is actually present; detection failure isolates.
echo ""
echo "=== Root launcher ambient auto-detection ==="

G39_CLEAN="$TEST_TMP/g39_clean"
G39_CONFLICT="$TEST_TMP/g39_conflict"
G39_SAFE_PKGS="$TEST_TMP/g39_safe_pkgs"
G39_RECURSIVE_PKG="$TEST_TMP/g39_recursive_pkg"
mkdir -p "$G39_CLEAN" "$G39_CONFLICT/extensions" "$G39_SAFE_PKGS" "$G39_RECURSIVE_PKG"
printf 'const a = "rlm_query";\nconst b = "RLM_MAX_DEPTH";\n' > "$G39_CONFLICT/extensions/renamed-copy.ts"
printf '{"packages":["npm:@agney/pi-honcho-memory","npm:@narumitw/pi-chrome-devtools","../../code/example/agent-protocol/adapters/pi"]}' > "$G39_SAFE_PKGS/settings.json"
printf '{"packages":["npm:pi-recursive"]}' > "$G39_RECURSIVE_PKG/settings.json"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_CLEAN" "$PROJECT_DIR/ypi" -p "ambient auto test" 2>&1)
assert_not_contains "G39: auto mode allows ambient extensions when no conflict exists" "--no-extensions" "$OUTPUT"
assert_contains "G39: canonical ypi extension still loaded explicitly" "-e $PROJECT_DIR/extensions/recursive.ts" "$OUTPUT"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_CONFLICT" "$PROJECT_DIR/ypi" -p "ambient conflict test" 2>&1)
assert_contains "G39b: renamed recursion-extension copy isolates ambient extensions" "--no-extensions" "$OUTPUT"
assert_contains "G39b: isolation is explained with a doctor pointer" "ypi-doctor" "$OUTPUT"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_RECURSIVE_PKG" "$PROJECT_DIR/ypi" -p "ambient package conflict test" 2>&1)
assert_contains "G39c: installed pi-recursive package isolates ambient extensions" "--no-extensions" "$OUTPUT"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_SAFE_PKGS" "$PROJECT_DIR/ypi" -p "ambient safe packages test" 2>&1)
assert_not_contains "G39d: unrelated packages (memory/browser/protocol adapter) are not false positives" "--no-extensions" "$OUTPUT"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_CLEAN" RLM_AMBIENT_EXTENSIONS=0 "$PROJECT_DIR/ypi" -p "ambient forced off test" 2>&1)
assert_contains "G39e: RLM_AMBIENT_EXTENSIONS=0 always isolates" "--no-extensions" "$OUTPUT"

OUTPUT=$(PI_CODING_AGENT_DIR="$G39_CONFLICT" RLM_AMBIENT_EXTENSIONS=1 "$PROJECT_DIR/ypi" -p "ambient forced on test" 2>&1)
assert_not_contains "G39f: RLM_AMBIENT_EXTENSIONS=1 overrides detection" "--no-extensions" "$OUTPUT"


# ═══════════════════════════════════════════════════════════════════════════
# COST TELEMETRY / DOLLAR-CAP NON-ENFORCEMENT TESTS
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Cost telemetry (dollar caps ignored) ==="

# Restore standard mock; emit Pi JSON events when the canonical runtime requests
# measurable JSON mode for observational cost accounting.
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
if printf '%s\n' "$*" | grep -q -- '--mode json'; then
    printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"MOCK_PI_CALLED"}}'
    printf '%s\n' '{"type":"turn_end","message":{"usage":{"totalTokens":1,"cost":{"total":0.01}}},"toolResults":[]}'
else
    echo "MOCK_PI_CALLED"
    echo "ARGS: $*"
    echo "RLM_DEPTH=$RLM_DEPTH"
    echo "RLM_MODEL=$RLM_MODEL"
fi
MOCK_PI
chmod +x "$MOCK_BIN/pi"

# G39: an inherited dollar cap is ignored; product work still runs.
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 RLM_BUDGET=0 \
    rlm_query "Cost telemetry only"
)
assert_contains "G39: inherited dollar cap never stops work" "MOCK_PI_CALLED" "$OUTPUT"

# G40: JSON mode records cost telemetry without requiring a cap.
COST_FILE=$(mktemp "${TMPDIR:-/tmp}/rlm_cost_test.jsonl.XXXXXX")
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=1 RLM_COST_FILE="$COST_FILE" \
    rlm_query "Record telemetry"
)
assert_contains "G40: telemetry child succeeds" "MOCK_PI_CALLED" "$OUTPUT"
assert_contains "G40: telemetry ledger records cost" '"cost":0.01' "$(cat "$COST_FILE")"
rm -f "$COST_FILE"

# G40b: even malformed inherited dollar limits are discarded, not validated.
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" \
    RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
    RLM_PROVIDER=test RLM_MODEL=test \
    RLM_JSON=0 RLM_BUDGET=not-a-number \
    rlm_query "Ignore malformed cap"
)
assert_contains "G40b: malformed dollar cap does not block work" "MOCK_PI_CALLED" "$OUTPUT"

# G40c: incomplete telemetry is recorded honestly but never blocks later work.
cat > "$MOCK_BIN/pi" << 'NOENDPI'
#!/bin/bash
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"PARTIAL"}}'
exit 42
NOENDPI
chmod +x "$MOCK_BIN/pi"
COST_FILE=$(mktemp "${TMPDIR:-/tmp}/rlm_cost_incomplete.jsonl.XXXXXX")
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=1 \
    RLM_BUDGET=0 RLM_COST_FILE="$COST_FILE" \
    RLM_CALL_COUNTER_FILE="$TEST_TMP/incomplete-cost.counter" \
    rlm_query "Unknown failed telemetry" 2>&1 || true
)
assert_contains "G40c: missing turn_end records incomplete telemetry" '"incomplete":true' "$(cat "$COST_FILE")"
cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
printf '%s\n' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"MOCK_PI_CALLED"}}'
printf '%s\n' '{"type":"turn_end","message":{"usage":{"totalTokens":1,"cost":{"total":0.01}}},"toolResults":[]}'
MOCK_PI
chmod +x "$MOCK_BIN/pi"
OUTPUT=$(
	CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=1 \
	RLM_BUDGET=0 RLM_COST_FILE="$COST_FILE" \
	RLM_CALL_COUNTER_FILE="$TEST_TMP/incomplete-cost-retry.counter" \
	rlm_query "Continue after incomplete telemetry"
)
assert_contains "G40c: incomplete telemetry never blocks later admission" "MOCK_PI_CALLED" "$OUTPUT"
rm -f "$COST_FILE"

# G41: a pre-existing high cost total is observable, never an admission gate.
COST_FILE=$(mktemp "${TMPDIR:-/tmp}/rlm_cost_test.jsonl.XXXXXX")
echo '{"cost": 100.00, "tokens": 5000}' > "$COST_FILE"
OUTPUT=$(
    CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=1 \
    RLM_BUDGET=0 RLM_COST_FILE="$COST_FILE" \
    rlm_query "Continue product work"
)
assert_contains "G41: accumulated cost never stops product work" "MOCK_PI_CALLED" "$OUTPUT"
rm -f "$COST_FILE"

# G44: rlm_cost with no cost file returns $0
OUTPUT=$(
    RLM_COST_FILE="" \
    "$PROJECT_DIR/rlm_cost"
)
assert_contains "G44: rlm_cost no file" "\$0.000000" "$OUTPUT"

# G45: rlm_cost with cost file returns total
COST_FILE=$(mktemp "${TMPDIR:-/tmp}/rlm_cost_test.jsonl.XXXXXX")
echo '{"cost": 0.15, "tokens": 2000}' > "$COST_FILE"
echo '{"cost": 0.25, "tokens": 3000}' >> "$COST_FILE"
OUTPUT=$(
    RLM_COST_FILE="$COST_FILE" \
    "$PROJECT_DIR/rlm_cost"
)
assert_contains "G45: rlm_cost sums" "\$0.400000" "$OUTPUT"
rm -f "$COST_FILE"

# G46: rlm_cost --json returns structured data
COST_FILE=$(mktemp "${TMPDIR:-/tmp}/rlm_cost_test.jsonl.XXXXXX")
echo '{"cost": 0.10, "tokens": 1000}' > "$COST_FILE"
echo '{"cost": 0.20, "tokens": 2000}' >> "$COST_FILE"
OUTPUT=$(
    RLM_COST_FILE="$COST_FILE" \
    "$PROJECT_DIR/rlm_cost" --json
)
assert_contains "G46: rlm_cost json has cost" "0.3" "$OUTPUT"
assert_contains "G46: rlm_cost json has tokens" "3000" "$OUTPUT"
assert_contains "G46: rlm_cost json has calls" '"calls": 2' "$OUTPUT"

HOSTILE_COST_FILE="$TEST_TMP/cost ledger 'quoted
name.jsonl"
printf '%s\n' \
    '{"cost":0.25,"tokens":25}' \
    '{"incomplete":true,"reason":"cancelled"}' \
    > "$HOSTILE_COST_FILE"
HOSTILE_COST_OUTPUT=$(RLM_COST_FILE="$HOSTILE_COST_FILE" "$PROJECT_DIR/rlm_cost" --json)
assert_contains "G46a: hostile cost filename remains argv data" '"cost": 0.25' "$HOSTILE_COST_OUTPUT"
assert_contains "G46a: incomplete records are not completed calls" '"calls": 1' "$HOSTILE_COST_OUTPUT"
assert_contains "G46a: incomplete telemetry remains explicit" '"incomplete_markers": 1' "$HOSTILE_COST_OUTPUT"
rm -f "$COST_FILE"

# G46b: retained JSON parser emits one newline-delimited cost record per call.
PARSER_COST_FILE="$TEST_TMP/parser_cost.jsonl"
: > "$PARSER_COST_FILE"
for _ in 1 2; do
    printf '%s\n' '{"type":"turn_end","message":{"usage":{"totalTokens":2,"cost":{"total":0.1}}}}' \
        | python3 "$PROJECT_DIR/rlm_parse_json" 3>>"$PARSER_COST_FILE"
done
PARSER_COST_LINES="$(python3 - "$PARSER_COST_FILE" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
print(len(rows))
PY
)"
assert_eq "G46b: retained cost records stay JSONL across calls" "2" "$PARSER_COST_LINES"

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
chmod 700 "$SESSION_DIR"
cat > "$SESSION_DIR/abc123_d0_c1.jsonl" << 'SESSION_DATA'
{"type":"session","version":3,"id":"test-uuid","timestamp":"2026-01-15T10:00:00Z","cwd":"/tmp"}
{"type":"message","id":"msg1","parentId":null,"timestamp":"2026-01-15T10:00:01Z","message":{"role":"user","content":"hello world"}}
{"type":"message","id":"msg2","parentId":"msg1","timestamp":"2026-01-15T10:00:02Z","message":{"role":"assistant","content":"hi there"}}
SESSION_DATA
chmod 600 "$SESSION_DIR/abc123_d0_c1.jsonl"

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
chmod 600 "$SESSION_DIR/other99_d0_c1.jsonl"

OUTPUT=$(
    RLM_SESSION_DIR="$SESSION_DIR" \
    RLM_TRACE_ID="abc123" \
    "$PROJECT_DIR/rlm_sessions" --trace
)
assert_contains "G51: trace filter includes matching" "abc123_d0_c1.jsonl" "$OUTPUT"
assert_not_contains "G51: trace filter excludes other" "other99_d0_c1.jsonl" "$OUTPUT"
rm -rf "$SESSION_DIR"


# ═══════════════════════════════════════════════════════════════════════════
# TRACE ID SANITIZATION
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Trace ID Sanitization ==="

# G52: a hostile RLM_TRACE_ID cannot traverse out of the session directory
if _feature_exists "safeTraceId"; then
    cat > "$MOCK_BIN/pi" << 'TRACEPI'
#!/bin/bash
echo "ARGS: $*"
echo "RLM_TRACE_ID=${RLM_TRACE_ID:-unset}"
echo "RLM_SESSION_FILE=${RLM_SESSION_FILE:-unset}"
TRACEPI
    chmod +x "$MOCK_BIN/pi"
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_SESSION_DIR="$TEST_TMP/san_sessions" \
        RLM_TRACE_ID="../../etc/evil" \
        rlm_query "Sanitize trace?" 2>&1 || true
    )
    SANITIZED_TRACE=$(printf '%s\n' "$OUTPUT" | sed -n 's/^RLM_TRACE_ID=//p' | head -1)
    assert_contains "G52: hostile trace id is sanitized for the child" "RLM_TRACE_ID=.._.._etc_evil" "$OUTPUT"
    assert_eq "G52: hostile trace id uses the bounded identity mapping" "64" "${#SANITIZED_TRACE}"
    assert_contains "G52: session file uses the exact mapped trace id" "${SANITIZED_TRACE}_d1_c1.jsonl" "$OUTPUT"
    assert_not_contains "G52: session file cannot traverse out of the dir" "/etc/evil_d1" "$OUTPUT"
else
    skip "G52: trace id sanitization" "safe_trace_id not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# ASYNC LIFECYCLE
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Async Lifecycle ==="

if _feature_exists "createAsyncJob"; then
    # G53a: metadata capture through command substitution must not wait for the
    # background child to close the inherited stdout pipe.
    cat > "$MOCK_BIN/pi" << 'SLOWPI'
#!/bin/bash
sleep 2
printf '%s\n' 'slow child complete'
SLOWPI
    chmod +x "$MOCK_BIN/pi"

    START_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
    JOB=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TRACE_ID="async_success_$$" \
        RLM_CALL_COUNTER_FILE="$TEST_TMP/async_success.counter" \
        rlm_query --async "Async immediate metadata?" 2>/dev/null
    )
    END_NS=$(python3 -c 'import time; print(time.monotonic_ns())')
    ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
    if [ "$ELAPSED_MS" -lt 1000 ]; then
        pass "G53a: command-substitution async returns immediately"
    else
        fail "G53a: command-substitution async returns immediately" "elapsed=${ELAPSED_MS}ms"
    fi
    ASYNC_SENTINEL=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sentinel',''))")
    if [ ! -e "$ASYNC_SENTINEL" ]; then
        pass "G53a: slow child is still pending when metadata returns"
    else
        fail "G53a: slow child is still pending when metadata returns" "sentinel already exists"
    fi
    for _ in $(seq 1 50); do [ -e "$ASYNC_SENTINEL" ] && break; sleep 0.1; done
    assert_eq "G53a: successful async sentinel records exit code" "0" "$(cat "$ASYNC_SENTINEL" 2>/dev/null || echo missing)"

    # G53b: set -e in the parent script must not skip sentinel creation or
    # cleanup when the background child itself exits nonzero.
    cat > "$MOCK_BIN/pi" << 'FAILPI'
#!/bin/bash
printf '%s\n' 'async child failed' >&2
exit 42
FAILPI
    chmod +x "$MOCK_BIN/pi"
    JOB=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TRACE_ID="async_failure_$$" \
        RLM_CALL_COUNTER_FILE="$TEST_TMP/async_failure.counter" \
        rlm_query --async "Async failure sentinel?" 2>/dev/null
    )
    FAILURE_SENTINEL=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sentinel',''))")
    for _ in $(seq 1 50); do [ -e "$FAILURE_SENTINEL" ] && break; sleep 0.1; done
    assert_eq "G53b: failed async sentinel records child exit code" "42" "$(cat "$FAILURE_SENTINEL" 2>/dev/null || echo missing)"

    # G53c: guardrail rejection occurs before async metadata acknowledges work.
    set +e
    REJECTED=$(
        CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=3 RLM_MAX_DEPTH=3 \
        RLM_TRACE_ID="async_reject_$$" RLM_CALL_COUNTER_FILE="$TEST_TMP/async_reject.counter" \
        rlm_query --async "Reject before acknowledgement" 2>&1
    )
    REJECT_RC=$?
    set -e
    if [ "$REJECT_RC" -ne 0 ]; then pass "G53c: async guardrail rejection returns nonzero"; else fail "G53c: async guardrail rejection returns nonzero" "$REJECTED"; fi
    assert_contains "G53c: async rejection reports depth guard" "Max depth exceeded" "$REJECTED"
    assert_not_contains "G53c: rejected async call emits no accepted job metadata" '"job_id"' "$REJECTED"
    if find "$TEST_TMP" -maxdepth 1 -type d -name "rlm_async_async_reject_*" -print -quit | grep -q .; then
        fail "G53c: rejected async job directory is removed" "stale private job directory"
    else
        pass "G53c: rejected async job directory is removed"
    fi

	    REVIEW_JOB=$(
	        CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
	        RLM_TRACE_ID="async_review_$$" RLM_CALL_COUNTER_FILE="$TEST_TMP/async_review.counter" \
	        rlm_query --async "Automatic read-only async review" 2>&1
	    )
	    assert_contains "G53c: async review needs no workspace choice" '"job_id"' "$REVIEW_JOB"
	    REVIEW_SENTINEL=$(printf '%s' "$REVIEW_JOB" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sentinel',''))")
	    for _ in $(seq 1 50); do [ -e "$REVIEW_SENTINEL" ] && break; sleep 0.1; done
	    if [ -e "$REVIEW_SENTINEL" ]; then pass "G53c: async read-only review reaches terminal state"; else fail "G53c: async read-only review reaches terminal state" "missing sentinel"; fi

    # G53d: inherited context is snapshotted at invocation time, not read from a
    # mutable caller path after metadata returns.
    cat > "$MOCK_BIN/pi" << 'SNAPSHOTPI'
#!/bin/bash
sleep 1
cat "$CONTEXT"
SNAPSHOTPI
    chmod +x "$MOCK_BIN/pi"
    printf '%s\n' ORIGINAL_CONTEXT > "$TEST_TMP/mutable-context.txt"
    JOB=$(
        CONTEXT="$TEST_TMP/mutable-context.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_TRACE_ID="async_snapshot_$$" RLM_CALL_COUNTER_FILE="$TEST_TMP/async_snapshot.counter" \
        rlm_query --async "Snapshot context" 2>/dev/null
    )
    SNAPSHOT_OUTPUT=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['output'])")
    SNAPSHOT_SENTINEL=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['sentinel'])")
    printf '%s\n' MUTATED_CONTEXT > "$TEST_TMP/mutable-context.txt"
    for _ in $(seq 1 50); do [ -e "$SNAPSHOT_SENTINEL" ] && break; sleep 0.1; done
    assert_contains "G53d: async context uses invocation snapshot" "ORIGINAL_CONTEXT" "$(cat "$SNAPSHOT_OUTPUT")"
    assert_not_contains "G53d: async context ignores later mutation" "MUTATED_CONTEXT" "$(cat "$SNAPSHOT_OUTPUT")"
    ASYNC_MODE=$(stat -c '%a' "$(dirname "$SNAPSHOT_OUTPUT")" 2>/dev/null || echo unknown)
    assert_eq "G53d: async job directory is private" "700" "$ASYNC_MODE"

    # G53e: root charter and fork session are immutable invocation snapshots too.
    cat > "$MOCK_BIN/pi" << 'ROOTSNAPPI'
#!/bin/bash
sleep 1
cat "$RLM_ROOT_PROMPT_FILE"
[ -f "${RLM_SESSION_FILE:-}" ] && cat "$RLM_SESSION_FILE"
ROOTSNAPPI
    chmod +x "$MOCK_BIN/pi"
    printf '%s\n' ORIGINAL_ROOT_CHARTER > "$TEST_TMP/mutable-root-prompt.txt"
    printf '%s\n' ORIGINAL_PARENT_SESSION > "$TEST_TMP/mutable-parent-session.jsonl"
    mkdir -p "$TEST_TMP/async-sessions"
    JOB=$(
        CONTEXT="$TEST_TMP/ctx.txt" RLM_ROOT_PROMPT_FILE="$TEST_TMP/mutable-root-prompt.txt" \
        RLM_SESSION_FILE="$TEST_TMP/mutable-parent-session.jsonl" RLM_SESSION_DIR="$TEST_TMP/async-sessions" \
        RLM_SHARED_SESSIONS=1 RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=0 \
        RLM_TRACE_ID="async_charter_$$" RLM_CALL_COUNTER_FILE="$TEST_TMP/async_charter.counter" \
        rlm_query --async --fork "Snapshot charter and session" 2>/dev/null
    )
    CHARTER_OUTPUT=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['output'])")
    CHARTER_SENTINEL=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['sentinel'])")
    printf '%s\n' MUTATED_ROOT_CHARTER > "$TEST_TMP/mutable-root-prompt.txt"
    printf '%s\n' MUTATED_PARENT_SESSION > "$TEST_TMP/mutable-parent-session.jsonl"
    for _ in $(seq 1 50); do [ -e "$CHARTER_SENTINEL" ] && break; sleep 0.1; done
    CHARTER_RESULT=$(cat "$CHARTER_OUTPUT")
    assert_contains "G53e: async worker uses root charter snapshot" "ORIGINAL_ROOT_CHARTER" "$CHARTER_RESULT"
    assert_not_contains "G53e: async root charter ignores later mutation" "MUTATED_ROOT_CHARTER" "$CHARTER_RESULT"
    assert_contains "G53e: async fork uses parent session snapshot" "ORIGINAL_PARENT_SESSION" "$CHARTER_RESULT"
    assert_not_contains "G53e: async fork session ignores later mutation" "MUTATED_PARENT_SESSION" "$CHARTER_RESULT"

    # G53f: signalling the acknowledged worker must abort the detached Pi process
    # group and still publish a terminal sentinel.
    cat > "$MOCK_BIN/pi" << 'ASYNCANCELPI'
#!/bin/bash
printf '%s\n' "$$" > "$RLM_ASYNC_TEST_PID_FILE"
sleep 30 &
printf '%s\n' "$!" > "$RLM_ASYNC_TEST_DESC_PID_FILE"
wait
ASYNCANCELPI
    chmod +x "$MOCK_BIN/pi"
    JOB=$(
        CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=0 \
        RLM_ASYNC_TEST_PID_FILE="$TEST_TMP/async-child.pid" \
        RLM_ASYNC_TEST_DESC_PID_FILE="$TEST_TMP/async-child.pid.descendant" \
        RLM_TRACE_ID="async_cancel_$$" RLM_CALL_COUNTER_FILE="$TEST_TMP/async_cancel.counter" \
        rlm_query --async "Cancel worker and child" 2>/dev/null
    )
    CANCEL_WORKER=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['pid'])")
    CANCEL_SENTINEL=$(printf '%s' "$JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['sentinel'])")
    for _ in $(seq 1 50); do [ -s "$TEST_TMP/async-child.pid" ] && break; sleep 0.1; done
    kill -TERM "$CANCEL_WORKER"
    for _ in $(seq 1 70); do [ -e "$CANCEL_SENTINEL" ] && break; sleep 0.1; done
    assert_eq "G53f: cancelled async worker records SIGTERM exit" "143" "$(cat "$CANCEL_SENTINEL" 2>/dev/null || echo missing)"
    ASYNC_CHILD_PID=$(cat "$TEST_TMP/async-child.pid" 2>/dev/null || echo 0)
    ASYNC_DESC_PID=$(cat "$TEST_TMP/async-child.pid.descendant" 2>/dev/null || echo 0)
    for _ in $(seq 1 30); do
        if ! kill -0 "$ASYNC_CHILD_PID" 2>/dev/null && ! kill -0 "$ASYNC_DESC_PID" 2>/dev/null; then break; fi
        sleep 0.1
    done
    if kill -0 "$ASYNC_CHILD_PID" 2>/dev/null || kill -0 "$ASYNC_DESC_PID" 2>/dev/null; then
        fail "G53f: async cancellation leaves no child process group" "child=$ASYNC_CHILD_PID descendant=$ASYNC_DESC_PID"
    else
        pass "G53f: async cancellation leaves no child process group"
    fi

    if RLM_QUERY_PATH="$RLM_QUERY" TEST_CONTEXT="$TEST_TMP/ctx.txt" TEST_COUNTER="$TEST_TMP/async-epipe.counter" python3 <<'PY'
import os, subprocess, time
counter=os.environ['TEST_COUNTER']
os.mkdir(counter+'.lock')
env=os.environ.copy()
env.update({'CONTEXT':os.environ['TEST_CONTEXT'],'RLM_DEPTH':'0','RLM_MAX_DEPTH':'3','RLM_JSON':'0','RLM_SHARED_SESSIONS':'0','RLM_TRACE_ID':'async-epipe','RLM_CALL_COUNTER_FILE':counter})
p=subprocess.Popen([os.environ['RLM_QUERY_PATH'],'--async','Closed metadata reader'],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.stdout is not None
p.stdout.close()
time.sleep(.2)
os.rmdir(counter+'.lock')
stderr=p.stderr.read() if p.stderr else b''
rc=p.wait(timeout=8)
assert rc==0,(rc,stderr[-500:])
assert b'EPIPE' not in stderr,stderr[-500:]
PY
    then
        pass "G53g: async acknowledgement EPIPE cancels cleanly"
    else
        fail "G53g: async acknowledgement EPIPE cancels cleanly" "metadata pipe probe failed"
    fi

    case "$SNAPSHOT_OUTPUT" in
        "$TEST_TMP"/*) pass "G53h: async temp output honors TMPDIR" ;;
        *) fail "G53h: async temp output honors TMPDIR" "output=$SNAPSHOT_OUTPUT" ;;
    esac

    # The retired flag must fail before admission and ordinary async completion
    # must never scan or append to the former peer-inbox protocol.
    PEER_DIR="/tmp/pi_peer_rlmtest_$$"
    mkdir -p "$PEER_DIR"
    printf '{"pid":%s}\n' "$$" > "$PEER_DIR/meta.json"

    cat > "$MOCK_BIN/pi" << 'PEERLESSPI'
#!/bin/bash
printf '%s\n' 'ordinary async result'
PEERLESSPI
    chmod +x "$MOCK_BIN/pi"
    PEERLESS_JOB=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        RLM_TRACE_ID="async_peerless_$$" \
        RLM_CALL_COUNTER_FILE="$TEST_TMP/async_peerless.counter" \
        rlm_query --async "Complete without peer delivery" 2>/dev/null
    )
    PEERLESS_SENTINEL=$(printf '%s' "$PEERLESS_JOB" | python3 -c "import json,sys; print(json.load(sys.stdin)['sentinel'])")
    for _ in $(seq 1 50); do [ -e "$PEERLESS_SENTINEL" ] && break; sleep 0.1; done
    assert_eq "G53h: ordinary async job reaches its sentinel" "0" "$(cat "$PEERLESS_SENTINEL" 2>/dev/null || echo missing)"

    set +e
    RETIRED_NOTIFY=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
        RLM_PROVIDER=test RLM_MODEL=test \
        rlm_query --async --notify "$$" "Retired notification path" 2>&1
    )
    RETIRED_NOTIFY_RC=$?
    set -e
    assert_eq "G53h: retired notify flag exits 2" "2" "$RETIRED_NOTIFY_RC"
    assert_contains "G53h: retired notify flag explains the supported evidence path" "read the async output and sentinel paths" "$RETIRED_NOTIFY"
    assert_not_contains "G53h: retired notify flag admits no job" '"job_id"' "$RETIRED_NOTIFY"
    if [ ! -e "$PEER_DIR/inbox.jsonl" ]; then
        pass "G53h: ordinary async runtime leaves former peer inbox untouched"
    else
        fail "G53h: ordinary async runtime leaves former peer inbox untouched" "unexpected inbox content"
    fi

    rm -rf "$PEER_DIR"
    # Restore the canonical mock for any later additions.
    cat > "$MOCK_BIN/pi" << 'MOCK_PI'
#!/bin/bash
echo "MOCK_PI_CALLED"
MOCK_PI
    chmod +x "$MOCK_BIN/pi"
else
    skip "G53: async lifecycle" "createAsyncJob not implemented yet"
fi


# ═══════════════════════════════════════════════════════════════════════════
# DEPTH CONFIG VALIDATION
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo "=== Depth Validation ==="

# G54: a non-integer RLM_MAX_DEPTH fails closed (no pi call) instead of bypassing the limiter
if _feature_exists "Invalid recursion depth config"; then
    OUTPUT=$(
        CONTEXT="$TEST_TMP/ctx.txt" \
        RLM_DEPTH=0 RLM_MAX_DEPTH=abc \
        RLM_PROVIDER=test RLM_MODEL=test \
        rlm_query "Malformed depth?" 2>&1 || true
    )
    assert_not_contains "G54: malformed depth → no pi call" "MOCK_PI_CALLED" "$OUTPUT"
    assert_contains "G54: malformed depth → error message" "Invalid recursion depth config" "$OUTPUT"
else
    skip "G54: depth validation" "RLM_MAX_DEPTH validation not implemented yet"
fi

# G55: structural call and explicit timeout controls fail closed on malformed
# values in the canonical adapter.
for SPEC in \
    'RLM_MAX_CALLS=12junk|RLM_MAX_CALLS' \
    'RLM_TIMEOUT=2junk|RLM_TIMEOUT'; do
    SETTING="${SPEC%%|*}"
    NAME="${SPEC##*|}"
	    OUTPUT=$(
	        env "$SETTING" CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 \
	            RLM_CALL_COUNTER_FILE="$TEST_TMP/malformed-${NAME}.counter" \
	            rlm_query "Malformed guardrail?" 2>&1 || true
	    )
	    assert_contains "G55: canonical rejects malformed $NAME" "Invalid $NAME" "$OUTPUT"
	    assert_not_contains "G55: malformed canonical $NAME spawns no child" "MOCK_PI_CALLED" "$OUTPUT"
done

	OUTPUT=$(
	    env RLM_TIMEOUT=60 RLM_START_TIME=bad CONTEXT="$TEST_TMP/ctx.txt" \
	        RLM_DEPTH=1 RLM_MAX_DEPTH=3 \
	        RLM_CALL_COUNTER_FILE="$TEST_TMP/malformed-start.counter" \
	        rlm_query "Malformed inherited start?" 2>&1 || true
	)
assert_contains "G55: canonical rejects malformed RLM_START_TIME" "Invalid RLM_START_TIME" "$OUTPUT"
assert_not_contains "G55: malformed start time spawns no child" "MOCK_PI_CALLED" "$OUTPUT"

OUTPUT=$(RLM_BUDGET=free CONTEXT="$TEST_TMP/ctx.txt" RLM_DEPTH=0 RLM_MAX_DEPTH=3 RLM_JSON=0 rlm_query "Canonical runtime ignores dollar cap")
assert_contains "G55b: canonical runtime ignores inherited dollar cap" "MOCK_PI_CALLED" "$OUTPUT"

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

#!/bin/bash
# test_notify_done.sh — Integration tests for the notify-done extension.
#
# Tests that sentinel files wake the agent reliably,
# both when idle and when busy (streaming).
#
# Each test run uses a unique signal prefix (ndtest-t$$-) so it
# won't collide with any running notify-done instance watching ypi-signal-*.
#
# The tests launch pi in INTERACTIVE mode (not -p) because -p exits
# after one response — the poller never gets to run.
#
# Requires: pi installed, tmux available.
# Run: bash contrib/tests/test_notify_done.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXTENSION_SRC="$PROJECT_DIR/contrib/extensions/notify-done.ts"

# Unique prefix per test run — does NOT start with ypi-signal-
TEST_ID="t$$"
SIGNAL_PREFIX="ndtest-${TEST_ID}-"

PASS=0
FAIL=0
ERRORS=""
CLEANUP_FILES=()
TMUX_SESSION="ndtest-$$"

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }

cleanup() {
    rm -f /tmp/${SIGNAL_PREFIX}*
    for f in "${CLEANUP_FILES[@]}"; do
        rm -f "$f"
    done
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
}
trap cleanup EXIT

# ─── Prerequisites ────────────────────────────────────────────────────────

if ! command -v pi &>/dev/null; then
    echo "SKIP: pi not installed"
    exit 0
fi

if ! command -v tmux &>/dev/null; then
    echo "SKIP: tmux not installed"
    exit 0
fi

if [ ! -f "$EXTENSION_SRC" ]; then
    echo "FAIL: notify-done.ts not found at $EXTENSION_SRC"
    exit 1
fi

PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")
echo ""
echo "=== notify-done Extension Tests (pi $PI_VERSION) ==="
echo "    Signal prefix: $SIGNAL_PREFIX"
echo ""

# ─── Generate a test-specific extension with our unique prefix ────────────

TEST_EXTENSION=$(mktemp "${TMPDIR:-/tmp}/ndtest_ext.ts.XXXXXX")
CLEANUP_FILES+=("$TEST_EXTENSION")

cat > "$TEST_EXTENSION" << EXTEOF
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, unlinkSync } from "fs";

const SIGNAL_DIR = "/tmp";
const SIGNAL_PREFIX = "${SIGNAL_PREFIX}";
const POLL_INTERVAL = 2000; // 2s for faster tests

export default function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setInterval> | null = null;

    pi.on("session_start", async () => {
        timer = setInterval(() => {
            try {
                const files = readdirSync(SIGNAL_DIR).filter((f) => f.startsWith(SIGNAL_PREFIX));
                for (const file of files) {
                    const path = \`\${SIGNAL_DIR}/\${file}\`;
                    const name = file.slice(SIGNAL_PREFIX.length);
                    try {
                        const content = readFileSync(path, "utf-8").trim();
                        unlinkSync(path);
                        pi.sendMessage(
                            {
                                customType: "notify-done",
                                content: \`NOTIFY[\${name}]: \${content}\`,
                                display: true,
                            },
                            { triggerTurn: true },
                        );
                    } catch {}
                }
            } catch {}
        }, POLL_INTERVAL);
    });

    pi.on("session_shutdown", async () => {
        if (timer) { clearInterval(timer); timer = null; }
    });
}
EXTEOF

echo "  Generated test extension at $TEST_EXTENSION"
echo ""

# ─── Helpers ──────────────────────────────────────────────────────────────

wait_for_pattern() {
    local file="$1" pattern="$2" timeout_secs="${3:-60}"
    local elapsed=0
    while [ $elapsed -lt $timeout_secs ]; do
        if [ -f "$file" ] && grep -q "$pattern" "$file" 2>/dev/null; then
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    return 1
}

dump_session_tail() {
    local file="$1" n="${2:-5}"
    echo "    Session log tail:"
    tail -"$n" "$file" 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        m = json.loads(line).get('message', {})
        role = m.get('role', '?')
        c = m.get('content', '')
        if isinstance(c, list):
            c = ' '.join(x.get('text','') for x in c if isinstance(x, dict))
        if c: print(f'      [{role}] {c[:150]}')
    except: pass
" 2>/dev/null || true
}

# Start pi in interactive mode in a tmux window.
# Interactive mode keeps the process alive so the poller runs.
start_pi_interactive() {
    local window="$1" session_file="$2"
    tmux new-window -t "$TMUX_SESSION" -n "$window"
    # Launch pi in interactive mode with our test extension, no other extensions
    tmux send-keys -t "$TMUX_SESSION:$window" \
        "pi --no-extensions -e '$TEST_EXTENSION' --session '$session_file'" Enter
    # Wait for pi to be ready (interactive prompt appears)
    sleep 5
}

# Send a message to pi's interactive session
send_message() {
    local window="$1" message="$2"
    tmux send-keys -t "$TMUX_SESSION:$window" "$message" Enter
}

# Create tmux session for tests
tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 40

# ─── Test 1: Idle agent — sentinel triggers a turn ───────────────────────

echo "--- Test 1: Idle agent woken by sentinel ---"

SESSION_1=$(mktemp "${TMPDIR:-/tmp}/ndtest_session.jsonl.XXXXXX")
CLEANUP_FILES+=("$SESSION_1")

start_pi_interactive "idle" "$SESSION_1"
send_message "idle" "Say exactly the word IDLE_READY and nothing else."

# Wait for pi to respond and go idle
if wait_for_pattern "$SESSION_1" "IDLE_READY" 30; then
    pass "idle — pi responded"
else
    fail "idle — pi responded" "IDLE_READY not found"
    dump_session_tail "$SESSION_1"
fi

# Pi is now idle (waiting for input). Write the sentinel.
sleep 3
echo "hello-idle" > "/tmp/${SIGNAL_PREFIX}idle"

# Notification should appear in session log — triggerTurn fires immediately
if wait_for_pattern "$SESSION_1" "NOTIFY\[idle\]" 20; then
    pass "idle — notification injected"
else
    fail "idle — notification injected" "notification not found after 20s"
    dump_session_tail "$SESSION_1" 10
fi

# Sentinel should be consumed
if [ ! -f "/tmp/${SIGNAL_PREFIX}idle" ]; then
    pass "idle — sentinel consumed"
else
    fail "idle — sentinel consumed" "file still exists"
fi

# Agent should have responded to the notification (new turn triggered)
sleep 5
NOTIFY_LINE=$(grep -n "NOTIFY\[idle\]" "$SESSION_1" | tail -1 | cut -d: -f1)
if [ -n "$NOTIFY_LINE" ]; then
    AFTER=$(tail -n +"$NOTIFY_LINE" "$SESSION_1" | grep -c '"role":"assistant"' 2>/dev/null || echo 0)
    if [ "$AFTER" -gt 0 ]; then
        pass "idle — agent responded after notification"
    else
        fail "idle — agent responded after notification" "no assistant message after notification"
        dump_session_tail "$SESSION_1" 10
    fi
else
    fail "idle — agent responded after notification" "could not find notification line"
fi

# Close this pi session
tmux send-keys -t "$TMUX_SESSION:idle" "/exit" Enter 2>/dev/null || true

# ─── Test 2: Busy agent — sentinel delivered as steer ─────────────────────

echo ""
echo "--- Test 2: Busy agent gets sentinel as steer ---"

SESSION_2=$(mktemp "${TMPDIR:-/tmp}/ndtest_session.jsonl.XXXXXX")
CLEANUP_FILES+=("$SESSION_2")

start_pi_interactive "busy" "$SESSION_2"
send_message "busy" "Run this exact bash command: echo BUSY_STEP1 && sleep 20 && echo BUSY_STEP2"

# Wait for first step — pi is now streaming/executing tools
if wait_for_pattern "$SESSION_2" "BUSY_STEP1" 30; then
    pass "busy — pi started executing"
else
    fail "busy — pi started executing" "BUSY_STEP1 not seen"
    dump_session_tail "$SESSION_2"
fi

# Pi is mid-stream doing sleep+echo. Write sentinel while busy.
echo "hello-busy" > "/tmp/${SIGNAL_PREFIX}busy"

# Notification should appear after current tool finishes (steer delivery)
if wait_for_pattern "$SESSION_2" "NOTIFY\[busy\]" 90; then
    pass "busy — notification delivered"
else
    fail "busy — notification delivered" "notification not found after 60s"
    dump_session_tail "$SESSION_2" 10
fi

if [ ! -f "/tmp/${SIGNAL_PREFIX}busy" ]; then
    pass "busy — sentinel consumed"
else
    fail "busy — sentinel consumed" "file still exists"
fi

# Steer interrupts — STEP2 may or may not complete depending on timing
if grep -q "BUSY_STEP2" "$SESSION_2" 2>/dev/null; then
    echo "    (note: STEP2 also completed — steer delivered after tool finished)"
fi

tmux send-keys -t "$TMUX_SESSION:busy" "/exit" Enter 2>/dev/null || true

# ─── Test 3: Multiple sentinels consumed ──────────────────────────────────

echo ""
echo "--- Test 3: Multiple sentinels ---"

SESSION_3=$(mktemp "${TMPDIR:-/tmp}/ndtest_session.jsonl.XXXXXX")
CLEANUP_FILES+=("$SESSION_3")

start_pi_interactive "multi" "$SESSION_3"
send_message "multi" "Say exactly MULTI_READY"

if wait_for_pattern "$SESSION_3" "MULTI_READY" 30; then
    pass "multi — pi started"
else
    fail "multi — pi started" "MULTI_READY not found"
fi

sleep 3
echo "alpha" > "/tmp/${SIGNAL_PREFIX}multi-a"
echo "beta" > "/tmp/${SIGNAL_PREFIX}multi-b"

if wait_for_pattern "$SESSION_3" "NOTIFY\[multi-a\]" 20; then
    pass "multi — sentinel A"
else
    fail "multi — sentinel A" "not found"
fi

if wait_for_pattern "$SESSION_3" "NOTIFY\[multi-b\]" 20; then
    pass "multi — sentinel B"
else
    fail "multi — sentinel B" "not found"
fi

if [ ! -f "/tmp/${SIGNAL_PREFIX}multi-a" ] && [ ! -f "/tmp/${SIGNAL_PREFIX}multi-b" ]; then
    pass "multi — all files cleaned up"
else
    fail "multi — all files cleaned up" "files remain"
fi

tmux send-keys -t "$TMUX_SESSION:multi" "/exit" Enter 2>/dev/null || true

# ─── Instance ID & Broadcast Blocking ─────────────────────────────────────
# These tests use a SELF-CONTAINED extension with the real instance ID logic
# but a unique signal prefix, so other running instances can't interfere.

echo "--- T4: Broadcast sentinel blocked ---"

# Generate a test extension that has instance ID filtering + unique prefix
TEST_EXT_4=$(mktemp "${TMPDIR:-/tmp}/ndtest_ext4.ts.XXXXXX")
CLEANUP_FILES+=("$TEST_EXT_4")
TEST_PREFIX_4="ndtest4-${TEST_ID}-"

cat > "$TEST_EXT_4" << EXT4EOF
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

const SIGNAL_DIR = "/tmp";
const SIGNAL_PREFIX = "${TEST_PREFIX_4}";
const POLL_INTERVAL = 2000;

export default function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setInterval> | null = null;
    const instanceId = randomBytes(4).toString("hex");
    process.env.YPI_INSTANCE_ID = instanceId;

    // Write instance ID to a known file so the test can read it
    writeFileSync("/tmp/ndtest4-instance-${TEST_ID}.txt", instanceId);

    pi.on("session_start", async () => {
        timer = setInterval(() => {
            try {
                const files = readdirSync(SIGNAL_DIR).filter((f) => f.startsWith(SIGNAL_PREFIX));
                for (const file of files) {
                    const rest = file.slice(SIGNAL_PREFIX.length);
                    const instanceMatch = rest.match(/^([0-9a-f]{8})-(.+)\$/);
                    if (instanceMatch) {
                        const [, targetId, name] = instanceMatch;
                        if (targetId !== instanceId) continue;
                        try {
                            const content = readFileSync(\`\${SIGNAL_DIR}/\${file}\`, "utf-8").trim();
                            unlinkSync(\`\${SIGNAL_DIR}/\${file}\`);
                            pi.sendMessage(
                                { customType: "notify-done", content: \`NOTIFY[\${name}]: \${content}\`, display: true },
                                { triggerTurn: true },
                            );
                        } catch {}
                    } else {
                        // Broadcast — block and delete
                        try { unlinkSync(\`\${SIGNAL_DIR}/\${file}\`); } catch {}
                    }
                }
            } catch {}
        }, POLL_INTERVAL);
    });

    pi.on("session_shutdown", async () => {
        if (timer) { clearInterval(timer); timer = null; }
    });
}
EXT4EOF
SESSION_4=$(mktemp "${TMPDIR:-/tmp}/ndtest_session.jsonl.XXXXXX")
CLEANUP_FILES+=("$SESSION_4" "/tmp/ndtest4-instance-${TEST_ID}.txt")
tmux new-window -t "$TMUX_SESSION" -n broadcast
tmux send-keys -t "$TMUX_SESSION:broadcast" "pi -e $TEST_EXT_4 --no-extensions --session $SESSION_4" Enter
sleep 8
# Send a message so the session is alive
tmux send-keys -t "$TMUX_SESSION:broadcast" 'Say ok' Enter
sleep 8
# Drop a broadcast sentinel (no instance ID) — should be BLOCKED
echo "should-not-arrive" > /tmp/${TEST_PREFIX_4}broadcast
sleep 8
# Check the sentinel was deleted (cleanup)
if [ ! -f "/tmp/${TEST_PREFIX_4}broadcast" ]; then
    pass "broadcast — sentinel deleted"
else
    fail "broadcast — sentinel deleted" "file still exists"
    rm -f "/tmp/${TEST_PREFIX_4}broadcast"
fi
# Verify the notification was NOT delivered to the session
BROADCAST_HITS=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_4') as f:
        for line in f:
            msg = json.loads(line)
            if msg.get('customType') == 'notify-done':
                if 'should-not-arrive' in str(msg):
                    count += 1
except: pass
print(count)
" 2>/dev/null)
if [ "$BROADCAST_HITS" = "0" ]; then
    pass "broadcast — notification not delivered"
else
    fail "broadcast — notification not delivered" "found $BROADCAST_HITS notifications"
fi
# Now test that a TARGETED sentinel DOES get delivered
INSTANCE_ID=$(cat /tmp/ndtest4-instance-${TEST_ID}.txt 2>/dev/null)
if [ -n "$INSTANCE_ID" ] && [ "${#INSTANCE_ID}" = "8" ]; then
    echo "targeted-ok" > /tmp/${TEST_PREFIX_4}${INSTANCE_ID}-targeted
    sleep 8

    if [ ! -f "/tmp/${TEST_PREFIX_4}${INSTANCE_ID}-targeted" ]; then
        pass "targeted — sentinel consumed"
    else
        fail "targeted — sentinel consumed" "file still exists"
        rm -f "/tmp/${TEST_PREFIX_4}${INSTANCE_ID}-targeted"
    fi
    TARGETED_HITS=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_4') as f:
        for line in f:
            msg = json.loads(line)
            if msg.get('customType') == 'notify-done':
                if 'targeted-ok' in str(msg):
                    count += 1
except: pass
print(count)
" 2>/dev/null)
    if [ "$TARGETED_HITS" -ge 1 ]; then
        pass "targeted — notification delivered"
    else
        fail "targeted — notification delivered" "not found in session"
    fi
else
    fail "targeted — get instance ID" "could not read instance ID file"
fi
tmux send-keys -t "$TMUX_SESSION:broadcast" C-d 2>/dev/null || true

# ─── Test 5: Cross-instance isolation (two concurrent instances) ─────────

echo ""
echo "--- T5: Cross-instance isolation ---"

# Spin up TWO pi instances, each with its own notify-done extension and instance ID.
# Send a targeted sentinel to instance A. Verify:
#   - A receives it
#   - B does NOT receive it
# Then send a broadcast (no instance ID). Verify:
#   - Neither receives it (blocked and deleted)

TEST_PREFIX_5="ndtest5-${TEST_ID}-"
TEST_EXT_5A=$(mktemp "${TMPDIR:-/tmp}/ndtest_ext5a.ts.XXXXXX")
TEST_EXT_5B=$(mktemp "${TMPDIR:-/tmp}/ndtest_ext5b.ts.XXXXXX")
CLEANUP_FILES+=("$TEST_EXT_5A" "$TEST_EXT_5B")

for WHICH in A B; do
    if [ "$WHICH" = "A" ]; then EXT_FILE=$TEST_EXT_5A; else EXT_FILE=$TEST_EXT_5B; fi
    cat > "$EXT_FILE" << EXT5EOF
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

const SIGNAL_DIR = "/tmp";
const SIGNAL_PREFIX = "${TEST_PREFIX_5}";
const POLL_INTERVAL = 2000;

export default function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setInterval> | null = null;
    const instanceId = randomBytes(4).toString("hex");
    process.env.YPI_INSTANCE_ID = instanceId;
    writeFileSync("/tmp/ndtest5-instance-${TEST_ID}-${WHICH}.txt", instanceId);

    pi.on("session_start", async () => {
        timer = setInterval(() => {
            try {
                const files = readdirSync(SIGNAL_DIR).filter((f) => f.startsWith(SIGNAL_PREFIX));
                for (const file of files) {
                    const rest = file.slice(SIGNAL_PREFIX.length);
                    const instanceMatch = rest.match(/^([0-9a-f]{8})-(.+)\$/);
                    if (instanceMatch) {
                        const [, targetId, name] = instanceMatch;
                        if (targetId !== instanceId) continue;
                        try {
                            const content = readFileSync(\`\${SIGNAL_DIR}/\${file}\`, "utf-8").trim();
                            unlinkSync(\`\${SIGNAL_DIR}/\${file}\`);
                            pi.sendMessage(
                                { customType: "notify-done", content: \`NOTIFY[\${name}]: \${content}\`, display: true },
                                { triggerTurn: true },
                            );
                        } catch {}
                    } else {
                        try { unlinkSync(\`\${SIGNAL_DIR}/\${file}\`); } catch {}
                    }
                }
            } catch {}
        }, POLL_INTERVAL);
    });

    pi.on("session_shutdown", async () => {
        if (timer) { clearInterval(timer); timer = null; }
    });
}
EXT5EOF
done

SESSION_5A=$(mktemp "${TMPDIR:-/tmp}/ndtest_session5a.jsonl.XXXXXX")
SESSION_5B=$(mktemp "${TMPDIR:-/tmp}/ndtest_session5b.jsonl.XXXXXX")
CLEANUP_FILES+=("$SESSION_5A" "$SESSION_5B" "/tmp/ndtest5-instance-${TEST_ID}-A.txt" "/tmp/ndtest5-instance-${TEST_ID}-B.txt")

# Start both instances
tmux new-window -t "$TMUX_SESSION" -n inst-a
tmux send-keys -t "$TMUX_SESSION:inst-a" "pi -e $TEST_EXT_5A --no-extensions --session $SESSION_5A" Enter
tmux new-window -t "$TMUX_SESSION" -n inst-b
tmux send-keys -t "$TMUX_SESSION:inst-b" "pi -e $TEST_EXT_5B --no-extensions --session $SESSION_5B" Enter
sleep 8

# Activate both sessions
tmux send-keys -t "$TMUX_SESSION:inst-a" 'Say ok' Enter
tmux send-keys -t "$TMUX_SESSION:inst-b" 'Say ok' Enter
sleep 8

# Read instance IDs
ID_A=$(cat /tmp/ndtest5-instance-${TEST_ID}-A.txt 2>/dev/null)
ID_B=$(cat /tmp/ndtest5-instance-${TEST_ID}-B.txt 2>/dev/null)

if [ -z "$ID_A" ] || [ -z "$ID_B" ]; then
    fail "T5 setup — get instance IDs" "A='$ID_A' B='$ID_B'"
else
    # T5a: Send targeted sentinel to A — only A should receive
    echo "for-A-only" > /tmp/${TEST_PREFIX_5}${ID_A}-crosstest
    sleep 8

    HITS_A=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_5A') as f:
        for line in f:
            msg = json.loads(line)
            if 'for-A-only' in json.dumps(msg):
                count += 1
except: pass
print(count)
" 2>/dev/null)
    HITS_B=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_5B') as f:
        for line in f:
            msg = json.loads(line)
            if 'for-A-only' in json.dumps(msg):
                count += 1
except: pass
print(count)
" 2>/dev/null)

    if [ "$HITS_A" -ge 1 ]; then
        pass "T5a — targeted signal delivered to A"
    else
        fail "T5a — targeted signal delivered to A" "hits=$HITS_A"
    fi
    if [ "$HITS_B" = "0" ]; then
        pass "T5a — targeted signal NOT delivered to B"
    else
        fail "T5a — targeted signal NOT delivered to B" "hits=$HITS_B"
    fi

    # T5b: Send broadcast sentinel — neither should receive
    echo "broadcast-leak" > /tmp/${TEST_PREFIX_5}noinstance
    sleep 8

    if [ ! -f "/tmp/${TEST_PREFIX_5}noinstance" ]; then
        pass "T5b — broadcast sentinel deleted"
    else
        fail "T5b — broadcast sentinel deleted" "file still exists"
        rm -f "/tmp/${TEST_PREFIX_5}noinstance"
    fi

    LEAK_A=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_5A') as f:
        for line in f:
            msg = json.loads(line)
            if 'broadcast-leak' in json.dumps(msg):
                count += 1
except: pass
print(count)
" 2>/dev/null)
    LEAK_B=$(python3 -c "
import json
count = 0
try:
    with open('$SESSION_5B') as f:
        for line in f:
            msg = json.loads(line)
            if 'broadcast-leak' in json.dumps(msg):
                count += 1
except: pass
print(count)
" 2>/dev/null)

    if [ "$LEAK_A" = "0" ]; then
        pass "T5b — broadcast not delivered to A"
    else
        fail "T5b — broadcast not delivered to A" "hits=$LEAK_A"
    fi
    if [ "$LEAK_B" = "0" ]; then
        pass "T5b — broadcast not delivered to B"
    else
        fail "T5b — broadcast not delivered to B" "hits=$LEAK_B"
    fi
fi

tmux send-keys -t "$TMUX_SESSION:inst-a" C-d 2>/dev/null || true
tmux send-keys -t "$TMUX_SESSION:inst-b" C-d 2>/dev/null || true
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
echo "All notify-done tests passed! ✓"

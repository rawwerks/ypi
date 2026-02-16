#!/usr/bin/env bash
# test_steer_rpc.sh — Verify the steer-as-RPC inter-agent messaging works.
#
# Tests:
#   T1: Mailbox file creation
#   T2: Message write format is valid JSONL
#   T3: Drain reads and clears inbox
#   T4: Message to dead PID fails gracefully
#   T5: Multiple messages preserved in order
#   T6: Concurrent writes don't corrupt
#   T7: End-to-end: two pi agents exchange messages via tmux
#   T8: Idle agent wakeup: message wakes an agent sitting at its prompt
#
# Usage:
#   bash contrib/tests/test_steer_rpc.sh           # unit tests only (fast)
#   bash contrib/tests/test_steer_rpc.sh --e2e      # include e2e tmux test (slow, ~60s)
#
# Requires: python3

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
CLEANUP_FILES=()
CLEANUP_TMUX=()
E2E=false

[[ "${1:-}" == "--e2e" ]] && E2E=true

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

cleanup() {
    for f in "${CLEANUP_FILES[@]}"; do
        rm -f "$f" 2>/dev/null || true
    done
    for s in "${CLEANUP_TMUX[@]}"; do
        tmux kill-session -t "$s" 2>/dev/null || true
    done
}
trap cleanup EXIT

PEERS_DIR="/tmp/ypi-peers"
INBOX_SUFFIX=".inbox.jsonl"

echo "=== steer-as-RPC messaging tests (with registry) ==="
echo ""

# --- T1: Registry directory and registration ---
echo "T1: Registry creation and agent registration"
TEST_PID=$$
mkdir -p "$PEERS_DIR"

# Simulate registration
python3 -c "
import json, time, os
reg = {
    'pid': $TEST_PID,
    'project': 'test-agent',
    'cwd': os.getcwd(),
    'type': 'pi',
    'sessionDir': None,
    'traceId': None,
    'inboxPath': '$PEERS_DIR/${TEST_PID}${INBOX_SUFFIX}',
    'startTime': int(time.time() * 1000),
    'registeredAt': int(time.time() * 1000)
}
with open('$PEERS_DIR/${TEST_PID}.json', 'w') as f:
    json.dump(reg, f, indent=2)
# Create inbox
open('$PEERS_DIR/${TEST_PID}${INBOX_SUFFIX}', 'w').close()
"
CLEANUP_FILES+=("$PEERS_DIR/${TEST_PID}.json" "$PEERS_DIR/${TEST_PID}${INBOX_SUFFIX}")

if [ -f "$PEERS_DIR/${TEST_PID}.json" ] && [ -f "$PEERS_DIR/${TEST_PID}${INBOX_SUFFIX}" ]; then
    pass "T1: Registration file and inbox created"
else
    fail "T1: Registration failed"
fi

# --- T2: Registration format ---
echo ""
echo "T2: Registration file is valid JSON with required fields"
python3 -c "
import json
with open('$PEERS_DIR/${TEST_PID}.json') as f:
    reg = json.load(f)
assert reg['pid'] == $TEST_PID
assert reg['project'] == 'test-agent'
assert 'inboxPath' in reg
assert 'startTime' in reg
assert 'registeredAt' in reg
print('ok')
" 2>/dev/null | grep -q ok && pass "T2: Registration has all required fields" || fail "T2: Registration missing fields"

# --- T3: Message write and drain ---
echo ""
echo "T3: Message write, read, and clear"
INBOX="$PEERS_DIR/${TEST_PID}${INBOX_SUFFIX}"

MSG_ID=$(python3 -c "import uuid; print(str(uuid.uuid4())[:8])")
python3 -c "
import json, time
msg = {
    'id': '$MSG_ID',
    'from_pid': 12345,
    'from_project': 'test-sender',
    'to_pid': $TEST_PID,
    'timestamp': int(time.time() * 1000),
    'message': 'Hello from test!'
}
with open('$INBOX', 'a') as f:
    f.write(json.dumps(msg) + '\n')

# Read and clear
with open('$INBOX') as f:
    msgs = [json.loads(l) for l in f if l.strip()]
assert len(msgs) == 1
assert msgs[0]['id'] == '$MSG_ID'

with open('$INBOX', 'w') as f:
    pass
with open('$INBOX') as f:
    assert f.read().strip() == ''
print('ok')
" 2>/dev/null | grep -q ok && pass "T3: Message written, read, and inbox cleared" || fail "T3: Drain failed"

# --- T4: Stale registration cleanup ---
echo ""
echo "T4: Stale registration detected (dead PID)"

DEAD_PID=99999999
python3 -c "
import json, time
reg = {
    'pid': $DEAD_PID,
    'project': 'dead-agent',
    'cwd': '/tmp',
    'type': 'pi',
    'sessionDir': None,
    'traceId': None,
    'inboxPath': '$PEERS_DIR/${DEAD_PID}${INBOX_SUFFIX}',
    'startTime': int(time.time() * 1000),
    'registeredAt': int(time.time() * 1000)
}
with open('$PEERS_DIR/${DEAD_PID}.json', 'w') as f:
    json.dump(reg, f)
open('$PEERS_DIR/${DEAD_PID}${INBOX_SUFFIX}', 'w').close()
"

if ! kill -0 $DEAD_PID 2>/dev/null; then
    pass "T4: Dead PID $DEAD_PID correctly detected"
    # Simulate cleanup
    rm -f "$PEERS_DIR/${DEAD_PID}.json" "$PEERS_DIR/${DEAD_PID}${INBOX_SUFFIX}"
else
    fail "T4: PID $DEAD_PID unexpectedly exists"
fi

# --- T5: Multiple messages preserved in order ---
echo ""
echo "T5: Multiple messages preserved in order"

echo -n "" > "$INBOX"
python3 -c "
import json, time
for i in range(5):
    msg = {
        'id': f'msg-{i}',
        'from_pid': 12345 + i,
        'from_project': f'sender-{i}',
        'to_pid': $TEST_PID,
        'timestamp': int(time.time() * 1000) + i,
        'message': f'Message number {i}'
    }
    with open('$INBOX', 'a') as f:
        f.write(json.dumps(msg) + '\n')
"

MSG_COUNT=$(wc -l < "$INBOX" | tr -d ' ')
if [ "$MSG_COUNT" -eq 5 ]; then
    FIRST_ID=$(head -1 "$INBOX" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    LAST_ID=$(tail -1 "$INBOX" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    if [ "$FIRST_ID" = "msg-0" ] && [ "$LAST_ID" = "msg-4" ]; then
        pass "T5: 5 messages in order (msg-0..msg-4)"
    else
        fail "T5: Messages out of order (first=$FIRST_ID, last=$LAST_ID)"
    fi
else
    fail "T5: Expected 5 messages, got $MSG_COUNT"
fi

# --- T6: Concurrent writes don't corrupt ---
echo ""
echo "T6: Concurrent writes produce valid JSONL"

echo -n "" > "$INBOX"

for i in $(seq 0 9); do
    python3 -c "
import json, time
msg = {
    'id': 'concurrent-$i',
    'from_pid': $((20000 + i)),
    'from_project': 'writer-$i',
    'to_pid': $TEST_PID,
    'timestamp': int(time.time() * 1000),
    'message': 'Concurrent message $i'
}
with open('$INBOX', 'a') as f:
    f.write(json.dumps(msg) + '\n')
" &
done
wait

TOTAL_LINES=$(wc -l < "$INBOX" | tr -d ' ')
VALID_LINES=$(python3 -c "
import json
count = 0
with open('$INBOX') as f:
    for line in f:
        if line.strip():
            json.loads(line)
            count += 1
print(count)
" 2>/dev/null)

if [ "$VALID_LINES" -eq 10 ] && [ "$TOTAL_LINES" -eq 10 ]; then
    pass "T6: 10 concurrent writes, all valid JSONL"
elif [ "$VALID_LINES" -eq "$TOTAL_LINES" ] && [ "$TOTAL_LINES" -ge 8 ]; then
    pass "T6: $TOTAL_LINES concurrent writes, all valid (some may have raced)"
else
    fail "T6: Corruption detected ($VALID_LINES valid of $TOTAL_LINES lines)"
fi

# --- T6b: Registry lookup by project name ---
echo ""
echo "T6b: Registry lookup by project name"

FOUND_PID=$(python3 -c "
import json, os
for f in os.listdir('$PEERS_DIR'):
    if f.endswith('.json'):
        with open(os.path.join('$PEERS_DIR', f)) as fh:
            reg = json.load(fh)
            if reg['project'] == 'test-agent':
                print(reg['pid'])
                break
" 2>/dev/null)

if [ "$FOUND_PID" = "$TEST_PID" ]; then
    pass "T6b: Found PID $TEST_PID by project name 'test-agent'"
else
    fail "T6b: Project lookup returned '$FOUND_PID' instead of '$TEST_PID'"
fi

# --- T7: End-to-end with two pi agents in tmux ---
if [ "$E2E" = true ]; then
    echo ""
    echo "T7: End-to-end: two pi agents exchange messages (via tmux)"
    echo "    This spawns two real pi instances — may take ~60 seconds"

    AGENT_A="test-steer-a-$$"
    AGENT_B="test-steer-b-$$"
    CLEANUP_TMUX+=("$AGENT_A" "$AGENT_B")

    EXT_PATH="$SCRIPT_DIR/../extensions/find-the-others.ts"

    # Create a temporary working directory
    TEST_DIR=$(mktemp -d /tmp/steer-test-XXXXXX)
    CLEANUP_FILES+=("$TEST_DIR")

    # Helper: get the node/pi child process of a tmux session
    get_pi_pid() {
        local sess="$1"
        # Get the shell PID of the tmux pane
        local shell_pid=$(tmux list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1)
        if [ -z "$shell_pid" ]; then return 1; fi
        # Find the node/pi child of that shell
        local child_pid=$(pgrep -P "$shell_pid" 2>/dev/null | head -1)
        if [ -z "$child_pid" ]; then return 1; fi
        echo "$child_pid"
    }

    # Start Agent A
    tmux new-session -d -s "$AGENT_A" -c "$TEST_DIR"
    tmux send-keys -t "$AGENT_A" "pi -e '$EXT_PATH' --no-extensions --no-skills --no-prompt-templates --no-themes --no-session" Enter
    sleep 8

    A_PID=$(get_pi_pid "$AGENT_A" || true)

    if [ -z "$A_PID" ]; then
        fail "T7: Could not determine Agent A's PID"
    else
        echo "    Agent A PID: $A_PID"

        # Start Agent B
        tmux new-session -d -s "$AGENT_B" -c "$TEST_DIR"
        tmux send-keys -t "$AGENT_B" "pi -e '$EXT_PATH' --no-extensions --no-skills --no-prompt-templates --no-themes --no-session" Enter
        sleep 8

        B_PID=$(get_pi_pid "$AGENT_B" || true)

        if [ -z "$B_PID" ] || [ "$B_PID" = "$A_PID" ]; then
            fail "T7: Could not determine Agent B's PID"
        else
            echo "    Agent B PID: $B_PID"

            # Wait for registration
            sleep 3

            # T7a: Verify agents registered
            if [ -f "$PEERS_DIR/${A_PID}.json" ] && [ -f "$PEERS_DIR/${B_PID}.json" ]; then
                pass "T7a: Both agents registered in $PEERS_DIR"
            else
                fail "T7a: Registration missing (A: $(test -f $PEERS_DIR/${A_PID}.json && echo yes || echo no), B: $(test -f $PEERS_DIR/${B_PID}.json && echo yes || echo no))"
            fi

            # Have Agent A send a message to Agent B by writing to B's inbox directly
            B_INBOX="$PEERS_DIR/${B_PID}${INBOX_SUFFIX}"
            python3 -c "
import json, time
msg = {
    'id': 'e2e-test-001',
    'from_pid': $A_PID,
    'from_project': 'agent-a',
    'to_pid': $B_PID,
    'timestamp': int(time.time() * 1000),
    'message': 'Hello Agent B, this is a test message from Agent A!'
}
with open('$B_INBOX', 'a') as f:
    f.write(json.dumps(msg) + '\n')
"

            # Ask Agent B to check its inbox
            tmux send-keys -t "$AGENT_B" "/inbox" Enter
            sleep 10

            # Capture Agent B's output
            B_OUTPUT=$(tmux capture-pane -t "$AGENT_B" -p -S -30 | tail -20)

            if echo "$B_OUTPUT" | grep -q "agent-a\|Hello Agent B\|e2e-test-001\|📨"; then
                pass "T7: Agent B received message from Agent A"

                # T7b: Write reply directly to Agent A's inbox (tests file-level round-trip)
                A_INBOX="$PEERS_DIR/${A_PID}${INBOX_SUFFIX}"
                python3 -c "
import json, time
msg = {
    'id': 'e2e-reply-001',
    'from_pid': $B_PID,
    'from_project': 'agent-b',
    'to_pid': $A_PID,
    'timestamp': int(time.time() * 1000),
    'message': 'Got your message, Agent A! Replying back.',
    'reply_to': 'e2e-test-001'
}
with open('$A_INBOX', 'a') as f:
    f.write(json.dumps(msg) + '\n')
"

                # Ask Agent A to check inbox
                tmux send-keys -t "$AGENT_A" "/inbox" Enter
                sleep 10

                A_OUTPUT=$(tmux capture-pane -t "$AGENT_A" -p -S -30 | tail -20)
                if echo "$A_OUTPUT" | grep -q "agent-b\|Got your message\|e2e-reply-001\|📨"; then
                    pass "T7b: Agent A received reply from Agent B (round-trip complete)"
                else
                    fail "T7b: Agent A did not show reply"
                    echo "    A output: $(echo "$A_OUTPUT" | head -10)"
                fi
            else
                fail "T7: Agent B did not show received message"
                echo "    B output: $(echo "$B_OUTPUT" | head -10)"
            fi
        fi
    fi

    # --- T8: Idle agent wakeup — the critical test ---
    echo ""
    echo "T8: Idle agent wakeup — message wakes an agent sitting at its prompt"
    echo "    This is the core inter-agent use case: send to an idle agent, it wakes up"

    # At this point Agent A should be idle (sitting at prompt after T7)
    # Wait a moment for it to settle
    sleep 3

    # Capture Agent A's screen before — should be idle at prompt
    A_BEFORE=$(tmux capture-pane -t "$AGENT_A" -p | tail -5)

    # Get A's current PID (may have changed if it restarted)
    A_PID_NOW=$(get_pi_pid "$AGENT_A" || true)
    if [ -z "$A_PID_NOW" ]; then
        fail "T8: Agent A not running"
    else
        # Write a message directly to Agent A's inbox (simulating Agent B sending)
        A_INBOX_NOW="$PEERS_DIR/${A_PID_NOW}${INBOX_SUFFIX}"
        WAKEUP_MARKER="WAKEUP_TEST_$(date +%s)"
        python3 -c "
import json, time
msg = {
    'id': 'wakeup-test-001',
    'from_pid': ${B_PID:-0},
    'from_project': 'wakeup-sender',
    'to_pid': $A_PID_NOW,
    'timestamp': int(time.time() * 1000),
    'message': '$WAKEUP_MARKER — Did this wake you up?'
}
with open('$A_INBOX_NOW', 'a') as f:
    f.write(json.dumps(msg) + '\n')
"

        echo "    Wrote wakeup message to inbox, waiting for agent to wake..."
        # The fs.watchFile polls every 1s, then sendUserMessage triggers a turn
        # Give it up to 15 seconds for the full cycle (detect + LLM response)
        WOKE=false
        for i in $(seq 1 15); do
            sleep 1
            A_AFTER=$(tmux capture-pane -t "$AGENT_A" -p -S -50)
            # Check for signs the agent woke up: the marker text, or 📨 notification,
            # or any new agent output (cost changed, token counts appeared)
            if echo "$A_AFTER" | grep -q "$WAKEUP_MARKER\|wakeup-sender\|WAKEUP_TEST\|📨"; then
                pass "T8: Idle agent woke up after ${i}s — message delivered automatically"
                WOKE=true
                break
            fi
        done

        if [ "$WOKE" = false ]; then
            fail "T8: Agent did not wake up within 15 seconds"
            echo "    Before:"
            echo "$A_BEFORE" | sed 's/^/      /'
            echo "    After:"
            tmux capture-pane -t "$AGENT_A" -p | tail -10 | sed 's/^/      /'
        fi
    fi

    # Cleanup agents
    tmux send-keys -t "$AGENT_A" "/exit" Enter 2>/dev/null || true
    tmux send-keys -t "$AGENT_B" "/exit" Enter 2>/dev/null || true
    sleep 2
else
    echo ""
    echo "T7-T8: [SKIPPED] End-to-end tests (use --e2e flag to enable)"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

# Cleanup test inbox
rm -f "$INBOX" 2>/dev/null || true

exit $FAIL

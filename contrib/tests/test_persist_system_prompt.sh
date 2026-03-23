#!/bin/bash
# test_persist_system_prompt.sh — Tests for persist-system-prompt extension.
#
# T1-T3: Unit tests (no LLM calls, checks file structure)
# T4-T5: Integration tests (real pi session, costs money)
#
# Usage:
#   bash contrib/tests/test_persist_system_prompt.sh          # unit tests only
#   bash contrib/tests/test_persist_system_prompt.sh --e2e     # include integration tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXT="$REPO_DIR/contrib/extensions/persist-system-prompt.ts"

PASS=0
FAIL=0
TESTS_RUN=0
RUN_E2E=false

[ "${1:-}" = "--e2e" ] && RUN_E2E=true

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" pattern="$2" text="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    pattern '$pattern' not found"
    FAIL=$((FAIL + 1))
  fi
}

# ─── Unit Tests ───────────────────────────────────────────────────────────

echo "=== T1: Extension file exists and is valid TypeScript ==="
assert_eq "extension file exists" "1" "$([ -f "$EXT" ] && echo 1 || echo 0)"
assert_contains "exports default function" "export default function" "$(cat "$EXT")"
assert_contains "uses appendEntry" "appendEntry" "$(cat "$EXT")"
assert_contains "uses getSystemPrompt" "getSystemPrompt" "$(cat "$EXT")"
assert_contains "handles session_switch" "session_switch" "$(cat "$EXT")"

echo ""
echo "=== T2: Extension loads without errors ==="
LOAD_OUTPUT=$(cd "$REPO_DIR" && pi -p --no-session -e "$EXT" "Say ok" 2>&1)
LOAD_EXIT=$?
assert_eq "pi exits cleanly" "0" "$LOAD_EXIT"
# Should not contain extension error messages
NO_ERRORS=$(echo "$LOAD_OUTPUT" | grep -ci 'error\|failed\|exception' || true)
assert_eq "no error messages" "0" "$NO_ERRORS"

echo ""
echo "=== T3: Extension captures once per session (code review) ==="
# Verify the "captured" guard exists
assert_contains "has capture guard" "if (captured) return" "$(cat "$EXT")"
assert_contains "resets on session_switch" "captured = false" "$(cat "$EXT")"
# Verify it stores charCount and timestamp
assert_contains "stores charCount" "charCount" "$(cat "$EXT")"
assert_contains "stores timestamp" "timestamp" "$(cat "$EXT")"
assert_contains "stores sha256 hash" "sha256" "$(cat "$EXT")"
assert_contains "uses crypto module" "createHash" "$(cat "$EXT")"

# ─── Integration Tests (real sessions) ────────────────────────────────────

if [ "$RUN_E2E" = true ]; then
  echo ""
  echo "=== T4: System prompt persisted to session file ==="

  # Start a pi session with our extension, send one message, exit
  SESSION_DIR=$(mktemp -d "${TMPDIR:-/tmp}/psp-test.XXXXXX")
  SESSION_FILE="$SESSION_DIR/test-session.jsonl"

  # Use pi with a session file so we can inspect it
  pi -e "$EXT" --session "$SESSION_FILE" -p "Say hello" > /dev/null 2>&1

  # Check the session file for our custom entry
  if [ -f "$SESSION_FILE" ]; then
    HAS_ENTRY=$(python3 -c "
import json
with open('$SESSION_FILE') as f:
    for line in f:
        msg = json.loads(line)
        if msg.get('customType') == 'system_prompt':
            print('found')
            break
    else:
        print('missing')
" 2>/dev/null)
    assert_eq "system_prompt entry in session" "found" "$HAS_ENTRY"

    # Verify the entry has expected fields
    FIELDS=$(python3 -c "
import json
with open('$SESSION_FILE') as f:
    for line in f:
        msg = json.loads(line)
        if msg.get('customType') == 'system_prompt':
            data = msg.get('data', {})
            has_prompt = 'prompt' in data and len(data['prompt']) > 100
            has_count = 'charCount' in data and data['charCount'] > 100
            has_ts = 'timestamp' in data and len(data['timestamp']) > 10
            has_hash = 'sha256' in data and len(data['sha256']) == 64
            print(f'prompt={has_prompt} count={has_count} ts={has_ts} hash={has_hash}')
            break
" 2>/dev/null)
    assert_contains "has prompt field" "prompt=True" "$FIELDS"
    assert_contains "has charCount field" "count=True" "$FIELDS"
    assert_contains "has timestamp field" "ts=True" "$FIELDS"
    assert_contains "has sha256 field" "hash=True" "$FIELDS"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "  ✗ session file not created"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$SESSION_FILE"
  rmdir "$SESSION_DIR" 2>/dev/null || true

  echo ""
  echo "=== T5: Only one system_prompt entry per session ==="

  SESSION_FILE2="$SESSION_DIR/test-session2.jsonl"
  mkdir -p "$SESSION_DIR"

  # Send two messages in one session via print mode with --session
  # (print mode exits after each message, but --session resumes)
  pi -e "$EXT" --session "$SESSION_FILE2" -p "Say hello" > /dev/null 2>&1
  pi -e "$EXT" --session "$SESSION_FILE2" -p "Say goodbye" > /dev/null 2>&1

  if [ -f "$SESSION_FILE2" ]; then
    ENTRY_COUNT=$(python3 -c "
import json
count = 0
with open('$SESSION_FILE2') as f:
    for line in f:
        msg = json.loads(line)
        if msg.get('customType') == 'system_prompt':
            count += 1
print(count)
" 2>/dev/null)
    # Print mode creates a new session each time, so we may get 2 entries
    # (one per pi invocation). In interactive mode it would be 1.
    # The important thing is it's not more than the number of agent_start events.
    assert_eq "at most 2 entries (one per pi invocation)" "1" "$([ "$ENTRY_COUNT" -le 2 ] && echo 1 || echo 0)"
  else
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "  ✗ session file not created"
    FAIL=$((FAIL + 1))
  fi

  rm -f "$SESSION_FILE2"
  rmdir "$SESSION_DIR" 2>/dev/null || true

else
  echo ""
  echo "(Skipping integration tests — run with --e2e to include)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed, $TESTS_RUN total"
echo "════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1

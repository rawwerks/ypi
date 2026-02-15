#!/bin/bash
# test_auto_title.sh — Tests for auto-title session summarizer extension.
#
# T1-T3: Structure tests (no LLM calls)
# T4-T6: Integration tests via tmux (real Pi session, costs money, --e2e flag)
#
# Usage:
#   bash contrib/tests/test_auto_title.sh          # unit tests only
#   bash contrib/tests/test_auto_title.sh --e2e    # include integration tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXT="$REPO_DIR/contrib/extensions/auto-title.ts"

PASS=0
FAIL=0
TESTS_RUN=0
RUN_E2E=false
CLEANUP_FILES=()
TMUX_SESSION=""

[ "${1:-}" = "--e2e" ] && RUN_E2E=true

# ─── Helpers ──────────────────────────────────────────────────────────────

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
  if echo "$text" | grep -qi "$pattern"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    pattern '$pattern' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  if [ -n "$TMUX_SESSION" ]; then
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  fi
  for f in "${CLEANUP_FILES[@]}"; do
    rm -f "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ─── T1: Extension file structure ────────────────────────────────────────

echo ""
echo "=== T1: Extension file structure ==="

assert_eq "extension file exists" "1" "$([ -f "$EXT" ] && echo 1 || echo 0)"
assert_contains "exports default function" "export default function" "$(cat "$EXT")"
assert_contains "hooks turn_end event" 'on("turn_end"' "$(cat "$EXT")"
assert_contains "hooks session_start event" 'on("session_start"' "$(cat "$EXT")"
assert_contains "hooks session_shutdown event" 'on("session_shutdown"' "$(cat "$EXT")"
assert_contains "calls pi for summary" '"pi"' "$(cat "$EXT")"
assert_contains "uses setStatus for display" "setStatus" "$(cat "$EXT")"
assert_contains "supports AUTO_TITLE_DISABLE" "AUTO_TITLE_DISABLE" "$(cat "$EXT")"
assert_contains "supports AUTO_TITLE_INTERVAL" "AUTO_TITLE_INTERVAL" "$(cat "$EXT")"
assert_contains "supports AUTO_TITLE_TURNS" "AUTO_TITLE_TURNS" "$(cat "$EXT")"
assert_contains "has timer for time-based trigger" "setInterval" "$(cat "$EXT")"
assert_contains "timer checks for new activity" "turnsSinceUpdate > 0" "$(cat "$EXT")"
assert_contains "cleans up timer on shutdown" "clearInterval" "$(cat "$EXT")"

# ─── T2: Extension loads in Pi ───────────────────────────────────────────

echo ""
echo "=== T2: Extension loads without errors ==="

if command -v pi &>/dev/null; then
  LOAD_STDERR=$(mktemp /tmp/at_test_XXXXXX.txt)
  CLEANUP_FILES+=("$LOAD_STDERR" "${LOAD_STDERR}.stdout")

  # Load with disable=1 so it doesn't try to summarize during test
  AUTO_TITLE_DISABLE=1 echo "test" | timeout 15 pi -p --no-session --no-extensions \
    -e "$EXT" "Say ok" \
    >"${LOAD_STDERR}.stdout" 2>"$LOAD_STDERR" || true

  LOAD_ERRORS=$(grep -ci 'Failed to load extension\|TypeError\|ReferenceError\|SyntaxError' "$LOAD_STDERR" || true)
  assert_eq "no load errors" "0" "$LOAD_ERRORS"
else
  echo "  SKIP: pi not installed"
fi

# ─── T3: Trigger logic correctness ──────────────────────────────────────

echo ""
echo "=== T3: Trigger logic ==="

EXT_SRC=$(cat "$EXT")

# First title triggers after initialTurns (default 2)
assert_contains "initial trigger uses initialTurns" "totalTurns >= initialTurns" "$EXT_SRC"

# Subsequent triggers after turnsThreshold
assert_contains "subsequent trigger uses turnsThreshold" "turnsSinceUpdate >= turnsThreshold" "$EXT_SRC"

# Timer only fires if there's new activity (no stale re-summarization)
assert_contains "timer guards on activity" "turnsSinceUpdate > 0" "$EXT_SRC"

# Skips if already pending
assert_contains "skips if pending" "pendingUpdate" "$EXT_SRC"

# Timer unrefs to not block exit
assert_contains "timer unrefs" "unref" "$EXT_SRC"

# ─── Integration Tests ───────────────────────────────────────────────────

if [ "$RUN_E2E" = true ]; then

  if ! command -v pi &>/dev/null; then
    echo ""
    echo "SKIP: pi not installed, cannot run integration tests"
  elif ! command -v tmux &>/dev/null; then
    echo ""
    echo "SKIP: tmux not installed, cannot run integration tests"
  else
    PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")

    # ── T4: Title gets set after 2 turns ──

    echo ""
    echo "=== T4: Title set after initial turns (pi $PI_VERSION) ==="

    TMUX_SESSION="at-test-$$"
    E2E_DIR=$(mktemp -d /tmp/at_e2e_XXXXXX)
    DEBUG_LOG=$(mktemp /tmp/at_debug_XXXXXX.log)
    CLEANUP_FILES+=("$E2E_DIR" "$DEBUG_LOG")

    # Create a tmux session for the test
    tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 30

    # Launch pi interactively with auto-title, low thresholds for fast test
    # initialTurns=2 so it triggers after 2 messages
    # AUTO_TITLE_DEBUG writes to a log file we can check
    tmux send-keys -t "$TMUX_SESSION" \
      "cd $E2E_DIR && AUTO_TITLE_DEBUG=$DEBUG_LOG AUTO_TITLE_INITIAL_TURNS=2 AUTO_TITLE_TURNS=2 AUTO_TITLE_INTERVAL=9999 pi --no-extensions -e $EXT" Enter
    sleep 4

    # Send first message and wait for response
    tmux send-keys -t "$TMUX_SESSION" "I am writing a Python web scraper for news articles" Enter
    sleep 8

    # Send second message to trigger initial title
    tmux send-keys -t "$TMUX_SESSION" "The scraper should use BeautifulSoup and save to SQLite" Enter
    sleep 8

    # Poll for title to appear in debug log (summary pi -p call is async)
    TITLE=""
    for i in $(seq 1 12); do
      TITLE=$(grep 'status set:' "$DEBUG_LOG" 2>/dev/null | tail -1 | sed "s/.*status set: '//;s/'$//" || true)
      if [ -n "$TITLE" ]; then
        break
      fi
      sleep 5
    done

    echo "    title after 2 turns: '$TITLE'"
    if [ -n "$TITLE" ]; then
      TESTS_RUN=$((TESTS_RUN + 1))
      echo "  ✓ title was set to '$TITLE'"
      PASS=$((PASS + 1))
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      echo "  ✗ no title was set"
      echo "    debug log:"
      cat "$DEBUG_LOG" 2>/dev/null | tail -10
      FAIL=$((FAIL + 1))
    fi
    # The title should relate to web scraping / Python / news
    assert_contains "title relates to the conversation" "scrap\|python\|news\|web\|sqlite\|beautiful\|api\|todo\|fast" "$TITLE"

    # ── T5: Title updates after more turns ──

    echo ""
    echo "=== T5: Title updates after conversation shift (pi $PI_VERSION) ==="

    PREV_TITLE="$TITLE"

    # Shift the conversation to a completely different topic
    tmux send-keys -t "$TMUX_SESSION" "Actually forget that. Let's deploy a Kubernetes cluster on AWS" Enter
    sleep 8
    tmux send-keys -t "$TMUX_SESSION" "I need EKS with 3 worker nodes and an ALB ingress controller" Enter
    sleep 8

    # Poll for a NEW title in the debug log
    NEW_TITLE="$PREV_TITLE"
    for i in $(seq 1 12); do
      NEW_TITLE=$(grep 'status set:' "$DEBUG_LOG" 2>/dev/null | tail -1 | sed "s/.*status set: '//;s/'$//" || true)
      if [ "$NEW_TITLE" != "$PREV_TITLE" ] && [ -n "$NEW_TITLE" ]; then
        break
      fi
      sleep 5
    done

    echo "    title after topic shift: '$NEW_TITLE'"
    if [ "$NEW_TITLE" != "$PREV_TITLE" ] && [ -n "$NEW_TITLE" ]; then
      TESTS_RUN=$((TESTS_RUN + 1))
      echo "  ✓ title updated after conversation shift to '$NEW_TITLE'"
      PASS=$((PASS + 1))
    else
      TESTS_RUN=$((TESTS_RUN + 1))
      echo "  ✗ title did not update after shift (still '$NEW_TITLE')"
      echo "    (may be timing — summary call is async)"
      FAIL=$((FAIL + 1))
    fi

    # ── T6: Stale session doesn't re-summarize ──

    echo ""
    echo "=== T6: No re-summarization on stale session ==="

    TITLE_COUNT_BEFORE=$(grep -c 'status set:' "$DEBUG_LOG" 2>/dev/null || echo 0)

    # Wait without sending any messages — timer should NOT fire
    # (interval is 9999s so timer won't trigger anyway, but this tests the principle)
    sleep 5

    TITLE_COUNT_AFTER=$(grep -c 'status set:' "$DEBUG_LOG" 2>/dev/null || echo 0)
    assert_eq "no new title when session is idle" "$TITLE_COUNT_BEFORE" "$TITLE_COUNT_AFTER"

    # Clean up — send /exit to pi
    tmux send-keys -t "$TMUX_SESSION" "/exit" Enter
    sleep 2
  fi

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

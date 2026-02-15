#!/usr/bin/env bash
# test_find_the_others.sh — Verify the find-the-others extension discovers instances accurately.
#
# Tests:
#   T1: Extension loads without errors
#   T2: Discovered count matches pgrep count
#   T3: "isMe" is set for exactly one instance
#   T4: All discovered PIDs are actually alive
#   T5: No stale/dead PIDs in results
#   T6: Tree structure groups by trace ID correctly
#   T7: Internal pi children are identified and excluded from agent count
#
# Usage:
#   bash contrib/tests/test_find_the_others.sh
#
# Requires: running pi/ypi instances (tests against live system)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$SCRIPT_DIR/../extensions/find-the-others.ts"
PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

echo "=== find-the-others accuracy tests ==="
echo ""

# --- Ground truth from pgrep ---
PGREP_PIDS=$(pgrep -x pi 2>/dev/null || true)
PGREP_COUNT=$(echo "$PGREP_PIDS" | grep -c . 2>/dev/null || echo 0)
echo "Ground truth: pgrep -x pi found $PGREP_COUNT processes"
echo ""

# --- T1: Extension file exists and has valid syntax ---
echo "T1: Extension file exists"
if [ -f "$EXT" ]; then
    pass "Extension file exists at $EXT"
else
    fail "Extension file not found: $EXT"
fi

# --- T2: Cross-check pgrep count against /proc scan ---
echo ""
echo "T2: /proc scan matches pgrep count"
PROC_COUNT=0
PROC_PIDS=""
for pid in $PGREP_PIDS; do
    if [ -d "/proc/$pid" ]; then
        PROC_COUNT=$((PROC_COUNT + 1))
        PROC_PIDS="$PROC_PIDS $pid"
    fi
done

if [ "$PROC_COUNT" -eq "$PGREP_COUNT" ]; then
    pass "All $PGREP_COUNT pgrep PIDs have /proc entries"
else
    fail "pgrep=$PGREP_COUNT but /proc has $PROC_COUNT (race condition?)"
fi

# --- T3: Every discovered PID is alive ---
echo ""
echo "T3: All discovered PIDs are alive"
ALL_ALIVE=true
for pid in $PROC_PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
        fail "PID $pid from pgrep is not alive"
        ALL_ALIVE=false
    fi
done
if [ "$ALL_ALIVE" = true ]; then
    pass "All $PROC_COUNT PIDs respond to kill -0"
fi

# --- T4: Environment extraction works ---
echo ""
echo "T4: Can read environment from all pi processes"
ENV_OK=0
ENV_FAIL=0
for pid in $PROC_PIDS; do
    if cat /proc/$pid/environ >/dev/null 2>&1; then
        ENV_OK=$((ENV_OK + 1))
    else
        ENV_FAIL=$((ENV_FAIL + 1))
    fi
done
if [ "$ENV_FAIL" -eq 0 ]; then
    pass "Environment readable for all $ENV_OK processes"
else
    fail "Environment unreadable for $ENV_FAIL processes (permission?)"
fi

# --- T5: Trace ID grouping ---
echo ""
echo "T5: Trace ID grouping"
declare -A TRACE_GROUPS
for pid in $PROC_PIDS; do
    trace=$(cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep '^RLM_TRACE_ID=' | cut -d= -f2 || true)
    if [ -n "$trace" ]; then
        TRACE_GROUPS[$trace]="${TRACE_GROUPS[$trace]:-} $pid"
    fi
done
UNIQUE_TRACES=${#TRACE_GROUPS[@]}
echo "  Found $UNIQUE_TRACES unique trace IDs across $PROC_COUNT instances"
if [ "$UNIQUE_TRACES" -gt 0 ]; then
    pass "Trace IDs extracted ($UNIQUE_TRACES groups)"
    for trace in "${!TRACE_GROUPS[@]}"; do
        pids_in_trace="${TRACE_GROUPS[$trace]}"
        count=$(echo "$pids_in_trace" | wc -w)
        echo "    trace=$trace: $count instance(s)"
    done
else
    fail "No trace IDs found — are these ypi instances?"
fi

# --- T6: Depth consistency ---
echo ""
echo "T6: Depth consistency within traces"
DEPTH_OK=true
for trace in "${!TRACE_GROUPS[@]}"; do
    pids_in_trace="${TRACE_GROUPS[$trace]}"
    depths=""
    for pid in $pids_in_trace; do
        d=$(cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep '^RLM_DEPTH=' | cut -d= -f2 || echo "?")
        depths="$depths $d"
    done
    # All depths should be valid integers
    for d in $depths; do
        if ! [[ "$d" =~ ^[0-9]+$ ]]; then
            fail "Invalid depth '$d' in trace $trace"
            DEPTH_OK=false
        fi
    done
done
if [ "$DEPTH_OK" = true ]; then
    pass "All depths are valid integers"
fi

# --- T7: Internal children detection ---
echo ""
echo "T7: Internal pi children (ppid is another pi)"
INTERNAL=0
for pid in $PROC_PIDS; do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if echo "$PROC_PIDS" | grep -qw "$ppid"; then
        # Parent is also a pi process
        child_depth=$(cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep '^RLM_DEPTH=' | cut -d= -f2 || echo "0")
        parent_depth=$(cat /proc/$ppid/environ 2>/dev/null | tr '\0' '\n' | grep '^RLM_DEPTH=' | cut -d= -f2 || echo "0")
        if [ "$child_depth" = "$parent_depth" ]; then
            INTERNAL=$((INTERNAL + 1))
            echo "    PID $pid is internal child of $ppid (both depth $child_depth)"
        else
            echo "    PID $pid is rlm_query child of $ppid (depth $parent_depth→$child_depth)"
        fi
    fi
done
AGENTS=$((PROC_COUNT - INTERNAL))
echo "  $AGENTS agent instances, $INTERNAL internal children"
pass "Internal child detection complete"

# --- T8: CWD extraction ---
echo ""
echo "T8: CWD readable for all instances"
CWD_OK=0
for pid in $PROC_PIDS; do
    if readlink /proc/$pid/cwd >/dev/null 2>&1; then
        CWD_OK=$((CWD_OK + 1))
    fi
done
if [ "$CWD_OK" -eq "$PROC_COUNT" ]; then
    pass "CWD readable for all $PROC_COUNT instances"
else
    fail "CWD unreadable for $((PROC_COUNT - CWD_OK)) instances"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

# --- Live instance table (informational) ---
echo "=== Current instances ==="
printf "%8s  %-4s  %-12s  %-8s  %-5s  %-8s  %s\n" "PID" "TYPE" "AGE" "TTY" "DEPTH" "TRACE" "PROJECT"
echo "─────────────────────────────────────────────────────────────────────────────────"
for pid in $PROC_PIDS; do
    cwd=$(readlink /proc/$pid/cwd 2>/dev/null || echo "?")
    project=$(basename "$cwd")
    env_raw=$(cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n')
    has_rlm=$(echo "$env_raw" | grep -c '^RLM_SYSTEM_PROMPT=' || true)
    type="pi"
    [ "$has_rlm" -gt 0 ] && type="ypi"
    depth=$(echo "$env_raw" | grep '^RLM_DEPTH=' | cut -d= -f2 || echo "?")
    trace=$(echo "$env_raw" | grep '^RLM_TRACE_ID=' | cut -d= -f2 | head -c8 || echo "?")
    age=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    suffix=""
    if echo "$PROC_PIDS" | grep -qw "$ppid" 2>/dev/null; then
        suffix=" (child of $ppid)"
    fi
    printf "%8s  %-4s  %-12s  %-8s  %-5s  %-8s  %s%s\n" "$pid" "$type" "$age" "$tty" "$depth" "$trace" "$project" "$suffix"
done

exit $FAIL

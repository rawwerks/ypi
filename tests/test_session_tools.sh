#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ypi_session_tools.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
chmod 700 "$SCRATCH"
SESSION_DIR="$SCRATCH/sessions"
mkdir -m 700 "$SESSION_DIR"

pass=0
fail=0

record() {
    local ok="$1"
    local label="$2"
    local detail="${3:-}"
    if [ "$ok" = 1 ]; then
        pass=$((pass + 1))
        printf '  PASS %s\n' "$label"
    else
        fail=$((fail + 1))
        printf '  FAIL %s%s\n' "$label" "${detail:+: $detail}" >&2
    fi
}

session_content='{"type":"session","timestamp":"2026-07-28T00:00:00Z","cwd":"/test"}
{"type":"message","message":{"role":"user","content":"needle text"}}'
printf '%s\n' "$session_content" > "$SESSION_DIR/trace_d1_c1.jsonl"
chmod 600 "$SESSION_DIR/trace_d1_c1.jsonl"

printf '\n=== rlm_sessions safety harness ===\n'
output="$(
    RLM_SESSION_DIR="$SESSION_DIR" RLM_TRACE_ID=trace \
        "$ROOT/rlm_sessions" list
)"
if [[ "$output" == *"trace_d1_c1.jsonl"* ]]; then
    record 1 "list renders a direct-child regular session"
else
    record 0 "list renders a direct-child regular session" "$output"
fi

output="$(
    RLM_SESSION_DIR="$SESSION_DIR" RLM_TRACE_ID=trace \
        "$ROOT/rlm_sessions" read trace_d1_c1.jsonl
)"
if [[ "$output" == *"user: needle text"* ]]; then
    record 1 "read renders a direct-child session"
else
    record 0 "read renders a direct-child session" "$output"
fi

output="$(
    RLM_SESSION_DIR="$SESSION_DIR" RLM_TRACE_ID=trace \
        "$ROOT/rlm_sessions" grep needle
)"
if [[ "$output" == *"user: needle text"* ]]; then
    record 1 "grep searches message text"
else
    record 0 "grep searches message text" "$output"
fi

hostile_trace_name="trace___escape_d1_c2.jsonl"
printf '%s\n' "$session_content" > "$SESSION_DIR/$hostile_trace_name"
chmod 600 "$SESSION_DIR/$hostile_trace_name"
output="$(
    RLM_SESSION_DIR="$SESSION_DIR" RLM_TRACE_ID='trace///escape' \
        "$ROOT/rlm_sessions" --trace
)"
if [[ "$output" == *"$hostile_trace_name"* ]]; then
    record 1 "trace filtering uses the canonical sanitized trace id"
else
    record 0 "trace filtering uses the canonical sanitized trace id" "$output"
fi

quote_name="quote'file.jsonl"
printf '%s\n' "$session_content" > "$SESSION_DIR/$quote_name"
chmod 600 "$SESSION_DIR/$quote_name"
output="$(
    RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read "$quote_name"
)"
if [[ "$output" == *"user: needle text"* ]]; then
    record 1 "quote-containing filenames remain argv data"
else
    record 0 "quote-containing filenames remain argv data" "$output"
fi

newline_name=$'line\nbreak.jsonl'
printf '%s\n' "$session_content" > "$SESSION_DIR/$newline_name"
chmod 600 "$SESSION_DIR/$newline_name"
output="$(
    RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read "$newline_name"
)"
if [[ "$output" == *"user: needle text"* ]]; then
    record 1 "newline-containing filenames remain argv data"
else
    record 0 "newline-containing filenames remain argv data" "$output"
fi

set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" \
    grep "' + __import__('sys').exit(73) + r'" > "$SCRATCH/regex.out" 2>&1
regex_status=$?
set -e
if [ "$regex_status" -eq 0 ]; then
    record 1 "regex source text cannot become Python source"
else
    record 0 "regex source text cannot become Python source" \
        "$(cat "$SCRATCH/regex.out")"
fi

outside="$SCRATCH/outside.jsonl"
printf '%s\n' "$session_content" > "$outside"
chmod 600 "$outside"
set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read "$outside" \
    > "$SCRATCH/outside.out" 2>&1
outside_status=$?
set -e
if [ "$outside_status" -ne 0 ] \
    && grep -q "direct-child" "$SCRATCH/outside.out"; then
    record 1 "absolute outside-session reads are rejected"
else
    record 0 "absolute outside-session reads are rejected" \
        "$(cat "$SCRATCH/outside.out")"
fi

ln -s "$outside" "$SESSION_DIR/inside-link.jsonl"
set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read inside-link.jsonl \
    > "$SCRATCH/symlink.out" 2>&1
symlink_status=$?
set -e
if [ "$symlink_status" -ne 0 ]; then
    record 1 "inside symlinks are never followed"
else
    record 0 "inside symlinks are never followed" \
        "$(cat "$SCRATCH/symlink.out")"
fi

public_name="public.jsonl"
printf '%s\n' "$session_content" > "$SESSION_DIR/$public_name"
chmod 644 "$SESSION_DIR/$public_name"
set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read "$public_name" \
    > "$SCRATCH/public.out" 2>&1
public_status=$?
set -e
if [ "$public_status" -ne 0 ] \
    && grep -q "private" "$SCRATCH/public.out"; then
    record 1 "public session files are rejected"
else
    record 0 "public session files are rejected" \
        "$(cat "$SCRATCH/public.out")"
fi
rm -f "$SESSION_DIR/$public_name"

hardlink_name="hardlink.jsonl"
ln "$outside" "$SESSION_DIR/$hardlink_name"
set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" read "$hardlink_name" \
    > "$SCRATCH/hardlink.out" 2>&1
hardlink_status=$?
set -e
if [ "$hardlink_status" -ne 0 ] \
    && grep -q "singly-linked" "$SCRATCH/hardlink.out"; then
    record 1 "hardlinked session files are rejected"
else
    record 0 "hardlinked session files are rejected" \
        "$(cat "$SCRATCH/hardlink.out")"
fi
rm -f "$SESSION_DIR/$hardlink_name"

session_alias="$SCRATCH/sessions-alias"
ln -s "$SESSION_DIR" "$session_alias"
set +e
RLM_SESSION_DIR="$session_alias" "$ROOT/rlm_sessions" list \
    > "$SCRATCH/directory-link.out" 2>&1
directory_status=$?
set -e
if [ "$directory_status" -ne 0 ] \
    && grep -q "non-symlink" "$SCRATCH/directory-link.out"; then
    record 1 "a symlinked session directory is rejected"
else
    record 0 "a symlinked session directory is rejected" \
        "$(cat "$SCRATCH/directory-link.out")"
fi

chmod 755 "$SESSION_DIR"
set +e
RLM_SESSION_DIR="$SESSION_DIR" "$ROOT/rlm_sessions" list \
    > "$SCRATCH/directory-mode.out" 2>&1
directory_mode_status=$?
set -e
if [ "$directory_mode_status" -ne 0 ] \
    && grep -q "mode 0700" "$SCRATCH/directory-mode.out"; then
    record 1 "public session directories are rejected"
else
    record 0 "public session directories are rejected" \
        "$(cat "$SCRATCH/directory-mode.out")"
fi

printf '\nResults: %d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then
    exit 1
fi

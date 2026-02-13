#!/usr/bin/env bash
# rlm_sessions — List and read Pi session logs for the current recursive tree.
#
# Sub-agents can use this to see what other agents have done — shared memory
# through session transcripts.
#
# Environment:
#   RLM_SESSION_DIR    — path to Pi session directory (set by ypi/rlm_query)
#   RLM_TRACE_ID       — current trace ID (filters to this recursive tree)
#   RLM_SHARED_SESSIONS — set to "0" to disable (exit silently). Default: 1.
#
# Usage:
#   rlm_sessions                     # List all sessions for this project
#   rlm_sessions --trace             # List only sessions from current trace
#   rlm_sessions read <file>         # Read a session as clean transcript
#   rlm_sessions read --last         # Read the most recent session
#   rlm_sessions grep <pattern>      # Search across all sessions
#   rlm_sessions grep -t <pattern>   # Search only current trace's sessions

set -euo pipefail

# Gate: disabled when RLM_SHARED_SESSIONS=0
if [ "${RLM_SHARED_SESSIONS:-1}" = "0" ]; then
    echo "Session sharing disabled (RLM_SHARED_SESSIONS=0)." >&2
    exit 0
fi

SESSION_DIR="${RLM_SESSION_DIR:-}"
TRACE_ID="${RLM_TRACE_ID:-}"

if [ -z "$SESSION_DIR" ] || [ ! -d "$SESSION_DIR" ]; then
    echo "No session directory found." >&2
    echo "  RLM_SESSION_DIR=${SESSION_DIR:-<not set>}" >&2
    exit 1
fi

# ─── Helper: render a session JSONL to readable transcript ────────────────

render_session() {
    local file="$1"
    python3 -c "
import json, sys

with open('$file') as f:
    for line in f:
        r = json.loads(line)

        # Session metadata
        if r.get('type') == 'session':
            ts = r.get('timestamp', '?')
            cwd = r.get('cwd', '?')
            print(f'=== Session: {ts} ===')
            print(f'    cwd: {cwd}')
            print()
            continue

        if r.get('type') != 'message':
            continue

        msg = r['message']
        role = msg.get('role', '?')
        content = msg.get('content', '')

        if role == 'toolResult':
            tool = msg.get('toolName', '?')
            if isinstance(content, list):
                text = ''.join(p.get('text', '') for p in content if isinstance(p, dict))
            else:
                text = str(content)
            # Truncate long tool results
            if len(text) > 500:
                text = text[:500] + '... [truncated]'
            print(f'[{tool} result]: {text}')
            print()
            continue

        if isinstance(content, str):
            print(f'{role}: {content}')
            print()
            continue

        # content is a list of parts
        for part in content:
            if not isinstance(part, dict):
                continue
            ptype = part.get('type', '')
            if ptype == 'text':
                text = part.get('text', '')
                if len(text) > 1000:
                    text = text[:1000] + '... [truncated]'
                print(f'{role}: {text}')
                print()
            elif ptype == 'toolCall':
                name = part.get('name', '?')
                args = part.get('arguments', {})
                if name == 'bash':
                    cmd = args.get('command', '')
                    if len(cmd) > 200:
                        cmd = cmd[:200] + '...'
                    print(f'{role}: [bash] {cmd}')
                else:
                    argstr = json.dumps(args)
                    if len(argstr) > 200:
                        argstr = argstr[:200] + '...'
                    print(f'{role}: [{name}] {argstr}')
                print()
            elif ptype == 'thinking':
                # Skip thinking blocks — they're internal
                pass
" 2>/dev/null
}

# ─── Commands ─────────────────────────────────────────────────────────────

case "${1:-list}" in
    list|--trace)
        FILTER=""
        if [ "${1:-}" = "--trace" ] && [ -n "$TRACE_ID" ]; then
            FILTER="$TRACE_ID"
            echo "Sessions for trace $TRACE_ID:"
        else
            echo "All sessions in $SESSION_DIR:"
        fi
        echo ""

        for f in "$SESSION_DIR"/*.jsonl; do
            [ -f "$f" ] || continue
            base=$(basename "$f")

            # Filter by trace if requested
            if [ -n "$FILTER" ] && [[ "$base" != "${FILTER}"* ]]; then
                continue
            fi

            # Get basic info
            size=$(wc -c < "$f")
            msgs=$(grep -c '"type":"message"' "$f" 2>/dev/null || echo 0)
            ts=$(python3 -c "
import json
with open('$f') as fh:
    r = json.loads(fh.readline())
    print(r.get('timestamp', '?')[:19])
" 2>/dev/null || echo "?")

            printf "  %-50s %6s bytes  %3s msgs  %s\n" "$base" "$size" "$msgs" "$ts"
        done
        ;;

    read)
        shift
        if [ "${1:-}" = "--last" ]; then
            FILE=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
            if [ -z "$FILE" ]; then
                echo "No sessions found." >&2
                exit 1
            fi
        else
            FILE="${1:?Usage: rlm_sessions read <file|--last>}"
            # Allow bare filename (without path)
            if [ ! -f "$FILE" ] && [ -f "$SESSION_DIR/$FILE" ]; then
                FILE="$SESSION_DIR/$FILE"
            fi
        fi
        render_session "$FILE"
        ;;

    grep)
        shift
        TRACE_ONLY=false
        if [ "${1:-}" = "-t" ]; then
            TRACE_ONLY=true
            shift
        fi
        PATTERN="${1:?Usage: rlm_sessions grep [-t] <pattern>}"

        for f in "$SESSION_DIR"/*.jsonl; do
            [ -f "$f" ] || continue
            base=$(basename "$f")

            if [ "$TRACE_ONLY" = true ] && [ -n "$TRACE_ID" ]; then
                [[ "$base" == "${TRACE_ID}"* ]] || continue
            fi

            # Search in message text content
            matches=$(python3 -c "
import json, re
pattern = re.compile(r'$PATTERN', re.IGNORECASE)
with open('$f') as fh:
    for line in fh:
        r = json.loads(line)
        if r.get('type') != 'message': continue
        msg = r['message']
        content = msg.get('content', '')
        if isinstance(content, str):
            if pattern.search(content):
                role = msg.get('role', '?')
                match = content[:150]
                print(f'{role}: {match}')
        elif isinstance(content, list):
            for part in content:
                text = part.get('text', '') if isinstance(part, dict) else ''
                if text and pattern.search(text):
                    role = msg.get('role', '?')
                    print(f'{role}: {text[:150]}')
" 2>/dev/null)

            if [ -n "$matches" ]; then
                echo "--- $base ---"
                echo "$matches"
                echo ""
            fi
        done
        ;;

    *)
        echo "Usage: rlm_sessions [list|--trace|read <file>|grep <pattern>]" >&2
        exit 1
        ;;
esac

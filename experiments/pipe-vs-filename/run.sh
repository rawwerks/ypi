#!/usr/bin/env bash
# Experiment: pipe-vs-filename
#
# Hypothesis: Piping source to rlm_query as context produces better edits
#             than telling the child the filename.
#
# Condition A: Pipe rlm_sessions source as stdin context
# Condition B: Tell the child the filename, let it read the file itself
#
# Task: Add a --version flag to rlm_sessions
#
# Usage: bash experiments/pipe-vs-filename/run.sh A
#        bash experiments/pipe-vs-filename/run.sh B

set -euo pipefail

CONDITION="${1:?Usage: $0 <A|B>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results/$CONDITION"
TARGET_FILE="$REPO_DIR/rlm_sessions"

mkdir -p "$RESULTS_DIR"

# Resumability: skip if result already exists
if [ -f "$RESULTS_DIR/output.txt" ]; then
    echo "Condition $CONDITION already completed. Remove $RESULTS_DIR/output.txt to re-run."
    exit 0
fi

cd "$REPO_DIR"

# Save original file for diff comparison
cp "$TARGET_FILE" "$RESULTS_DIR/original.sh"

# Create a working copy so both conditions edit independently
WORK_COPY=$(mktemp /tmp/rlm_sessions_${CONDITION}_XXXXXX.sh)
cp "$TARGET_FILE" "$WORK_COPY"
trap 'rm -f "$WORK_COPY"' EXIT

echo "=== Condition $CONDITION started at $(date -Iseconds) ==="
START_TIME=$(date +%s)

TASK_PROMPT='Add a --version flag to rlm_sessions. When the user runs "rlm_sessions --version", it should print the version string from the repo (read it from the .pi-version file in the same directory as rlm_sessions, or fall back to "unknown"). The flag should be handled early, before any other logic. Write the modified script content to stdout — output ONLY the complete modified script, nothing else.'

case "$CONDITION" in
    A)
        echo "Strategy: Pipe source as context"
        # Pipe the file content as context
        OUTPUT=$(cat "$WORK_COPY" | rlm_query "Here is the source code of rlm_sessions (a bash script). $TASK_PROMPT" 2>"$RESULTS_DIR/stderr.log")
        ;;
    B)
        echo "Strategy: Tell child the filename"
        # Tell the child where the file is, let it read it
        OUTPUT=$(rlm_query "The file $WORK_COPY contains the source of rlm_sessions (a bash script). Read it first, then: $TASK_PROMPT" 2>"$RESULTS_DIR/stderr.log")
        ;;
    *)
        echo "Unknown condition: $CONDITION. Use A or B." >&2
        exit 1
        ;;
esac

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# Save output
echo "$OUTPUT" > "$RESULTS_DIR/output.txt"

# Extract just the script from the output (between ```bash and ```, or the whole thing)
python3 -c "
import sys, re
text = open('$RESULTS_DIR/output.txt').read()
# Try to extract code block
m = re.search(r'\`\`\`(?:bash|sh)?\n(.*?)\`\`\`', text, re.DOTALL)
if m:
    print(m.group(1).rstrip())
else:
    # Use the whole output (might already be raw script)
    print(text.rstrip())
" > "$RESULTS_DIR/modified.sh"

chmod +x "$RESULTS_DIR/modified.sh"

# Measure: does the modified script parse?
PARSE_OK="no"
if bash -n "$RESULTS_DIR/modified.sh" 2>/dev/null; then
    PARSE_OK="yes"
fi

# Measure: does it contain a --version handler?
HAS_VERSION="no"
if grep -q "\-\-version" "$RESULTS_DIR/modified.sh"; then
    HAS_VERSION="yes"
fi

# Measure: diff size (how much changed)
DIFF_LINES=$(diff "$RESULTS_DIR/original.sh" "$RESULTS_DIR/modified.sh" | wc -l || echo "0")

# Measure: did it preserve the rest of the script?
ORIGINAL_FUNCTIONS=$(grep -c "^[a-z_]*() {" "$RESULTS_DIR/original.sh" || echo 0)
MODIFIED_FUNCTIONS=$(grep -c "^[a-z_]*() {" "$RESULTS_DIR/modified.sh" || echo 0)
FUNCTIONS_PRESERVED="yes"
if [ "$MODIFIED_FUNCTIONS" -lt "$ORIGINAL_FUNCTIONS" ]; then
    FUNCTIONS_PRESERVED="no"
fi

# Measure: original line count preserved (roughly)
ORIG_LINES=$(wc -l < "$RESULTS_DIR/original.sh")
MOD_LINES=$(wc -l < "$RESULTS_DIR/modified.sh")

# Write metrics
cat > "$RESULTS_DIR/metrics.json" << METRICS
{
    "condition": "$CONDITION",
    "elapsed_seconds": $ELAPSED,
    "parse_ok": "$PARSE_OK",
    "has_version_flag": "$HAS_VERSION",
    "diff_lines": $DIFF_LINES,
    "original_lines": $ORIG_LINES,
    "modified_lines": $MOD_LINES,
    "functions_preserved": "$FUNCTIONS_PRESERVED",
    "original_functions": $ORIGINAL_FUNCTIONS,
    "modified_functions": $MODIFIED_FUNCTIONS
}
METRICS

echo ""
echo "=== Results for Condition $CONDITION ==="
echo "Time: ${ELAPSED}s"
echo "Parse OK: $PARSE_OK"
echo "Has --version: $HAS_VERSION"
echo "Diff lines: $DIFF_LINES"
echo "Original lines: $ORIG_LINES → Modified lines: $MOD_LINES"
echo "Functions preserved: $FUNCTIONS_PRESERVED ($ORIGINAL_FUNCTIONS → $MODIFIED_FUNCTIONS)"
echo ""
cat "$RESULTS_DIR/metrics.json"
echo ""
echo "=== Condition $CONDITION completed at $(date -Iseconds) ==="

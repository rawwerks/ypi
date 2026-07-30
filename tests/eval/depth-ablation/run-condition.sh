#!/usr/bin/env bash
set -uo pipefail

DEPTH="${1:?usage: run-condition.sh DEPTH [OUTPUT_ROOT]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROOT="${2:-${YPI_EVAL_OUTPUT_ROOT:-$REPO/tmp/depth-ablation}}"
OUT="$ROOT/depth-$DEPTH"
rm -rf "$OUT/sessions"
mkdir -p "$OUT/sessions"
rm -f "$OUT"/{counter,cost.jsonl,trace.log,stdout.json,stderr.log,time.txt,meta.json,score.json,prompt.txt}
sed "s|__FIXTURE_DIR__|$SCRIPT_DIR/fixture|g" "$SCRIPT_DIR/prompt.txt" > "$OUT/prompt.txt"
PROMPT="$(cat "$OUT/prompt.txt")"
RLM_QUERY_BIN="${YPI_RLM_QUERY_BIN:-$REPO/rlm_query}"
TIME_PREFIX=()
if /usr/bin/time -v true >/dev/null 2>&1; then
  TIME_PREFIX=(/usr/bin/time -v -o "$OUT/time.txt")
elif command -v gtime >/dev/null 2>&1; then
  TIME_PREFIX=(gtime -v -o "$OUT/time.txt")
fi
START_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
set +e
env -u CONTEXT -u RLM_ROOT_PROMPT_FILE -u RLM_BUDGET -u RLM_CALL_COUNT -u RLM_START_TIME \
  -u RLM_CHILD_MODEL -u RLM_CHILD_PROVIDER -u RLM_CHILD_THINKING_LEVEL \
  -u RLM_CHILD_MODELS -u RLM_CHILD_PROVIDERS -u RLM_CHILD_THINKING_LEVELS \
  -u RLM_CHILD_EXTENSIONS -u RLM_EXTENSIONS -u RLM_AMBIENT_EXTENSIONS -u RLM_STDIN \
  -u YPI_SHELL_HELPER -u YPI_EXTENSION_PROMPT_MODE \
  -u YPI_CLI_ROOT_OVERRIDE -u YPI_CLI_EXTENSION_OVERRIDE \
  YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
  RLM_PROVIDER="${PI_E2E_PROVIDER:-openai-codex}" RLM_MODEL="${PI_E2E_MODEL:-gpt-5.6-sol}" \
  RLM_THINKING_LEVEL="${PI_E2E_THINKING:-max}" \
  RLM_DEPTH=0 RLM_MAX_DEPTH="$DEPTH" RLM_MAX_CALLS="${RLM_EVAL_MAX_CALLS:-16}" \
  RLM_TIMEOUT="${RLM_EVAL_TIMEOUT:-900}" RLM_JSON=1 \
  RLM_SHARED_SESSIONS=1 RLM_SESSION_DIR="$OUT/sessions" RLM_CHILD_DISCOVERY=0 \
  RLM_TRACE_ID="depth-ablation-$DEPTH" RLM_CALL_COUNTER_FILE="$OUT/counter" \
  RLM_COST_FILE="$OUT/cost.jsonl" PI_TRACE_FILE="$OUT/trace.log" \
  "${TIME_PREFIX[@]}" "$RLM_QUERY_BIN" "$PROMPT" \
  >"$OUT/stdout.json" 2>"$OUT/stderr.log"
RC=$?
set -e
END_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
set +e
python3 "$SCRIPT_DIR/score.py" "$OUT/stdout.json" --output "$OUT/score.json" >/dev/null 2>&1
SCORE_RC=$?
set -e
python3 - "$OUT" "$DEPTH" "$RC" "$START_NS" "$END_NS" <<'PY'
import json, pathlib, re, sys
out=pathlib.Path(sys.argv[1]); depth=int(sys.argv[2]); rc=int(sys.argv[3]); elapsed=(int(sys.argv[5])-int(sys.argv[4]))/1e9
try: calls=int((out/'counter').read_text().strip())
except Exception: calls=0
cost=tokens=0; cost_incomplete=False
if (out/'cost.jsonl').exists():
  for line in (out/'cost.jsonl').read_text().splitlines():
    try:
      row=json.loads(line); cost+=float(row.get('cost',0)); tokens+=int(row.get('tokens',0)); cost_incomplete |= row.get('incomplete') is True
    except Exception: pass
trace=(out/'trace.log').read_text(errors='replace') if (out/'trace.log').exists() else ''
spawned_transitions=len(re.findall(r'depth=\d+→\d+',trace))
max_observed=0
for p in (out/'sessions').glob('*.jsonl'):
  m=re.search(r'_d(\d+)_c',p.name)
  if m: max_observed=max(max_observed,int(m.group(1)))
rss=None
if (out/'time.txt').exists():
  m=re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',(out/'time.txt').read_text())
  if m: rss=int(m.group(1))
score={}
try: score=json.loads((out/'score.json').read_text())
except Exception: pass
meta={'condition_depth':depth,'exit_code':rc,'elapsed_seconds':round(elapsed,3),'allocated_call_attempts':calls,'spawned_trace_transitions':spawned_transitions,'max_observed_child_depth':max_observed,'complete_ledger_cost':round(cost,6),'complete_ledger_tokens':tokens,'cost_ledger_incomplete':cost_incomplete,'max_rss_kib':rss,'score':score}
(out/'meta.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
PY
if [ "$RC" -eq 0 ] && { [ "$SCORE_RC" -ne 0 ] || python3 -c 'import json,sys; raise SystemExit(0 if json.load(open(sys.argv[1]))["cost_ledger_incomplete"] else 1)' "$OUT/meta.json"; }; then
  echo "depth condition returned invalid score or incomplete cost evidence: $OUT" >&2
  exit 1
fi
exit "$RC"

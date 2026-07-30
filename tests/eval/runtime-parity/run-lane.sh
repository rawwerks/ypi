#!/usr/bin/env bash
set -uo pipefail

LANE="${1:?usage: run-lane.sh canonical-cli|canonical-native [OUTPUT_ROOT]}"
case "$LANE" in canonical-cli|canonical-native) ;; *) echo "invalid lane: $LANE" >&2; exit 2;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ROOT="${2:-${YPI_EVAL_OUTPUT_ROOT:-$REPO/tmp/runtime-parity}}"
OUT="$ROOT/$LANE"
mkdir -p "$OUT"
rm -f "$OUT"/{context.txt,counter,cost.jsonl,trace.log,output.txt,stderr.txt,time.txt,exit,meta.json}
RLM_QUERY_BIN="${YPI_RLM_QUERY_BIN:-$REPO/rlm_query}"
MAKE_BIN="${YPI_MAKE_BIN:-make}"
# Preserve provider credentials and normal host configuration while removing
# every ambient recursive/ypi namespace. Explicit lane values below are the
# only recursive state admitted into the child, avoiding parent-tree counter,
# route, session, and extension contamination without hand-maintaining a second
# provider credential allowlist.
CLEAN_ENV=(env -u CONTEXT -u PI_TRACE_FILE)
while IFS='=' read -r key _; do
  case "$key" in
    RLM_*|YPI_*) CLEAN_ENV+=(-u "$key") ;;
  esac
done < <(env)

TIME_PREFIX=()
if /usr/bin/time -v true >/dev/null 2>&1; then
  TIME_PREFIX=(/usr/bin/time -v -o "$OUT/time.txt")
elif command -v gtime >/dev/null 2>&1; then
  TIME_PREFIX=(gtime -v -o "$OUT/time.txt")
fi
python3 - "$OUT/context.txt" <<'PY'
import sys
p=sys.argv[1]
keys={333:'KEY_ALPHA=173',1777:'KEY_BETA=229',2888:'KEY_GAMMA=401'}
with open(p,'w') as f:
  for i in range(1,3001):
    value=keys.get(i,f'noise={i*7919}')
    f.write(f'record={i:04d} {value}\n')
PY
START_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
set +e
if [[ "$LANE" == *-cli ]]; then
	  PROMPT="$(cat "$SCRIPT_DIR/prompt.txt")"
	  "${CLEAN_ENV[@]}" \
	    YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
	    CONTEXT="$OUT/context.txt" RLM_PROVIDER="${PI_E2E_PROVIDER:-openai-codex}" \
	    RLM_MODEL="${PI_E2E_MODEL:-gpt-5.6-sol}" RLM_THINKING_LEVEL="${PI_E2E_THINKING:-max}" \
	    RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_MAX_CALLS=2 RLM_JSON=1 RLM_SHARED_SESSIONS=0 \
    RLM_CHILD_DISCOVERY=0 RLM_TRACE_ID="parity-$LANE" RLM_CALL_COUNTER_FILE="$OUT/counter" \
    RLM_COST_FILE="$OUT/cost.jsonl" PI_TRACE_FILE="$OUT/trace.log" \
    "${TIME_PREFIX[@]}" "$RLM_QUERY_BIN" "$PROMPT" \
    >"$OUT/output.txt" 2>"$OUT/stderr.txt"
  RC=$?
	else
	  "${CLEAN_ENV[@]}" \
	    YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
	    RLM_PROVIDER="${PI_E2E_PROVIDER:-openai-codex}" RLM_MODEL="${PI_E2E_MODEL:-gpt-5.6-sol}" \
	    RLM_THINKING_LEVEL="${PI_E2E_THINKING:-max}" RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_MAX_CALLS=4 \
	    RLM_JSON=1 RLM_SHARED_SESSIONS=0 \
    RLM_CHILD_DISCOVERY=0 RLM_TRACE_ID="parity-$LANE" RLM_CALL_COUNTER_FILE="$OUT/counter" \
    "${TIME_PREFIX[@]}" "$MAKE_BIN" -C "$REPO" test-recursion-e2e \
    >"$OUT/output.txt" 2>"$OUT/stderr.txt"
  RC=$?
fi
set -e
END_NS="$(python3 -c 'import time; print(time.monotonic_ns())')"
printf '%s\n' "$RC" > "$OUT/exit"
python3 - "$OUT" "$LANE" "$RC" "$START_NS" "$END_NS" <<'PY'
import json,pathlib,re,sys
out=pathlib.Path(sys.argv[1]); lane=sys.argv[2]; rc=int(sys.argv[3]); elapsed=(int(sys.argv[5])-int(sys.argv[4]))/1e9
try: calls=int((out/'counter').read_text().strip())
except Exception: calls=0
cost=tokens=0
if (out/'cost.jsonl').exists():
  for line in (out/'cost.jsonl').read_text().splitlines():
    try:
      row=json.loads(line); cost+=float(row.get('cost',0)); tokens+=int(row.get('tokens',0))
    except Exception: pass
rss=None
if (out/'time.txt').exists():
  m=re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',(out/'time.txt').read_text())
  if m: rss=int(m.group(1))
text=(out/'output.txt').read_text(errors='replace') if (out/'output.txt').exists() else ''
trace=(out/'trace.log').read_text(errors='replace') if (out/'trace.log').exists() else ''
spawned_transitions=len(re.findall(r'depth=\d+→\d+',trace))
expected='RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA' if lane.endswith('-cli') else 'E9: full ypi recursive child call'
expected_present=expected in text
recursive_transition_present=(
  ('depth=0→1' in text and 'caller=tool' in text)
  if lane.endswith('-native')
  else ('depth=0→1' in trace and re.search(r'depth=1→2.*caller=tool',trace) is not None and spawned_transitions >= 2)
)
call_count_contract_pass=lane.endswith('-native') or calls == 2
contract_pass=rc == 0 and expected_present and recursive_transition_present and call_count_contract_pass
meta={'lane':lane,'exit_code':rc,'expected_output_present':expected_present,'recursive_transition_present':recursive_transition_present,'call_count_contract_pass':call_count_contract_pass,'contract_pass':contract_pass,'elapsed_seconds':round(elapsed,3),'allocated_call_attempts':calls,'spawned_trace_transitions':spawned_transitions,'cost':round(cost,6),'tokens':tokens,'max_rss_kib':rss}
(out/'meta.json').write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
PY
if [ "$RC" -eq 0 ] && ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["contract_pass"] else 1)' "$OUT/meta.json"; then
  echo "lane contract failed: $OUT/meta.json" >&2
  exit 1
fi
exit "$RC"

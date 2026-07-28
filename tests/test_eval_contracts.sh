#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/ypi_eval_contract.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

cat > "$TEST_TMP/fake-rlm" <<'MOCK'
#!/usr/bin/env bash
{
  printf 'RLM_CHILD_MODEL=%s\n' "${RLM_CHILD_MODEL-unset}"
  printf 'RLM_STDIN=%s\n' "${RLM_STDIN-unset}"
  printf 'YPI_SHELL_HELPER=%s\n' "${YPI_SHELL_HELPER-unset}"
  printf 'YPI_EXTENSION_PROMPT_MODE=%s\n' "${YPI_EXTENSION_PROMPT_MODE-unset}"
  printf 'YPI_CLI_ROOT_OVERRIDE=%s\n' "${YPI_CLI_ROOT_OVERRIDE-unset}"
  printf 'YPI_CLI_EXTENSION_OVERRIDE=%s\n' "${YPI_CLI_EXTENSION_OVERRIDE-unset}"
} > "$YPI_EVAL_PROBE"
printf '[]\n'
MOCK
chmod +x "$TEST_TMP/fake-rlm"
DEPTH_ROOT="$TEST_TMP/depth"
mkdir -p "$DEPTH_ROOT/depth-3/sessions"
printf '{}\n' > "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl"
set +e
RLM_CHILD_MODEL=ambient-model RLM_STDIN=1 YPI_SHELL_HELPER=1 YPI_EXTENSION_PROMPT_MODE=replace \
YPI_CLI_ROOT_OVERRIDE=/stale/root YPI_CLI_EXTENSION_OVERRIDE=/stale/extension \
YPI_EVAL_PROBE="$TEST_TMP/depth-env.txt" YPI_RLM_QUERY_BIN="$TEST_TMP/fake-rlm" YPI_EVAL_OUTPUT_ROOT="$DEPTH_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/depth-ablation/run-condition.sh" 3 >"$TEST_TMP/depth.out" 2>"$TEST_TMP/depth.err"
DEPTH_RC=$?
set -e
if [ "$DEPTH_RC" -ne 0 ]; then pass "depth eval rejects a successful but incorrectly scored answer"; else fail "depth eval rejects a successful but incorrectly scored answer" "rc=0"; fi
if [ ! -e "$DEPTH_ROOT/depth-3/sessions/stale_d9_c1.jsonl" ]; then pass "depth eval clears stale session evidence"; else fail "depth eval clears stale session evidence" "stale session survived"; fi
if ! grep -v '=unset$' "$TEST_TMP/depth-env.txt" | grep -q .; then pass "depth eval clears ambient routing and launcher overrides"; else fail "depth eval clears ambient routing and launcher overrides" "$(cat "$TEST_TMP/depth-env.txt")"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["true_positives"] == 0 and len(d["missing"]) == 12' "$DEPTH_ROOT/depth-3/score.json"; then pass "depth eval emits deterministic score evidence"; else fail "depth eval emits deterministic score evidence" "bad score"; fi

cat > "$TEST_TMP/fake-incomplete-rlm" <<'MOCK'
#!/usr/bin/env bash
python3 - "$YPI_EVAL_GT" <<'PY'
import json,sys
g=json.load(open(sys.argv[1]))
print(json.dumps([{"path":row["path"],"line":row["line"],"contract":row["needle"],"defect":"fixture","impact":"fixture"} for row in g]))
PY
printf '%s\n' '{"cost":1.25,"tokens":125}' '{"incomplete":true,"reason":"timeout"}' > "$RLM_COST_FILE"
printf '1\n' > "$RLM_CALL_COUNTER_FILE"
MOCK
chmod +x "$TEST_TMP/fake-incomplete-rlm"
set +e
YPI_EVAL_GT="$PROJECT_DIR/tests/eval/depth-ablation/ground-truth.json" \
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-incomplete-rlm" YPI_EVAL_OUTPUT_ROOT="$DEPTH_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/depth-ablation/run-condition.sh" 3 >"$TEST_TMP/incomplete.out" 2>"$TEST_TMP/incomplete.err"
INCOMPLETE_RC=$?
set -e
if [ "$INCOMPLETE_RC" -ne 0 ]; then pass "depth eval rejects incomplete cost evidence"; else fail "depth eval rejects incomplete cost evidence" "rc=0"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["cost_ledger_incomplete"] and d["complete_ledger_cost"] == 1.25 and d["allocated_call_attempts"] == 1' "$DEPTH_ROOT/depth-3/meta.json"; then pass "depth eval labels lower-bound cost and call attempts"; else fail "depth eval labels lower-bound cost and call attempts" "bad metadata"; fi

cat > "$TEST_TMP/fake-make" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' 'E9: full ypi recursive child call'
MOCK
chmod +x "$TEST_TMP/fake-make"
PARITY_ROOT="$TEST_TMP/parity"
set +e
YPI_MAKE_BIN="$TEST_TMP/fake-make" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-native >"$TEST_TMP/native.out" 2>"$TEST_TMP/native.err"
NATIVE_RC=$?
set -e
if [ "$NATIVE_RC" -ne 0 ]; then pass "native parity lane requires a real recursive transition"; else fail "native parity lane requires a real recursive transition" "label-only fake passed"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["expected_output_present"] and not d["recursive_transition_present"] and not d["contract_pass"]' "$PARITY_ROOT/canonical-native/meta.json"; then pass "native parity metadata separates label from recursion proof"; else fail "native parity metadata separates label from recursion proof" "bad metadata"; fi

cat > "$TEST_TMP/fake-cli" <<'MOCK'
#!/usr/bin/env bash
printf '2\n' > "$RLM_CALL_COUNTER_FILE"
printf '%s' 'RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA'
MOCK
chmod +x "$TEST_TMP/fake-cli"
set +e
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-cli" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-cli >"$TEST_TMP/cli.out" 2>"$TEST_TMP/cli.err"
CLI_RC=$?
set -e
if [ "$CLI_RC" -ne 0 ]; then pass "CLI parity lane requires two recursive calls, not answer text alone"; else fail "CLI parity lane requires two recursive calls, not answer text alone" "answer-only fake passed"; fi

cat > "$TEST_TMP/fake-flat-trace-cli" <<'MOCK'
#!/usr/bin/env bash
printf '2\n' > "$RLM_CALL_COUNTER_FILE"
printf '%s\n' \
  '[00:00:00.000] depth=0→1 PID=1 call=1 trace=test caller=cli prompt: first' \
  '[00:00:00.001] depth=0→1 PID=2 call=2 trace=test caller=tool prompt: second' > "$PI_TRACE_FILE"
printf '%s' 'RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA'
MOCK
chmod +x "$TEST_TMP/fake-flat-trace-cli"
set +e
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-flat-trace-cli" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-cli >"$TEST_TMP/flat-cli.out" 2>"$TEST_TMP/flat-cli.err"
FLAT_CLI_RC=$?
set -e
if [ "$FLAT_CLI_RC" -ne 0 ]; then pass "CLI parity requires a child-to-grandchild native transition"; else fail "CLI parity requires a child-to-grandchild native transition" "two flat calls passed"; fi

cat > "$TEST_TMP/fake-extra-attempt-cli" <<'MOCK'
#!/usr/bin/env bash
printf '3\n' > "$RLM_CALL_COUNTER_FILE"
printf '%s\n' \
  '[00:00:00.000] depth=0→1 PID=1 call=1 trace=test caller=cli prompt: root' \
  '[00:00:00.001] depth=1→2 PID=2 call=2 trace=test caller=tool prompt: child' > "$PI_TRACE_FILE"
printf '%s' 'RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA'
MOCK
chmod +x "$TEST_TMP/fake-extra-attempt-cli"
set +e
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-extra-attempt-cli" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-cli >"$TEST_TMP/extra-cli.out" 2>"$TEST_TMP/extra-cli.err"
EXTRA_CLI_RC=$?
set -e
if [ "$EXTRA_CLI_RC" -ne 0 ]; then pass "CLI parity rejects an extra blocked call attempt"; else fail "CLI parity rejects an extra blocked call attempt" "three attempts passed"; fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["recursive_transition_present"] and not d["call_count_contract_pass"] and not d["contract_pass"]' "$PARITY_ROOT/canonical-cli/meta.json"; then pass "CLI parity separates transition proof from exact call count"; else fail "CLI parity separates transition proof from exact call count" "bad metadata"; fi

cat > "$TEST_TMP/fake-clean-env-cli" <<'MOCK'
#!/usr/bin/env bash
env | sort > "$PARITY_ENV_PROBE"
printf '2\n' > "$RLM_CALL_COUNTER_FILE"
printf '%s\n' \
  '[00:00:00.000] depth=0→1 PID=1 call=1 trace=test caller=cli prompt: root' \
  '[00:00:00.001] depth=1→2 PID=2 call=2 trace=test caller=tool prompt: child' > "$PI_TRACE_FILE"
printf '%s' 'RESULT=803 EVIDENCE=KEY_ALPHA,KEY_BETA,KEY_GAMMA'
MOCK
chmod +x "$TEST_TMP/fake-clean-env-cli"
set +e
RLM_CHILD_MODEL=ambient-model RLM_CHILD_PROVIDER=ambient-provider RLM_SESSION_DIR=/poison/session \
RLM_AMBIENT_EXTENSIONS=1 RLM_CALL_COUNT=99 RLM_CALL_COUNTER_FILE=/poison/counter \
RLM_COST_FILE=/poison/cost RLM_TRACE_ID=poison RLM_ROOT_PROMPT_FILE=/poison/root \
YPI_EXTENSION_ROOT=/poison/root YPI_CLI_ROOT_OVERRIDE=/poison/cli YPI_EXTENSION_PROMPT_MODE=replace \
CONTEXT=/poison/context PI_TRACE_FILE=/poison/trace PARITY_ENV_PROBE="$TEST_TMP/parity-env.txt" \
YPI_RLM_QUERY_BIN="$TEST_TMP/fake-clean-env-cli" YPI_EVAL_OUTPUT_ROOT="$PARITY_ROOT" \
YPI_PI_BIN="${YPI_PI_BIN:-$(command -v pi)}" \
"$PROJECT_DIR/tests/eval/runtime-parity/run-lane.sh" canonical-cli >"$TEST_TMP/clean-cli.out" 2>"$TEST_TMP/clean-cli.err"
CLEAN_CLI_RC=$?
set -e
if [ "$CLEAN_CLI_RC" -eq 0 ]; then pass "CLI parity runs through sanitized recursive environment"; else fail "CLI parity runs through sanitized recursive environment" "rc=$CLEAN_CLI_RC"; fi
if PARITY_ROOT="$PARITY_ROOT" python3 - "$TEST_TMP/parity-env.txt" <<'PY'
import os, sys
values = {}
for line in open(sys.argv[1]):
    key, _, value = line.rstrip("\n").partition("=")
    values[key] = value
for key in ("RLM_CHILD_MODEL", "RLM_CHILD_PROVIDER", "RLM_SESSION_DIR", "RLM_AMBIENT_EXTENSIONS", "RLM_ROOT_PROMPT_FILE", "YPI_EXTENSION_ROOT", "YPI_CLI_ROOT_OVERRIDE", "YPI_EXTENSION_PROMPT_MODE"):
    assert key not in values, (key, values.get(key))
out = os.path.join(os.environ["PARITY_ROOT"], "canonical-cli")
assert values["CONTEXT"] == os.path.join(out, "context.txt")
assert values["PI_TRACE_FILE"] == os.path.join(out, "trace.log")
assert values["RLM_CALL_COUNTER_FILE"] == os.path.join(out, "counter")
assert values["RLM_COST_FILE"] == os.path.join(out, "cost.jsonl")
assert values["RLM_TRACE_ID"] == "parity-canonical-cli"
PY
then pass "CLI parity replaces poisoned parent namespace with private lane state"; else fail "CLI parity replaces poisoned parent namespace with private lane state" "$(cat "$TEST_TMP/parity-env.txt")"; fi

RUNBOOK_TMP="$TEST_TMP/runbook"
CLEAN_GIT_ENV=(env)
while IFS='=' read -r key _; do
  case "$key" in GIT_*) CLEAN_GIT_ENV+=(-u "$key") ;; esac
done < <(env)
mkdir -p "$RUNBOOK_TMP/repo"
python3 - "$PROJECT_DIR/docs/bounded-recursive-development.md" "$RUNBOOK_TMP/init.sh" "$RUNBOOK_TMP/resume.sh" <<'PY'
import re, sys
blocks = re.findall(r"```bash\n(.*?)```", open(sys.argv[1]).read(), re.S)
assert len(blocks) >= 2
open(sys.argv[2], "w").write(blocks[0])
open(sys.argv[3], "w").write(blocks[1])
PY
(
  cd "$RUNBOOK_TMP/repo"
  "${CLEAN_GIT_ENV[@]}" git init -q
  "${CLEAN_GIT_ENV[@]}" git switch -q -c feature/test
  printf 'baseline\n' > baseline.txt
  "${CLEAN_GIT_ENV[@]}" git add baseline.txt
  "${CLEAN_GIT_ENV[@]}" git -c user.name=Test -c user.email=test@example.invalid commit -qm baseline
  "${CLEAN_GIT_ENV[@]}" RLM_BUDGET=0 RLM_TIMEOUT=1 bash "$RUNBOOK_TMP/init.sh"
)
RUNBOOK_ENVELOPE="$(find "$RUNBOOK_TMP/repo/tmp" -name envelope.sh -print)"
RUNBOOK_RUN_DIR="${RUNBOOK_ENVELOPE%/envelope.sh}"
if [ -f "$RUNBOOK_RUN_DIR/envelope.sh" ] && ! grep -Eq 'API_KEY|OAUTH_TOKEN|SECRET_ACCESS|RLM_BUDGET|RLM_TIMEOUT' "$RUNBOOK_RUN_DIR/envelope.sh"; then pass "bounded runbook persists only non-secret, non-terminating envelope controls"; else fail "bounded runbook persists only non-secret, non-terminating envelope controls" "missing or unsafe envelope"; fi
if (
  # shellcheck disable=SC1090
  . "$RUNBOOK_RUN_DIR/envelope.sh"
  [ "$RLM_MAX_DEPTH" = 3 ]
  [ "$RLM_MAX_CALLS" = 65536 ]
  [ "$RLM_MAX_CONCURRENT_CALLS" = 3 ]
  [ "$RLM_REQUIRE_TRANSCRIPTS" = 1 ]
  [ "$RLM_SHARED_SESSIONS" = 1 ]
  [ -d "$RLM_SESSION_DIR" ]
  [ ! -L "$RLM_SESSION_DIR" ]
  [ "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$RLM_SESSION_DIR")" = 700 ]
); then pass "bounded runbook persists depth-three queued audit controls"; else fail "bounded runbook persists depth-three queued audit controls" "incorrect envelope"; fi
if ! grep -Eq '18-call ceiling|at most 12 KiB|up to eight highest-severity' "$PROJECT_DIR/docs/bounded-recursive-development.md"; then pass "bounded runbook has no fixed review-quality allocation"; else fail "bounded runbook has no fixed review-quality allocation" "stale cap text remains"; fi
printf '7\n' > "$RUNBOOK_RUN_DIR/calls"
printf '%s\n' '{"cost":0.5,"tokens":10}' > "$RUNBOOK_RUN_DIR/cost.jsonl"
python3 - "$RUNBOOK_TMP/resume.sh" "$RUNBOOK_RUN_DIR" <<'PY'
import sys
path, run_dir = sys.argv[1:]
text = open(path).read().replace("<exact run directory from the continuation brief>", run_dir)
open(path, "w").write(text + '\nprintf "RESUMED_COUNT=%s\\n" "$RLM_CALL_COUNT"\n')
PY
set +e
bash "$RUNBOOK_TMP/resume.sh" >/dev/null 2>&1
WRONG_REPO_RC=$?
set -e
if [ "$WRONG_REPO_RC" -ne 0 ]; then pass "bounded runbook rejects continuation from another checkout"; else fail "bounded runbook rejects continuation from another checkout" "rc=0"; fi
RUNBOOK_RESUME="$(cd "$RUNBOOK_TMP/repo" && bash "$RUNBOOK_TMP/resume.sh")"
if [ "$RUNBOOK_RESUME" = "RESUMED_COUNT=7" ] && [ "$(cat "$RUNBOOK_RUN_DIR/calls")" = 7 ] && grep -q '"cost":0.5' "$RUNBOOK_RUN_DIR/cost.jsonl"; then pass "bounded runbook continuation preserves bound call and cost ledgers"; else fail "bounded runbook continuation preserves bound call and cost ledgers" "$RUNBOOK_RESUME"; fi
set +e
(
  cd "$RUNBOOK_TMP/repo"
  "${CLEAN_GIT_ENV[@]}" git branch -m master
  "${CLEAN_GIT_ENV[@]}" RLM_BUDGET=0 RLM_TIMEOUT=1 bash "$RUNBOOK_TMP/init.sh"
) >/dev/null 2>&1
RUNBOOK_TRUNK_RC=$?
set -e
if [ "$RUNBOOK_TRUNK_RC" -ne 0 ]; then pass "bounded runbook refuses shared trunk"; else fail "bounded runbook refuses shared trunk" "rc=0"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

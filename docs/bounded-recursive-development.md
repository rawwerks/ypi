# Bounded Recursive Development

Use this runbook for large, proof-bound, or self-hosting ypi changes. It bounds
simultaneous model generations and preserves evidence without treating a
reviewer count or a low total-call allowance as a substitute for completion.

This is an operating contract over existing ypi, repository, test, telemetry,
and eval surfaces. It does not introduce another orchestrator or VCS.

## Scope and non-goals

The root agent owns the goal, decomposition, parent-side adjudication, and final
diff acceptance. Read-only children own reviews and focused probes. After
deterministic discovery makes path scopes explicit and disjoint, the root may
delegate implementation slices in batches of at most three active children.
More slices may run in later batches when evidence requires them. The root
remains the single integration head; descendants cannot request writable
authority. Do not add a second orchestration owner or result validator. This
runbook and its persisted envelope are the proof-bound path.

## Create the envelope once

Initialize the run exactly once. The persisted envelope contains only non-secret
control and telemetry values; never write the full process environment to disk.
Cost is observational telemetry and never an admission or stop condition. Time
checkpoints surface elapsed work but never terminate a child.

```bash
set -euo pipefail
umask 077

# Git hooks export GIT_DIR/GIT_WORK_TREE; inherited values would point the
# repository checks below at the wrong checkout.
for v in $(env | grep -o '^GIT_[A-Z_]*'); do unset "$v"; done

YPI_RUN_STARTED_EPOCH="$(date +%s)"
YPI_RUN_CHECKPOINT_SECONDS=3600
unset RLM_BUDGET RLM_TIMEOUT

YPI_RUN_REPO_ROOT="$(git rev-parse --show-toplevel)"
test "$PWD" = "$YPI_RUN_REPO_ROOT"
BRANCH="$(git branch --show-current)"
test -n "$BRANCH"
case "$BRANCH" in main|master) echo "refusing shared trunk" >&2; exit 1;; esac
YPI_RUN_BRANCH="$BRANCH"
YPI_RUN_BASE_HEAD="$(git rev-parse HEAD)"
YPI_RUN_ORIGIN_PUSH_URL="$(git remote get-url --push origin 2>/dev/null || printf '<none>')"
BRANCH_SLUG="$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9._-' '-')"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_PARENT="$PWD/tmp/$BRANCH_SLUG/recursive"
RUN_DIR="$RUN_PARENT/$RUN_ID"
mkdir -p "$RUN_PARENT"
mkdir -m 700 "$RUN_DIR"

export YPI_RECURSIVE_RUN_DIR="$RUN_DIR"
export RLM_TRACE_ID="$RUN_ID"
export PI_TRACE_FILE="$RUN_DIR/tree.trace"
export RLM_CALL_COUNTER_FILE="$RUN_DIR/calls"
export RLM_CONCURRENCY_DIR="$RUN_DIR/concurrency"
export RLM_COST_FILE="$RUN_DIR/cost.jsonl"
export RLM_SESSION_DIR="$RUN_DIR/sessions"
export RLM_CALL_COUNT=0
export RLM_JSON=1
export RLM_MAX_DEPTH=3
export RLM_MAX_CALLS=65536
export RLM_MAX_CONCURRENT_CALLS=3
export RLM_SHARED_SESSIONS=1
export RLM_REQUIRE_TRANSCRIPTS=1

mkdir -m 700 "$RLM_SESSION_DIR"
printf '0\n' > "$RLM_CALL_COUNTER_FILE"
: > "$RLM_COST_FILE"
: > "$PI_TRACE_FILE"

{
  printf 'export YPI_RECURSIVE_RUN_DIR=%q\n' "$YPI_RECURSIVE_RUN_DIR"
  printf 'export YPI_RUN_REPO_ROOT=%q\n' "$YPI_RUN_REPO_ROOT"
  printf 'export YPI_RUN_BRANCH=%q\n' "$YPI_RUN_BRANCH"
  printf 'export YPI_RUN_BASE_HEAD=%q\n' "$YPI_RUN_BASE_HEAD"
  printf 'export YPI_RUN_ORIGIN_PUSH_URL=%q\n' "$YPI_RUN_ORIGIN_PUSH_URL"
  printf 'export YPI_RUN_STARTED_EPOCH=%q\n' "$YPI_RUN_STARTED_EPOCH"
  printf 'export YPI_RUN_CHECKPOINT_SECONDS=%q\n' "$YPI_RUN_CHECKPOINT_SECONDS"
  printf 'export RLM_TRACE_ID=%q\n' "$RLM_TRACE_ID"
  printf 'export PI_TRACE_FILE=%q\n' "$PI_TRACE_FILE"
  printf 'export RLM_CALL_COUNTER_FILE=%q\n' "$RLM_CALL_COUNTER_FILE"
  printf 'export RLM_CONCURRENCY_DIR=%q\n' "$RLM_CONCURRENCY_DIR"
  printf 'export RLM_COST_FILE=%q\n' "$RLM_COST_FILE"
  printf 'export RLM_SESSION_DIR=%q\n' "$RLM_SESSION_DIR"
  printf 'export RLM_JSON=1\n'
  printf 'export RLM_MAX_DEPTH=3\n'
  printf 'export RLM_MAX_CALLS=65536\n'
  printf 'export RLM_MAX_CONCURRENT_CALLS=3\n'
  printf 'export RLM_SHARED_SESSIONS=1\n'
  printf 'export RLM_REQUIRE_TRANSCRIPTS=1\n'
} > "$RUN_DIR/envelope.sh"
chmod 600 "$RUN_DIR/envelope.sh"
```

At natural checkpoints, report elapsed time when
`now - YPI_RUN_STARTED_EPOCH >= YPI_RUN_CHECKPOINT_SECONDS`; this is advisory
only. The 65,536 total-call value is emergency fault containment, not a work
allocation or quality target. If it is ever reached while the proof contract is
open, stop new child admission, continue directly where possible, preserve the
evidence, and report the unresolved proof state rather than declaring success.
Provider-backed proof runs launch the root with
`--session-dir "$RLM_SESSION_DIR"`; `--no-session` invalidates the run.

## Resume without resetting

A continuation brief must carry the exact `RUN_DIR`, HEAD, elapsed-time
checkpoint, open blockers, and next action. It must not carry credentials. A continuation sources
the existing envelope and requires all ledgers to exist; it never regenerates a
run ID or truncates a file.

```bash
set -euo pipefail
umask 077

# Git hooks export GIT_DIR/GIT_WORK_TREE; inherited values would point the
# repository identity checks below at the wrong checkout.
for v in $(env | grep -o '^GIT_[A-Z_]*'); do unset "$v"; done

RUN_DIR="<exact run directory from the continuation brief>"
test -f "$RUN_DIR/envelope.sh"
# shellcheck disable=SC1090
. "$RUN_DIR/envelope.sh"

test "$YPI_RECURSIVE_RUN_DIR" = "$RUN_DIR"
test "$(git rev-parse --show-toplevel)" = "$YPI_RUN_REPO_ROOT"
test "$(git branch --show-current)" = "$YPI_RUN_BRANCH"
test "$(git remote get-url --push origin 2>/dev/null || printf '<none>')" = "$YPI_RUN_ORIGIN_PUSH_URL"
git merge-base --is-ancestor "$YPI_RUN_BASE_HEAD" HEAD
test -f "$RLM_CALL_COUNTER_FILE"
test -f "$RLM_COST_FILE"
test -f "$PI_TRACE_FILE"
test -d "$RLM_SESSION_DIR"
test ! -L "$RLM_SESSION_DIR"
test "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1], follow_symlinks=False).st_mode & 0o777)[2:])' "$RLM_SESSION_DIR")" = 700

export RLM_CALL_COUNT="$(tr -d '[:space:]' < "$RLM_CALL_COUNTER_FILE")"
```

The repository root, feature branch, origin push URL, and ancestral base commit
bind the envelope to one delivery line while allowing later commits on that same
line. A rebase or remote change requires a fresh run instead of silently moving
proof state. The counter file is authoritative. Explicitly restoring
`RLM_CALL_COUNT` prevents a missing or contaminated ambient value from becoming
the fallback. The cost ledger preserves observational spend and token telemetry
across sessions.

## Admission and coverage

At most three child model generations are active across the tree. Additional
siblings queue and run when capacity becomes available; they are not refused
because three earlier children existed. Depth remains three. Total child calls
continue until the declared proof obligations are terminal, a concrete blocker
prevents further evidence, or the emergency backstop is reached.

Deduplicate already-proved mechanisms and charter new calls against open
questions. Scheduling heuristics may reduce active concurrency, but they never
waive required sibling coverage, descendant checks, failed-gate repair, or
closeout evidence.

## Execution order

1. **Discover deterministically.** Use `rg`, Python, source inspection, and
   existing validators before asking a model.
2. **Choose one root integration head.** Explore and decide in the root. Once
   bounded units have explicit, non-overlapping file scopes, constraints, and
   tests, delegate at most three simultaneous `mode=implement` children in one
   native batch.
   Implement directly when partitioning would cost as much as the edits. Wait
   for the full batch, review each attempt reference, declared scope, snapshot
   diff, and worktree-removal verdict, then apply the refs without automatic
   conflict resolution and run focused gates. Dispatch later batches when new
   disjoint units are discovered.
3. **Cover independent risk facets.** Start disjoint reviews concurrently when
   useful, with no more than three active. Do not expose sibling reports:
   - runtime/lifecycle: deadlines, cancellation, process groups, output,
     async, worktree/ref finalization, and recovery;
   - entry/evidence: routing, prompt authority, source-checkout resolution,
     generated artifacts, eval honesty, and delivery gates;
   - security/cleanup: path containment, permissions, temp ownership,
     symlinks, deletion scope, and hostile metadata.
4. **Absorb skeptically.** The parent deduplicates by mechanism, reproduces each
   accepted finding, and records it in the existing blocker/telemetry ledger.
5. **Fix serially.** Re-evaluate only invalidated owners.
6. **Focus re-review on reopened evidence.** Give it open blockers and changed
   paths; ask for resolution failures and regressions. Add targeted reviewers
   when a named disagreement or uncovered mechanism remains.
7. **Run independent closeout.** Stop the review loop only when the proof
   ledger is terminal. A direct counterexample reopens the affected owner even
   after a prior PASS.

If a second broad `REOPEN` occurs or root context degrades, write a continuation
brief and resume with the same envelope before making more edits.

## Child result boundary

Every inline finding includes `path:line`, mechanism, user impact, and one
reproduction command or artifact reference. When the transport cannot carry the
complete report safely, the child writes the unabridged report beneath the run
directory and returns its path plus an integrity hash. Findings are never
discarded because an arbitrary count was reached.

Long reproduction scripts belong in run artifacts, not the parent response. No
new schema validator is required; this is a charter and parent-absorption rule.

## Model and async policy

Reviewers, focused re-review, and closeout use the strong configured model.
Mechanical discovery stays in deterministic tools. A cheaper model is allowed
only for a bounded synthesis call launched in its own shell process with an
explicit provider/model route; do not set global depth routing.

Native calls may run in parallel. Writable active fan-out is capped at three
and requires mechanically disjoint declared scopes; do not include root
mutators in the same batch or integrate before all results return. Parallel shell
`rlm_query --async` remains read-only. Record each returned job, output,
sentinel, and PID, then collect every required result explicitly. A host
completion watcher may wake the root, but it does not adjudicate or collect the
result. If the root cannot keep ownership of collection and cancellation, stay
sequential.

## Freeze before provider-backed evaluation

Before the first live-model lane:

1. close all source-review blockers;
2. run `make test-fast` and `make test-extensions`;
3. run `make test-eval-contracts` with mock Pi;
4. commit every tracked change;
5. require a clean checkout and record exact HEAD.

Runtime parity runs only through the existing facade:

```bash
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=canonical-cli
YPI_EVAL_OUTPUT_ROOT="$RUN_DIR/eval" make eval-runtime-parity LANE=canonical-native
```

`tests/eval/runtime-parity/run-lane.sh` owns recursion-environment sanitization,
private counters/ledgers, exact transition and call-count proof, and semantic
scoring. Run the two independent lanes concurrently with explicit collection.
Do not construct an ad-hoc `env -i` lane. Do not edit tracked files while lanes
run. A tracked edit invalidates final runtime evidence. Permit one rerun only
for a documented provider or transport failure.

## Closeout and delivery

Completion requires resolved telemetry, deterministic source-checkout checks,
exact-final-commit runtime contracts, parent verification, independent review,
live recursion proof when required, and honest branch state. Import a recursive
trace into Agent Protocol only when child execution itself is being promoted as
proof.

Before any push, resolve the push URL and run `scripts/validate-push-owner`.
Remotes whose exact owner namespace is not `ruslanvasylev` are read-only unless
the current user request explicitly authorizes that exact target. Release,
tagging, and package publication are separate user-initiated tasks and are never
inferred or suggested by this delivery workflow.

## Metrics

Record allocations, spawned sessions, overlapping child-minutes, root wall
time, transcript bytes, receipt validation, root-plus-child usage, cost/tokens
from the run ledger, duplicate mechanisms, timeouts, and rejected live-model
lanes. The historical non-dollar baseline is 131
allocations, 42 sessions, 842.6 overlapping child-minutes, 31.4 MB transcripts,
and about 9h20m root wall time. The historical orchestration had no comparable
`RLM_COST_FILE`; do not invent a dollar baseline or savings percentage.

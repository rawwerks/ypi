# Depth 3 vs 4 ablation

## Contract

- Runtime source commit: `036f5d3` on `feat-unify-recursion-runtime`; the fixture and hardened replay runner were promoted later, so this historical row is not a claim that the runner existed at that commit.
- Same planted TypeScript audit fixture and goal/acceptance prompt.
- Same `openai-codex/gpt-5.6-sol` route and `max` thinking.
- Same `RLM_MAX_CALLS=16`, `RLM_TIMEOUT=900`, explicit read-only isolation mode, and isolated counters/sessions.
- Only `RLM_MAX_DEPTH` changed.
- Ground truth: 12 contract violations across six files.

## Result

| Metric | Depth 3 | Depth 4 |
|---|---:|---:|
| Exit | 0 | 124 timeout |
| Final answer | yes | none |
| True positives | 12 | 0 |
| False positives | 0 | 0 |
| Allocated call attempts | 10 | 10 |
| Spawned trace transitions | 9 | 9 |
| Maximum observed child depth | 3 | 4 |
| Elapsed | 732.267 s | 900.071 s |
| Complete cost-ledger events | $3.269840 | $4.387705 |
| Complete cost-ledger tokens | 1,529,367 | 2,780,716 |
| Session-observed usage | $3.269840 / 1,529,367 | $4.684875 / 2,927,884 |
| Max RSS | 273,284 KiB | 328,284 KiB |

Depth 3 found every planted defect with no unsupported finding. Using only
complete cost-ledger events, depth 4 used 1.342× cost and 1.818× tokens; the
session files show additional usage after the last complete cost boundary.
Depth 4 also used 1.201× RSS and exhausted the tree-wide timeout without a final
answer. Timeout therefore makes the ledger figures a lower bound, not total spend.

## Decision

Keep `RLM_MAX_DEPTH=3` rather than promoting the tested depth-4 default. Preserve depth 4+ as an explicit per-run
override coupled to call and time/budget controls. This paired benchmark rejects
a global depth-4 promotion; it does not claim deeper recursion can never help on
a different task. Depth 2 was not evaluated, so this result does not claim that
3 is globally optimal.

Tracked evidence: `score.json`, the fixture, ground truth, scorer, and runner in
this directory tree. Raw `depth-*/meta.json`, model output, traces, and sessions
remain in the branch-local evaluation workdir recorded by the original run.

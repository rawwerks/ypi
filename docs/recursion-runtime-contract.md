# Recursion Runtime Contract

This document defines the ownership boundary for ypi recursion. The executable
contract is `tests/runtime_contract_harness.ts`; documentation cannot change
behavior without a matching source and test change.

## Canonical Owner

`extensions/ypi/runtime-core.ts` is the only child-runtime entry point available
to adapters. It owns:

- depth and terminal-depth admission;
- atomic tree-wide call allocation;
- optional tree-wide timeout accounting;
- provider, model, and thinking-level routing by child depth;
- exact prompt, root charter, context, and session transport;
- child environment allowlisting and discovery isolation;
- canonical extension selection;
- read-only review mode and root-only implement mode;
- child process cancellation, exit classification, streaming bounds, and
  cleanup;
- trace, token, and cost telemetry.

Private owners under `extensions/ypi/internal/` implement these policies. An
adapter must not bypass them or duplicate their decisions.

## Adapter Ownership

### Native Pi Adapter

`extensions/ypi/native-tool.ts` owns only:

- TypeBox request schema and tool registration;
- Pi context, model, thinking, and session projection;
- live progress and cancellation bridging;
- tool-result presentation.

Native requests may execute in parallel. Implement requests carry explicit path
scopes; the shared registry admits at most three and refuses component-overlap.
The extension blocks root mutators and unknown tools from a mixed implementer
batch. The root waits for the full batch before mutating or integrating.

### Shell Adapter

`extensions/ypi/cli.ts` owns only:

- `--fork`, `--async`, and `--notify` parsing;
- explicit, piped, or file-backed context selection;
- background job metadata, immutable input snapshots, sentinel, notification,
  and cancellation behavior;
- backpressure and broken-pipe handling;
- command-line error presentation.

The `rlm_query` file resolves the checkout, selects the Pi and Node
executables, and launches the generated adapter. It owns no recursion policy.
`dist/rlm_query.mjs` must be reproducible from the TypeScript source.

## Shared Invariants

Equivalent native and shell requests must agree on:

1. child depth and allocated call number;
2. provider, model, and thinking level;
3. prompt and context visible to the child;
4. session and fork behavior;
5. extension and non-extension discovery policy;
6. credential and recursive environment projection;
7. timeout and maximum-call admission;
8. process exit, cancellation, output, and cleanup classification.

Adapter-specific Pi arguments are permitted only when the surface requires
them. Every intentional difference belongs in the executable contract.

## Context And Sessions

The exact child charter is file-backed and sent through Pi's non-interactive
input. The active root request and delegated charter remain symbolically
addressable. When a caller supplies exact context, the child receives its file
path rather than a copy embedded into the prompt.

An asynchronous call snapshots its context, root charter, and fork source
before acknowledging admission. Later mutation of the caller's files cannot
change the admitted job.

Shared sessions use the active Pi session directory. Forking pre-populates the
child session with the parent snapshot. A non-fork child may still have its own
session file but does not inherit parent events.

## Implement Mode

Implement mode is available only to depth 0 and only in an existing clean Git
checkout. It refuses:

- dirty, sparse, non-Git, or operation-in-progress checkouts;
- a missing, invalid, or overlapping scope;
- admission beyond the three-implementer cap, or a descendant writer;
- a missing canonical extension;
- submodule mutation;
- writes outside the declared scope or worktree, through symlink escapes,
  inside `.git`, or to ignored paths.

Each implementer has no shell process tool and edits a detached ephemeral Git
worktree at the common baseline. The user's real checkout stays clean. After
the child exits, the runtime captures the complete worktree through a temporary
index, verifies that every changed path belongs to the declared scope, creates
a commit and `refs/ypi/attempt-*` reference, stages again to detect drift, then
removes the worktree and lease.

The persisted lease records owner and child PIDs, baseline, scope, worktree,
and ref state. Any uncertain failure retains it. A verified reference is
reported when available; otherwise the isolated worktree remains the primary
copy. A launch gate persists the detached child PID before releasing Pi, so a
parent death cannot create an unregistered writer. `rlm_cleanup` never removes
a live lease. For a dead lease it snapshots the exact current worktree when
needed, verifies the ref and worktree trees match, removes the worktree, and
prunes stale Git metadata. A recovered ref is not eligible for age-based
expiration until a later cleanup invocation.

Worktrees contain tracked files only. Ignored files and uninitialized submodule
content must arrive through explicit context or remain root-owned.

`tests/workspace_crash_matrix.ts` covers single-lease interruption.
`tests/workspace_concurrent_crash_matrix.ts` kills children at six stages and a
parent with two leases. It proves work preservation, live-lease isolation,
registry recovery, and a continuously clean real checkout.

## Default Guardrails

- `RLM_MAX_DEPTH` defaults to 3. The tracked depth ablation found all planted
  defects at depth 3, while depth 4 consumed more resources and timed out on
  that task. This does not claim a universal optimum.
- `RLM_MAX_CALLS` defaults to 128 and is shared by the whole tree.
- No timeout is set by default. A caller may explicitly set one.
- Cost and tokens are telemetry only. Dollar caps are unsupported.
- Staleness warnings observe live work and never terminate it.
- The root continues directly when a depth or call boundary prevents another
  child.

`config/runtime-env.json` owns the complete input registry. README tables are
checked against that registry. Provider credential forwarding has a separate
source-derived allowlist test because those names belong to Pi providers, not
the recursion configuration namespace.

## Result And Telemetry Rules

Normal exit, timeout, cancellation, and child failure are distinct. Output
limits are enforced during streaming, not after unbounded retention.
Incremental structured parsing must still observe late answer and cost events
when an earlier event crosses a capture limit.

If an omitted oversized event could own cost, or a failed structured child
never emits its terminal usage event, the ledger is marked incomplete. That
marker qualifies telemetry but never blocks later product work.

The shared contract, generated-bundle check, native harness, guardrail suite,
and extension smoke must pass before an adapter change is accepted.

# Recursion Runtime Contract

This document defines the ownership boundary for ypi recursion. The executable
contract is `tests/runtime_contract_harness.ts`; documentation cannot change
behavior without a matching source and test change.

## Canonical Owner

`extensions/ypi/runtime-core.ts` is the only child-runtime entry point available
to adapters. It owns:

- depth and terminal-depth admission;
- atomic tree-wide call allocation;
- generation-bound tree-wide child-concurrency admission;
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

## Implementer State Ownership

The writable lifecycle has one persisted contract:

- `internal/implementer-lease.ts` owns lease states, object-ID rules, attempt
  ref naming, and schema validation;
- `internal/atomic-file.ts` owns durable file replacement;
- `internal/tree-coordinator.ts` owns root-generation authority, atomic
  tree-wide call allocation, the three-generation queue, cooperative slot
  yielding, and registered child process identities;
- `internal/concurrency.ts` is the narrow client for coordinator-backed slot
  acquisition, launch registration, suspension, and release;
- `internal/implementer-registry-layout.ts` owns implementer registry paths and
  conservative recovery-state detection;
- `internal/workspace-registry.ts` owns live admission and registry mutation;
- `internal/implementer-recovery/` owns stale-state classification, Git
  salvage, workspace ownership proof, and destructive recovery;
- `scripts/launch-recursive-child.ts` and
  `scripts/cleanup-implementer-workspaces.ts` are thin Node entry points.

Live execution and recovery import the same lease contract. Recovery does not
redeclare the schema, scope normalization, or state names. Destructive
worktree removal remains private to the recovery workspace owner and occurs
only after a verified ref or a proven pre-admission state.

## Adapter Ownership

### Native Pi Adapter

`extensions/ypi/native-tool.ts` owns only:

- TypeBox request schema and tool registration;
- Pi context, model, thinking, and session projection;
- live progress and cancellation bridging;
- tool-result presentation.

Native requests may execute in parallel. A root-owned authenticated coordinator
admits three active child generations and queues additional calls. Waiting
parents cooperatively yield their inherited slot, so a full depth-1 batch
cannot deadlock depth-2 or depth-3 work. The coordinator freezes the configured
cap for one root generation and rejects per-process drift; cancellation and the
tree deadline remain binding while a yielded parent reacquires its slot. Every
request proves the exact private authority manifest, generation secret, caller
process identity, and live stable root identity. Root cancellation first marks
the generation terminal, then signals only registered child process groups.
Detached survivors cannot admit or launch more work after root death.
Continuation adopts a pre-existing call-counter inode only when it is a
current-user-owned `0600` one-link file whose canonical contents exactly match
the declared count. Long evidence paths use a separate bounded private socket
directory, which is retired only after the server and all request connections
close.
Implement requests carry explicit path scopes; the writer registry refuses
component-overlap. The extension blocks root mutators and unknown tools from a
mixed implementer batch. The root waits for the full batch before mutating or
integrating.

### Shell Adapter

`extensions/ypi/cli.ts` owns only:

- `--fork` and `--async` parsing;
- explicit, piped, or file-backed context selection;
- background job metadata, immutable input snapshots, sentinel, and
  cancellation behavior;
- backpressure and broken-pipe handling;
- command-line error presentation.

The `rlm_query` file resolves the checkout, selects the Pi and Node
executables, and launches the generated adapter. It owns no recursion policy.
`dist/rlm_query.mjs` must be reproducible from the TypeScript source.

`rlm_cleanup` is likewise a thin shell adapter around the TypeScript recovery
CLI. It owns generic temporary-file and attempt-ref retention policy, not lease
schema or worktree salvage behavior.

## Shared Invariants

Equivalent native and shell requests must agree on:

1. child depth and allocated call number;
2. provider, model, and thinking level;
3. prompt and context visible to the child;
4. session and fork behavior;
5. extension and non-extension discovery policy;
6. credential and recursive environment projection;
7. timeout, maximum-call, and child-concurrency admission;
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

`RLM_REQUIRE_TRANSCRIPTS=1` turns auditability into a proof gate. Admission
fails before spawn unless session sharing uses an existing absolute
current-user-owned `0700` directory with no symlinked ancestry. The runtime
atomically creates each deterministic child file as `0600`, holds its
descriptor across the child lifetime, and rejects stale targets. Fork mode
copies a strict JSONL parent prefix before publication.

After the child becomes terminal, the runtime proves that the pathname still
names the leased, singly-linked inode; the directory identity and permissions
are unchanged; the secured prefix digest is unchanged; and the appended bytes
are strict UTF-8, newline-terminated JSONL containing at least one Pi message
event. It then atomically creates a per-call receipt beside the transcript.
Transcript failure is secondary to an existing nonzero child outcome, so it
does not replace exit `42`, timeout `124`, or cancellation `130`.
`scripts/validate-recursion-transcripts.ts` requires one matching start,
completion, post-cleanup lifecycle terminal marker, transcript, and receipt for
every call and recomputes the current digests. A completion record alone cannot
prove that resource cleanup, slot release, and inherited-parent resumption
succeeded. `rlm_sessions` is a direct-child, no-symlink presentation tool; it
is limited to current-user-owned `0600` singly-linked files in a `0700`
directory. It is not an evidence validator.

## Implement Mode

Implement mode is available only to depth 0 and only in an existing clean Git
checkout. It refuses:

- dirty, sparse, non-Git, or operation-in-progress checkouts;
- a missing, invalid, or overlapping scope;
- a descendant writer;
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
prunes stale Git metadata. Attempt refs are evidence and are never deleted by
age; `--attempt-age` only controls which preserved refs the cleanup report
lists.

Worktrees contain tracked files only. Ignored files and uninitialized submodule
content must arrive through explicit context or remain root-owned.

`tests/workspace_crash_matrix.ts` covers single-lease interruption.
`tests/workspace_concurrent_crash_matrix.ts` kills children at six stages and a
parent with two leases. It proves work preservation, live-lease isolation,
registry recovery, and a continuously clean real checkout.
`tests/cross_depth_cancellation_harness.ts` separately proves that root
cancellation terminalizes authority before signalling independently detached
writer and recursive-descendant process groups, blocks post-terminal
admission, preserves writable work, and leaves unrelated processes untouched.

## Default Guardrails

- `RLM_MAX_DEPTH` defaults to 3. The tracked depth ablation found all planted
  defects at depth 3, while depth 4 consumed more resources and timed out on
  that task. This does not claim a universal optimum.
- `RLM_MAX_CALLS` is a shared tree-wide emergency backstop and defaults to
  65,536. It is deliberately far above observed paper-scale useful call counts;
  explicit proof envelopes may set a smaller task-specific bound.
- `RLM_MAX_CONCURRENT_CALLS` defaults to 3. Calls beyond the active-generation
  limit wait; they are not rejected or silently dropped.
- `RLM_REQUIRE_TRANSCRIPTS` defaults to 0. Proof-bearing or benchmark runs set
  it to 1 and provide a private explicit session directory.
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

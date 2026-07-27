---
name: bounded-recursive-delegation
description: Use for a coding task that benefits from bounded ypi review or root-chartered implementation slices with explicit evidence and acceptance gates.
---

# Bounded Recursive Delegation

## Goal

Keep the root responsible for the user's goal, commands, tests, final diff, and
acceptance while child contexts absorb bounded review or implementation work.

## Workflow

1. Inspect and size the task with deterministic tools before delegating.
2. Delegate work that is expensive to produce but straightforward to verify:
   large-surface reading, an independent audit, a counterprobe, or bounded
   edit/write slices.
3. Use native `rlm_query` `mode=review` by default. Give the child one
   objective, an exact context boundary, and a pass or reopen criterion.
4. Native calls may run in parallel. For implementation, derive file ownership
   first, declare literal repository-relative scopes, and batch no more than
   three mutually disjoint slices. Do not mutate the root checkout or integrate
   results until the batch returns. Shell `rlm_query --async` remains a
   read-only review surface whose job artifacts the caller collects explicitly.
5. Do not expose sibling reports to independent reviewers. The root
   deduplicates by mechanism, reproduces accepted findings, and resolves
   disagreement.
6. Only the root may request `mode=implement`. Each charter names one scope,
   constraints, and verification. The child receives scope-confined edit/write
   tools in an isolated worktree but no shell process tool. Descendants remain
   reviewers.
7. Never install or initialize version-control tooling. If the checkout is
   dirty, sparse, non-Git, the scope overlaps, or the lease cap is full,
   implement directly in the root or wait for the conflicting slice.
8. Treat an implementer result as a candidate snapshot. Inspect the reported
   `refs/ypi/attempt-*` reference, declared scope, changed paths, diffstat, and
   worktree-removal verdict before applying it. Apply disjoint refs without
   auto-resolving conflicts, then run parent-owned tests.
9. Require each child result to state verdict, evidence, files inspected,
   files changed, commands run, blockers, risks, and stop reason. Keep the
   inline result bounded and cite an artifact for overflow.
10. When depth or call admission closes, stop spawning children and continue
    directly. Cost and elapsed time remain visibility only.

## Publication Boundaries

- Resolve push authority from the actual URL, not the remote name.
- A remote outside the exact `ruslanvasylev` owner namespace is read-only
  unless the current request explicitly authorizes that exact operation.
- Delivery does not imply release, publication, or tagging authority.

## Acceptance

The root accepts a child result only when direct evidence satisfies the charter
and remains aligned with the original user goal. Passing tests alone are not
enough for writable work; declared scope, snapshot diff, worktree-removal status,
and parent verification must also pass.

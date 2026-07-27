---
name: bounded-recursive-delegation
description: Use for a coding task that benefits from bounded ypi review or one root-chartered implementation unit with explicit evidence and acceptance gates.
---

# Bounded Recursive Delegation

## Goal

Keep the root responsible for the user's goal, commands, tests, final diff, and
acceptance while child contexts absorb bounded review or implementation work.

## Workflow

1. Inspect and size the task with deterministic tools before delegating.
2. Delegate work that is expensive to produce but straightforward to verify:
   large-surface reading, an independent audit, a counterprobe, or one bounded
   edit/write unit.
3. Use native `rlm_query` `mode=review` by default. Give the child one
   objective, an exact context boundary, and a pass or reopen criterion.
4. Native calls are sequential. Use shell `rlm_query --async` only for
   independent read-only reviews when the wrapper exposes it. Record the
   returned job artifacts and collect them explicitly; no automatic watcher is
   present.
5. Do not expose sibling reports to independent reviewers. The root
   deduplicates by mechanism, reproduces accepted findings, and resolves
   disagreement.
6. Only the root may request `mode=implement`, and only one implementer may run.
   Its charter names files, constraints, and verification. The child receives
   checkout-confined edit/write tools but no shell process tool.
7. Never install or initialize version-control tooling. If the checkout is
   dirty, sparse, non-Git, or already leased, implement directly in the root.
8. Treat an implementer result as a candidate snapshot. Inspect the reported
   `refs/ypi/attempt-*` reference, changed paths, diffstat, and restoration
   verdict before applying it. Run parent-owned tests after application.
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
enough for writable work; changed scope, snapshot diff, restoration status,
and parent verification must also pass.

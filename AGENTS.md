# Agent Instructions - ypi

## Authority Boundaries

- Use only the existing Git checkout. Never install or initialize Git or any
  other version-control system.
- Resolve push authority from the remote URL, never the remote name. A remote
  outside the exact `ruslanvasylev` owner namespace is read-only unless the
  current user request explicitly authorizes that exact operation.
- Never release, publish, or tag unless the current user request explicitly
  initiates that operation. Do not ask whether to do it.
- Never set or recommend a dollar budget for recursive work. Cost and token
  data are telemetry. Depth, total call admission, live progress, deduplication,
  and manual cancellation are controls.
- Preserve user changes in a dirty checkout. Do not reset or remove work you
  did not create.

## Runtime Model

This repository has one recursion engine:

- `extensions/ypi/runtime-core.ts` owns child admission, routing, resources,
  process execution, results, telemetry, and cleanup.
- `extensions/ypi/native-tool.ts` adapts that engine to Pi's native
  `rlm_query` tool.
- `extensions/ypi/cli.ts` adapts it to the `rlm_query` shell command.
- `dist/rlm_query.mjs` is generated and must match the TypeScript source.

Every depth uses the same prompt, runtime, and extension. Review mode is
read-only by default. Writable delegation is root-only, sequential, and
limited to one bounded implementer in an existing clean Git checkout.
Descendants cannot escalate writable authority.

The root wrapper enables the shell helper and includes its runtime source in
the child prompt for self-inspection. Direct extension use exposes only the
native tool. Children load the canonical extension by default; ambient
extension discovery is an explicit compatibility choice.

## First Checks

For runtime failures, run:

```bash
make doctor
```

The most common failure is a stale or wrong host Pi binary. The doctor checks
the executable selected by the wrapper, its package identity, `.pi-version`,
and ambient-extension policy.

Before any change to `rlm_query`, its generated bundle, or the shared runtime:

```bash
make test-unit
```

After each coherent runtime change:

```bash
make test-fast
make test-extensions
```

After changing recursive behavior, run the live smoke:

```bash
echo "2+2=" | ./rlm_query "What is the answer? Reply with only the number."
```

The expected answer is `4`. A failure means the active recursive dependency is
broken and must be repaired before further feature work.

## Delegation

Use `rlm_query` only for a clear, bounded task that benefits from a fresh
context window. Read small inputs directly. At deeper levels, prefer returning
a concrete result over adding another child.

Native `mode=review` is the default. It is appropriate for audits, research,
and counterevidence. Native `mode=implement` is allowed only from the root for
one edit/write unit with explicit scope and verification. Never run parallel
implementers. The parent owns commands, tests, final diff review, and
acceptance.

The implementer edits the existing checkout under an exclusive lock. On
success, the runtime records the complete attempt at a verified
`refs/ypi/attempt-*` reference, restores the clean baseline, and reports the
reference, commit, changed paths, diffstat, and restoration verdict. The root
must inspect and explicitly apply the snapshot. On any unproven snapshot or
reset state, the checkout and lock are retained for recovery.

Shell `rlm_query --async` is for bounded read-only fan-out. It prints job,
output, sentinel, and PID data. There is no automatic repository completion
watcher; the caller owns collection and cancellation.

For large, proof-bound, or self-hosting changes, read
`docs/bounded-recursive-development.md` before the first child call. Use its
single persisted envelope, disjoint reviewers, one implementation head,
continuation-without-reset rule, and freeze-before-live-model gate.

## Git Workflow

Work on a reviewable feature branch:

```bash
git status --short --branch
git switch -c feat/description
# edit and validate
git add <scoped-paths>
git commit -m "type: description"
scripts/validate-push-owner "$(git remote get-url --push origin)"
git push -u origin HEAD
```

Before pushing:

```bash
make pre-push-checks
```

`make land` performs the same checks against an unchanged clean commit and
pushes only the current feature branch to an approved `origin`. It never
merges or creates any release artifact.

Install local hooks once per clone:

```bash
make install-hooks
```

## Project Layout

```text
ypi
|-- ypi                         source-checkout launcher
|-- rlm_query                   shell adapter launcher
|-- dist/rlm_query.mjs          generated CLI bundle
|-- SYSTEM_PROMPT.md            canonical recursive guidance
|-- config/runtime-env.json     runtime configuration registry
|-- extensions/recursive.ts     Pi extension entry
|-- extensions/ypi/             canonical runtime and adapters
|-- skills/                     bounded delegation skill
|-- docs/                       runtime and development contracts
|-- tests/                      deterministic and live gates
|-- scripts/                    health, delivery, and compatibility tools
|-- pi-mono/                    pinned Pi source submodule
`-- Makefile                    verification entry points
```

Do not add a second engine or duplicate configuration table. Runtime variables
belong in `config/runtime-env.json`; public descriptions belong in `README.md`.
`tests/test_config_surface.sh` enforces source, registry, and documentation
agreement.

## Test Gates

`make test-fast` runs without live model calls. It includes:

- TypeScript type checking and generated-bundle parity
- shell, native, and shared-runtime behavior
- depth, timeout, call-count, session, and isolation guardrails
- configuration and provider-credential allowlist completeness
- implementer admission, write confinement, snapshot/reset, and crash recovery
- publication authority and doctor behavior

`make test-extensions` loads the real pinned Pi without a model call.

Live calls are explicit:

```bash
make test-recursion-e2e
make test-extensions-e2e
```

Do not block the main conversation with an unattended long-running test. When
the surrounding runtime provides a completion signal, use it. Otherwise keep
the command attached or return a clear running-state handoff with its output
location and PID.

## Editing The Live Runtime

`rlm_query` and the TypeScript runtime are dependencies of the active agent.
Change one ownership layer at a time:

1. Run `make test-unit`.
2. Copy the file being changed to a local backup when rollback would otherwise
   be difficult.
3. Edit the source.
4. Run `make test-fast`.
5. Run the real `2+2` recursive smoke.
6. Remove the backup only after the active path is proven.

Do not change `rlm_query` and `SYSTEM_PROMPT.md` in one unverified step.

## Regression History

These failures have dedicated coverage and must not return.

### 1. Empty Pipe Mistaken For Context

Some CI shells make `/dev/stdin` appear to be a pipe even when it yields no
bytes. Use `RLM_STDIN` as the explicit-read marker; when a pipe read is empty,
fall back to inherited `CONTEXT`. Covered by T2-T4.

### 2. Prompt Text Passed As A Shell Argument

Large prompt text and shell escaping made argument passing unsafe. Pass the
prompt file path and let Pi read it. Covered by T8-T9.

### 3. Recursing On Tiny Context

Aggressive guidance created unnecessary child chains. Inspect context size and
read small inputs directly. Covered by E1 and E7.

### 4. Call Limit Off By One

Call allocation is one-based. Permit calls 1 through `RLM_MAX_CALLS` and reject
only the next allocation. Covered by native and guardrail suites.

### 5. Unsafe Trace Identifiers

`RLM_TRACE_ID` enters filenames. Sanitize it before any path use. Covered by
N13 and G52.

### 6. Timeout Anchored At Session Start

`RLM_START_TIME` belongs to each depth-0 recursion tree, not extension load.
Long-lived root sessions must receive a fresh tree anchor. Covered by N3, N12,
G4, and G16.

### 7. Invalid Background Notification Data

Child output must be JSON-encoded before it enters a notification record, and
temporary job paths must honor `TMPDIR`. Covered by G53.

### 8. Credential Allowlist Drift

The child environment is allowlisted. Completeness must be derived from Pi's
real provider credential source, not guessed suffix patterns. This specifically
caught `COPILOT_GITHUB_TOKEN` and `HF_TOKEN`. Covered by
`tests/test_provider_allowlist.sh`.

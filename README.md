# ypi

`ypi` is a source-distributed recursive coding agent built on
[Pi](https://github.com/earendil-works/pi). It adds one canonical TypeScript
recursion runtime with two adapters:

- `extensions/recursive.ts` registers a native Pi tool named `rlm_query`.
- `rlm_query` is a shell adapter for pipelines, explicit context, and
  background jobs.

The `ypi` launcher loads the extension, the repository prompt, and the bounded
delegation skill. Review children are read-only by default. A root agent can
charter one bounded implementer in an existing clean Git checkout.

## Source Setup

Requirements:

- Git
- Bun
- Node.js 22.19 or newer
- provider credentials supported by Pi

```bash
git clone https://github.com/ruslanvasylev/ypi.git
cd ypi
git submodule update --init --depth 1
bun install --frozen-lockfile
make doctor
make test-extensions
```

This repository is the distribution boundary. It is private in
`package.json`; there is no registry or curl installation path.

## Entry Paths

Run the configured wrapper:

```bash
./ypi
./ypi -p "Explain the main execution path in this checkout."
./ypi --provider openai --model gpt-5.5 -p "Review the current branch."
```

Or load only the native extension into the repository-local Pi:

```bash
./node_modules/.bin/pi --no-extensions \
  -e "$PWD/extensions/recursive.ts" \
  -p "Use rlm_query to ask a child what 2 + 2 is."
```

Direct extension use registers the native tool and uses the same runtime core.
It does not enable the shell helper or place repository commands on `PATH`.

The native tool accepts:

| Field | Meaning |
|---|---|
| `prompt` | Required bounded child charter. |
| `context` | Optional exact context text. |
| `fork` | Copy the current parent session into the child session before execution. |
| `mode` | `review` by default, or root-only `implement`. |

The shell adapter reads standard input when `RLM_STDIN` marks it as explicit or
when stdin is non-interactive. A non-empty read wins; otherwise it falls back
to the file named by `CONTEXT`. Its public flags are:

<!-- rlm-query-flags:start -->
| Flag | Meaning |
|---|---|
| `--async` | Admit a background review call and return its job paths. |
| `--fork` | Copy the current parent session into the child session. |
| `--notify` | With `--async`, signal the supplied caller PID at terminal state. |
<!-- rlm-query-flags:end -->

For example:

```bash
sed -n '1,200p' src/service.ts | ./rlm_query "Review this code for data loss."
./rlm_query --fork "Recheck the current session's main conclusion."
./rlm_query --async "Audit the authentication boundary."
```

An asynchronous admission prints JSON containing `job_id`, `output`,
`sentinel`, and `pid`. The sentinel contains the exit code when the job is
terminal. No repository extension watches those files or wakes a caller; the
caller owns collection and cancellation.

## Recursion Contract

Every non-leaf child runs Pi with the same canonical extension and prompt.
Recursion disappears when the next child would exceed `RLM_MAX_DEPTH`.
`RLM_MAX_CALLS` is allocated across the whole tree through a shared counter.
The optional timeout is also tree-wide. Cost and token values are observational
telemetry and never an admission or termination control.

The root keeps its normal Pi tools. Review children exclude mutation and
process-spawning tools. Child extension discovery is canonical-only unless the
caller explicitly accepts ambient extension compatibility. Provider, model,
and thinking level inherit from the active root route unless child-specific or
depth-specific routing is configured.

Use direct inspection for small inputs. Delegate only bounded work that
benefits from a fresh context window. At deeper levels, prefer returning a
concrete result over adding another child call.

## Implementer Lifecycle

Native `rlm_query` may request `mode=implement` only from depth 0. The runtime
admits it only when all of these are true:

- the current directory belongs to an existing, ordinary, clean Git checkout;
- no Git operation is in progress and sparse checkout is disabled;
- no other implementer or interrupted lifecycle owns the repository lock;
- the canonical extension and write-confinement hooks are active.

No secondary Git worktree is created. The implementer edits the existing
checkout under one exclusive lock and receives only
`read,grep,find,ls,edit,write,rlm_query`. It cannot use `bash`. Writes outside
the checkout, through escaping symlinks, inside `.git`, inside submodules, or
to paths ignored by the baseline or final ignore rules are blocked.

After the child exits, the parent runtime:

1. verifies the original HEAD, index, submodules, ignore policy, and audited
   write set;
2. stages the entire attempt in a temporary index;
3. creates a commit and a new verified `refs/ypi/attempt-*` reference;
4. stages again immediately before rollback and requires the tree to match the
   verified snapshot;
5. resets the checkout to the baseline, removes only non-ignored untracked
   files, and proves HEAD, index, status, and submodules are restored;
6. reports changed paths, baseline, attempt reference, commit, diffstat, and
   `Tree restored: yes`, then releases the lock.

The root must inspect the snapshot before accepting it:

```bash
git show --stat refs/ypi/attempt-EXAMPLE
git diff HEAD refs/ypi/attempt-EXAMPLE --
git cherry-pick refs/ypi/attempt-EXAMPLE
```

If snapshot creation or reset cannot be proven safe, finalization fails loudly.
Before a verified reference exists, the dirty checkout remains the primary
copy. After verification, both the reference and checkout state are retained.
In either case the lock remains for explicit recovery.

`make test-workspace-crash` sends `SIGKILL` before snapshot, during staging,
before reference update, after verified snapshot but before reset, and during
reset. Every case must retain the lock, reject a second implementer, and remain
mechanically recoverable. Attempt references are retained by default;
`./rlm_cleanup --repo PATH` previews references older than seven days and
requires `--force` to remove them.

## Runtime Configuration

`config/runtime-env.json` is the machine-readable owner. This table is checked
against the source and must contain exactly the public variables.

<!-- runtime-env:start -->
| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT` | unset | Context file used when no explicit non-empty input is supplied. |
| `PI_TRACE_FILE` | private temporary file | Append-only lifecycle trace destination. |
| `RLM_AMBIENT_EXTENSIONS` | `auto` | Root policy: allow, isolate, or detect conflicting recursion extensions. |
| `RLM_CHILD_DISCOVERY` | enabled | Set to `0` to isolate child skills, templates, themes, context files, and approvals. |
| `RLM_CHILD_EXTENSIONS` | parent policy | Override extension loading for recursive children. |
| `RLM_CHILD_MODEL` | root model | Model for every child depth. |
| `RLM_CHILD_MODELS` | unset | Comma-separated model route for child depths 1, 2, and later. |
| `RLM_CHILD_PROVIDER` | root provider | Provider paired with the all-depth child model. |
| `RLM_CHILD_PROVIDERS` | unset | Comma-separated provider route by child depth. |
| `RLM_CHILD_THINKING_LEVEL` | root level | Thinking level for every child depth. |
| `RLM_CHILD_THINKING_LEVELS` | unset | Comma-separated thinking-level route by child depth. |
| `RLM_COST_FILE` | private temporary file | Append-only cost and token telemetry destination. |
| `RLM_EXTENSIONS` | `1` | Base extension policy propagated to children; it does not unload the wrapper's root extension. |
| `RLM_JSON` | `1` | Set to `0` for plain child output without structured cost parsing. |
| `RLM_MAX_CALLS` | `128` | Maximum admitted child calls in one tree. |
| `RLM_MAX_DEPTH` | `3` | Maximum recursion depth. |
| `RLM_MODEL` | active Pi model | Root route and inherited child model. |
| `RLM_PROVIDER` | active Pi provider | Root route and inherited child provider. |
| `RLM_SESSION_DIR` | active Pi session directory | Directory for shared child sessions. |
| `RLM_SHARED_SESSIONS` | `1` | Set to `0` to prevent child session sharing. |
| `RLM_STDIN` | unset | Marker forcing an explicit stdin read, even when stdin appears interactive. |
| `RLM_SYSTEM_PROMPT` | repository prompt | Direct adapter prompt override; the wrapper pins this checkout's prompt. |
| `RLM_THINKING_LEVEL` | active Pi level | Root route and inherited child thinking level. |
| `RLM_TIMEOUT` | unset | Optional wall-clock seconds for the whole tree. |
| `RLM_TRACE_ID` | random | Sanitized tree identifier used in telemetry and session filenames. |
| `YPI_EXTENSION_DEBUG` | `0` | Set to `1` for extension diagnostics. |
| `YPI_NODE_BIN` | `node` | Node executable used by the shell adapter. |
| `YPI_PI_BIN` | repository dependency, then `PATH` | Explicit Pi executable override. |
| `YPI_STALL_WARNING_SECONDS` | `600` | Idle seconds before an observe-only child warning. |
<!-- runtime-env:end -->

Provider credentials are forwarded through a separate explicit allowlist
checked against the pinned Pi source by `tests/test_provider_allowlist.sh`.

Useful telemetry readers:

```bash
./rlm_cost
./rlm_cost --json
./rlm_sessions --trace
```

## Architecture

The runtime ownership boundary is:

```text
extensions/recursive.ts
  extensions/ypi/native-tool.ts
  extensions/ypi/runtime-core.ts
    extensions/ypi/internal/*

rlm_query
  dist/rlm_query.mjs
    extensions/ypi/cli.ts
    extensions/ypi/runtime-core.ts
```

`scripts/build-runtime-cli --check` proves the generated CLI bundle matches
the TypeScript source. `docs/recursion-runtime-contract.md` defines adapter and
core ownership. Large proof-bound changes follow
`docs/bounded-recursive-development.md`.

## Verification

Fast deterministic gates:

```bash
make test-fast
make test-extensions
```

The fast suite includes type checking, generated-bundle parity, shell and
native contracts, guardrails, configuration drift, write confinement,
publication authority, the workspace lifecycle, and its crash matrix.

Provider-backed gates are explicit because they consume live model calls:

```bash
make test-recursion-e2e
make test-extensions-e2e
```

Before pushing an owned feature branch:

```bash
make install-hooks
make pre-push-checks
scripts/validate-push-owner "$(git remote get-url --push origin)"
make land
```

`make land` requires a clean non-trunk branch, revalidates the exact commit,
and pushes only that branch to an owner-approved `origin`. It does not merge,
tag, publish, or create a release.

## Troubleshooting

Run `make doctor` first. It selects the same Pi executable as the wrapper and
shell adapter, detects an old or incompatible host binary, checks
`.pi-version`, and reports the ambient-extension decision. Recovery guidance
always points back to this source checkout:

```bash
bun install --frozen-lockfile
make doctor
```

Set `YPI_PI_BIN` only when intentionally testing a different compatible Pi
executable. Historical changes are recorded in `CHANGELOG.md`.

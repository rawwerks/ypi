# pi-recursive

The pure [Pi](https://github.com/earendil-works/pi) extension that lets Pi recursively call
itself — a native `rlm_query` tool that delegates a bounded subtask to a child Pi agent with a
fresh context window, down to a configurable depth.

This is the canonical recursion machinery. The [`ypi`](https://www.npmjs.com/package/ypi) CLI
wrapper is a convenience layer around this same extension (launcher defaults, a shell-compatible
`rlm_query` with pipes/async, cost/session helpers). If you just want recursion inside plain Pi,
install this.

## Install

```bash
pi install npm:pi-recursive
# or try it for one session without installing:
pi -e npm:pi-recursive "Use rlm_query to ask a child what 2 + 2 is."
```

## What you get

- A native `rlm_query` Pi tool — no shell helper, no launcher, no `jj` required.
- Recursive children share the active provider/model, bounded by depth, call count, timeout,
  and budget guardrails.
- `jj` workspace isolation is used automatically when available; recursion still works without it.

The shell-compatible `rlm_query` command, async jobs, and CLI ergonomics live in the `ypi`
wrapper package and are opt-in via `YPI_SHELL_HELPER=1`.

## Configuration

Behavior is controlled through `RLM_*` environment variables. The pure extension honors:

| Variable | Example | What it does |
| --- | --- | --- |
| `RLM_MAX_DEPTH` | `RLM_MAX_DEPTH=3` | How deep recursion can go (default `3`). |
| `RLM_CHILD_MODEL` | `RLM_CHILD_MODEL=haiku` | Use one model for all sub-calls at depth > 0. |
| `RLM_CHILD_PROVIDER` | `RLM_CHILD_PROVIDER=anthropic` | Provider used with `RLM_CHILD_MODEL`. |
| `RLM_CHILD_THINKING_LEVEL` | `RLM_CHILD_THINKING_LEVEL=high` | Thinking level for all sub-calls at depth > 0. |
| `RLM_CHILD_MODELS` | `RLM_CHILD_MODELS=big:high,small:medium` | Comma-separated model route for child depths 1, 2, ... |
| `RLM_CHILD_PROVIDERS` | `RLM_CHILD_PROVIDERS=openai,openai` | Comma-separated provider route for child depths 1, 2, ... |
| `RLM_CHILD_THINKING_LEVELS` | `RLM_CHILD_THINKING_LEVELS=high,medium` | Comma-separated thinking route for child depths 1, 2, ... |
| `RLM_BUDGET` | `RLM_BUDGET=0.50` | Max dollar spend for the recursive tree (requires `RLM_JSON=1`, the default). |
| `RLM_TIMEOUT` | `RLM_TIMEOUT=60` | Wall-clock limit (seconds) for the entire recursive tree. |
| `RLM_MAX_CALLS` | `RLM_MAX_CALLS=20` | Max total `rlm_query` invocations. |
| `RLM_JJ` | `RLM_JJ=0` | Disable `jj` workspace isolation (used automatically when available). |

The shell-helper guardrails and cost/session CLI commands (e.g. `rlm_cost`) documented in the
[ypi README](https://github.com/rawwerks/ypi#readme) apply only to the `ypi` wrapper package, not
to this pure extension.

## Compatibility

This extension is verified against `@earendil-works/pi-coding-agent` `0.79.4`. The peer
dependency is declared as `^0.79.4`, so forward patch/minor Pi releases are accepted; the
extension API surface used (`ExtensionAPI`/`ExtensionContext`/`defineTool` type imports) is stable
across patches.

## Source

Developed in the [rawwerks/ypi](https://github.com/rawwerks/ypi) monorepo; `pi-recursive` is the
extension-only publish view of the same source.

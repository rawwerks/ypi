# ypi

**Y-Combinator Pi** — a recursive coding agent built on [Pi](https://github.com/badlogic/pi-mono).

Named after the [Y combinator](https://en.wikipedia.org/wiki/Fixed-point_combinator#Y_combinator) from lambda calculus — the fixed-point combinator that enables recursion. `ypi` is Pi that can call itself.

Inspired by [Recursive Language Models](https://github.com/SuperAGI/recursive-lm) (RLM), which showed that an LLM with a code REPL and a `llm_query()` function can recursively decompose problems, analyze massive contexts, and write code — all through self-delegation.

## The Idea

Pi already has a bash REPL. We add one function — `rlm_query` — and a system prompt that teaches Pi to use it recursively. Each child gets its own [jj](https://martinvonz.github.io/jj/) workspace for file isolation. That's the whole trick.

```
┌──────────────────────────────────────────┐
│  ypi (depth 0)                           │
│  Tools: bash, rlm_query                  │
│  Workspace: default                      │
│                                          │
│  > grep -n "bug" src/*.py                │
│  > sed -n '50,80p' src/app.py \          │
│      | rlm_query "Fix this bug"          │
│            │                             │
│            ▼                             │
│    ┌────────────────────────────┐        │
│    │  ypi (depth 1)            │        │
│    │  Workspace: jj isolated   │        │
│    │  Edits files safely       │        │
│    │  Returns: patch on stdout │        │
│    └────────────────────────────┘        │
│                                          │
│  > jj squash --from <child-change>       │
│  # absorb the fix into our working copy  │
└──────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
git clone https://github.com/rawwerks/ypi.git
cd ypi
git submodule update --init --depth 1  # pulls pi-mono

# Add to PATH
export PATH="$PWD:$PATH"

# Run (interactive)
ypi

# Run (one-shot)
ypi "Refactor the error handling in this repo"

# Run with a different model
ypi --provider anthropic --model claude-sonnet-4-5-20250929 "What does this codebase do?"
```

## How It Works

### The Three Pieces (same as Python RLM)

| Piece | Python RLM | ypi |
|---|---|---|
| System prompt | `RLM_SYSTEM_PROMPT` | `SYSTEM_PROMPT.md` |
| Context / REPL | Python `context` variable | `$CONTEXT` file + bash |
| Sub-call function | `llm_query("prompt")` | `rlm_query "prompt"` |

### Recursion

`rlm_query` spawns a child Pi process with the same system prompt and tools. The child can call `rlm_query` too, creating a recursive tree:

```
Depth 0 (root)    → full Pi with bash + rlm_query
  Depth 1 (child) → full Pi with bash + rlm_query, own jj workspace
    Depth 2 (leaf) → plain LM call, no tools (RLM_MAX_DEPTH reached)
```

### File Isolation with jj

Each recursive child gets its own [jj workspace](https://martinvonz.github.io/jj/latest/working-copy/):

- Child edits files in isolation — parent's working copy is untouched
- Parent reviews child's work via `jj diff -r <change-id>`
- Parent absorbs useful edits via `jj squash --from <change-id>`
- Workspace is automatically cleaned up when the child exits

### Guardrails

| Feature | Env var | What it does |
|---------|---------|-------------|
| Timeout | `RLM_TIMEOUT=60` | Wall-clock limit for entire recursive tree |
| Call limit | `RLM_MAX_CALLS=20` | Max total `rlm_query` invocations |
| Model routing | `RLM_CHILD_MODEL=haiku` | Use cheaper model for sub-calls |
| Depth limit | `RLM_MAX_DEPTH=3` | How deep recursion can go |
| jj disable | `RLM_JJ=0` | Skip workspace isolation |
| Tracing | `PI_TRACE_FILE=/tmp/trace.log` | Log all calls with timing |

## Files

| File | What |
|---|---|
| `ypi` | Launcher — sets up env, starts Pi as a recursive agent |
| `rlm_query` | The recursive sub-call function (Pi's `llm_query()`) |
| `SYSTEM_PROMPT.md` | Teaches the LLM to be recursive + edit code |
| `pi-mono/` | Git submodule — upstream [Pi coding agent](https://github.com/badlogic/pi-mono) |
| `tests/` | 54 tests: unit (mock pi), guardrails, e2e (real LLM) |
| `AGENTS.md` | Instructions for the agent (read by ypi itself) |
| `ARCHITECTURE.md` | Technical deep-dive, bugs found, design decisions |

## Testing

```bash
make test-fast    # 54 tests, no LLM calls, seconds
make test-e2e     # Real LLM calls, costs ~$0.05
make test         # Both
```

## Background

ypi went through four approaches before landing on the current design:

1. **Tool-use REPL** (exp 010/012) — Pi's `completeWithTools()`, ReAct loop. 77.6% on LongMemEval.
2. **Python bridge** (`rlm_bridge/`) — HTTP server between Pi and Python RLM. Too complex.
3. **Pi extension** (`extension.ts`) — Custom provider with search tools. Not true recursion.
4. **Bash RLM** (`rlm_query` + `SYSTEM_PROMPT.md`) — True recursion via bash. **Current approach.**

The key insight: Pi's bash tool **is** the REPL. `rlm_query` **is** `llm_query()`. No bridge needed.

## See Also

- [Pi coding agent](https://github.com/badlogic/pi-mono) — the underlying agent
- [Recursive Language Models](https://github.com/SuperAGI/recursive-lm) — the paper/code that inspired this
- [rlm-cli](https://github.com/rawwerks/rlm-cli) — our Python RLM CLI (budget, timeout, model routing)
- [DSPy](https://github.com/rawwerks/dspy) — our fork with `dspy.CLI` for optimizable CLI agents

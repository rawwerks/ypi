# ypi

**ypi** — a recursive coding agent built on [Pi](https://github.com/badlogic/pi-mono).

Named after the [Y combinator](https://en.wikipedia.org/wiki/Fixed-point_combinator#Y_combinator) from lambda calculus — the fixed-point combinator that enables recursion. `ypi` is Pi that can call itself. (`rpi` already has another connotation.)

Inspired by [Recursive Language Models](https://github.com/alexzhang13/rlm) (RLM), which showed that an LLM with a code REPL and a `llm_query()` function can recursively decompose problems, analyze massive contexts, and write code — all through self-delegation.

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

---

## Using ypi

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/rawwerks/ypi/master/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/rawwerks/ypi.git
cd ypi
git submodule update --init --depth 1  # pulls pi-mono
export PATH="$PWD:$PATH"
```

### Run

```bash
# Interactive
ypi

# One-shot
ypi "Refactor the error handling in this repo"

# Different model
ypi --provider anthropic --model claude-sonnet-4-5-20250929 "What does this codebase do?"
```

### How It Works

**Three pieces** (same architecture as Python RLM):

| Piece | Python RLM | ypi |
|---|---|---|
| System prompt | `RLM_SYSTEM_PROMPT` | `SYSTEM_PROMPT.md` |
| Context / REPL | Python `context` variable | `$CONTEXT` file + bash |
| Sub-call function | `llm_query("prompt")` | `rlm_query "prompt"` |

**Recursion:** `rlm_query` spawns a child Pi process with the same system prompt and tools. The child can call `rlm_query` too:

```
Depth 0 (root)    → full Pi with bash + rlm_query
  Depth 1 (child) → full Pi with bash + rlm_query, own jj workspace
    Depth 2 (leaf) → plain LM call, no tools (RLM_MAX_DEPTH reached)
```

**File isolation with jj:** Each recursive child gets its own [jj workspace](https://martinvonz.github.io/jj/latest/working-copy/). The parent's working copy is untouched. Review child work with `jj diff -r <change-id>`, absorb with `jj squash --from <change-id>`.

### Guardrails

| Feature | Env var | What it does |
|---------|---------|-------------|
| Timeout | `RLM_TIMEOUT=60` | Wall-clock limit for entire recursive tree |
| Call limit | `RLM_MAX_CALLS=20` | Max total `rlm_query` invocations |
| Model routing | `RLM_CHILD_MODEL=haiku` | Use cheaper model for sub-calls |
| Depth limit | `RLM_MAX_DEPTH=3` | How deep recursion can go |
| jj disable | `RLM_JJ=0` | Skip workspace isolation |
| Tracing | `PI_TRACE_FILE=/tmp/trace.log` | Log all calls with timing |

---

## Contributing

### Project Structure

```
ypi/
├── ypi                    # Launcher: sets up env, starts Pi as recursive agent
├── rlm_query              # The recursive sub-call function (Pi's analog of rlm llm_query())
├── SYSTEM_PROMPT.md       # Teaches the LLM to be recursive + edit code
├── AGENTS.md              # Meta-instructions for the agent (read by ypi itself)
├── Makefile               # test targets
├── tests/
│   ├── test_unit.sh       # Mock pi, test bash logic (no LLM, fast)
│   ├── test_guardrails.sh # Test guardrails (no LLM, fast)
│   └── test_e2e.sh        # Real LLM calls (slow, costs ~$0.05)
├── pi-mono/               # Git submodule: upstream Pi coding agent
└── README.md
```

### Version Control

This repo uses **[jj](https://martinvonz.github.io/jj/)** for version control. Git is only for GitHub sync.

```bash
jj status                    # What's changed
jj describe -m "message"     # Describe current change
jj new                       # Start a new change
jj bookmark set master       # Point master at current change
jj git push                  # Push to GitHub
```

**Never use `git add/commit/push` directly.** jj manages git under the hood.

### Testing

```bash
make test-fast    # 54 tests, no LLM calls, seconds
make test-e2e     # Real LLM calls, costs ~$0.05
make test         # Both
```

**Before any change to `rlm_query`:** run `make test-fast`. After: run it again. `rlm_query` is a live dependency of the agent's own execution — breaking it breaks the agent.


### History

ypi went through four approaches before landing on the current design:

1. **Tool-use REPL** (exp 010/012) — Pi's `completeWithTools()`, ReAct loop. 77.6% on LongMemEval.
2. **Python bridge** — HTTP server between Pi and Python RLM. Too complex.
3. **Pi extension** — Custom provider with search tools. Not true recursion.
4. **Bash RLM** (`rlm_query` + `SYSTEM_PROMPT.md`) — True recursion via bash. **Current approach.**

The key insight: Pi's bash tool **is** the REPL. `rlm_query` **is** `llm_query()`. No bridge needed.

---

## See Also

- [Pi coding agent](https://github.com/badlogic/pi-mono) — the underlying agent
- [Recursive Language Models](https://github.com/alexzhang13/rlm) — the library that inspired this
- [rlm-cli](https://github.com/rawwerks/rlm-cli) — Python RLM CLI (budget, timeout, model routing)

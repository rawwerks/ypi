# pi-rlm-extension

True Recursive Language Model for [Pi Coding Agent](https://github.com/badlogic/pi-mono). A faithful port of [Python RLM](https://github.com/SuperAGI/recursive-lm) to Pi's bash environment.

## How It Works

Pi already has a bash REPL as a tool. We add one function — `rlm_query` — and a system prompt that teaches Pi to use it recursively. That's the whole trick.

```
┌─────────────────────────────────────┐
│  Pi (depth 0)                       │
│  System prompt: SYSTEM_PROMPT.md    │
│  Context: $CONTEXT (file on disk)   │
│  Tools: bash (grep, sed, cat...)    │
│                                     │
│  Model runs:                        │
│    grep -n "award" "$CONTEXT"       │
│    sed -n '150,175p' "$CONTEXT" \   │
│      | rlm_query "What award?"      │
│            │                        │
│            ▼                        │
│    ┌───────────────────────┐        │
│    │  Pi (depth 1)         │        │
│    │  Same system prompt   │        │
│    │  Context: piped chunk │        │
│    │  Returns: "Turing"    │        │
│    └───────────────────────┘        │
│                                     │
│  Model says: "ACM Turing Award"     │
└─────────────────────────────────────┘
```

### The Three Pieces (same as Python RLM)

| Piece | Python RLM | Pi RLM |
|---|---|---|
| System prompt | `RLM_SYSTEM_PROMPT` in code | `SYSTEM_PROMPT.md` file |
| Context | `context` Python variable | `$CONTEXT` file on disk |
| Sub-call function | `llm_query("prompt")` | `rlm_query "prompt"` |

## Quick Start

```bash
# 1. Set up environment
export CONTEXT="/path/to/your/context.txt"
export RLM_SYSTEM_PROMPT="$PWD/SYSTEM_PROMPT.md"
export RLM_PROVIDER=anthropic
export RLM_MODEL=claude-sonnet-4-5-20250929
export RLM_MAX_DEPTH=3
export PATH="$PWD:$PATH"  # So rlm_query is on PATH

# 2. Ask a question
rlm_query "What university did the user graduate from?"

# 3. Or pipe a chunk for targeted analysis
sed -n '100,200p' "$CONTEXT" | rlm_query "Who is the author?"
```

## Files

| File | What |
|---|---|
| `rlm_query` | The recursive bash helper — Pi's `llm_query()` |
| `SYSTEM_PROMPT.md` | Teaches Pi how to be an RLM |
| `ARCHITECTURE.md` | Deep technical notes, bugs found, design decisions |
| `extension.ts` | Earlier approach: Pi extension with tool-use (Approach 3) |
| `rlm_bridge/` | Earlier approach: Python bridge server (Approach 2) |

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CONTEXT` | Path to context file on disk | (required) |
| `RLM_SYSTEM_PROMPT` | Path to `SYSTEM_PROMPT.md` | (required) |
| `RLM_PROVIDER` | LLM provider | `cerebras` |
| `RLM_MODEL` | LLM model ID | `gpt-oss-120b` |
| `RLM_MAX_DEPTH` | Max recursion depth | `3` |
| `PI_TRACE_FILE` | Trace log path (optional) | (none) |

## For LongMemEval

See `longmemeval-rlm/experiments/013_pi_recursive_bash/` for the experiment runner that wraps `rlm_query` with concurrency, tracing, and scoring.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical breakdown, including:
- Mapping from Python RLM to Pi/bash
- The three critical bugs and their fixes
- Stdin detection in subprocess contexts
- System prompt design philosophy

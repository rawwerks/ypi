# Pi RLM Architecture — True Recursive Language Model for Pi Coding Agent

## The Three Pieces of RLM

Every RLM implementation has exactly three components. Getting these right
is the entire game.

### 1. System Prompt (`RLM_SYSTEM_PROMPT`)

**What**: Large, static instructions that teach the model HOW to be an RLM.
Explains the REPL, the recursive sub-call function, chunking strategies.

**Python RLM**: `rlm/utils/prompts.py:RLM_SYSTEM_PROMPT` (~2500 words),
sent as `{"role": "system"}` message.

**Pi RLM**: `SYSTEM_PROMPT.md` file, passed via `--system-prompt <filepath>`.
Pi's `resolvePromptInput()` detects file paths and reads them automatically
(see `resource-loader.js:13-27`). **Never `cat` the file into a shell arg.**

### 2. Context (the data being analyzed)

**What**: The huge document/conversation/dataset that the model queries.
This is NOT injected into the prompt. It is a VARIABLE the model accesses
through code.

**Python RLM**: `context` variable in the Python REPL. Model writes
`print(context[:500])` or `len(context)` to access it.

**Pi RLM**: `$CONTEXT` environment variable pointing to a file on disk.
Model accesses via bash: `cat "$CONTEXT"`, `grep -n "keyword" "$CONTEXT"`,
`wc -l "$CONTEXT"`, etc.

### 3. User Query (the question)

**What**: The actual question to answer. Short, specific.

**Python RLM**: Built by `build_user_prompt()` as `{"role": "user"}` message.

**Pi RLM**: Passed as the positional argument to `pi -p ... "the question"`.

## Mapping Python RLM to Pi/Bash

| Python RLM | Pi/Bash Equivalent | Notes |
|---|---|---|
| `context` variable in REPL | `$CONTEXT` file on disk | Accessed via `cat`, `grep`, `sed` |
| `llm_query("prompt")` | `rlm_query "prompt"` | Spawns child Pi with same system prompt |
| `llm_query(f"...: {chunk}")` | `echo "$chunk" \| rlm_query "..."` | Piped text → child's context |
| `llm_query_batched([...])` | Sequential `rlm_query` calls | No native batching in bash |
| `FINAL("answer")` | Just print the answer | Pi `-p` returns stdout |
| ````repl``` blocks | Pi's bash tool | Already native |
| `print()` → truncated output | Bash stdout → truncated by Pi | Same principle |

## How `rlm_query` Works

`rlm_query` is a bash script that spawns a child Pi process. It is the
Pi/bash equivalent of Python RLM's `llm_query()`.

### Recursion Depth

```
Depth 0 (root)     → rlm_query spawns...
  Depth 1 (child)  → full Pi with bash + system prompt, can call rlm_query
    Depth 2 (leaf) → pi -p --no-tools, just reads context and answers
```

`RLM_MAX_DEPTH` controls when to stop (default: 3).

### Context Flow

Two calling patterns:

```bash
# Pattern 1: PIPE — piped text becomes the child's $CONTEXT
sed -n '100,200p' "$CONTEXT" | rlm_query "Summarize this section"

# Pattern 2: INHERIT — child gets a copy of parent's $CONTEXT
rlm_query "Search for all mentions of 'graduation'"
```

### Leaf Node Behavior

At `MAX_DEPTH`, `rlm_query` falls back to a plain LM call:
- `--no-tools` (no bash, no recursion)
- Context injected directly into the prompt text
- Model just reads and answers

## Critical Implementation Details

### Bug #1: Stdin Detection (`[ -p /dev/stdin ]` not `[ ! -t 0 ]`)

**The problem**: When `rlm_query` runs as a subprocess (e.g., from Pi's
bash tool), stdin is NOT a terminal even when nothing is piped. The classic
`[ -t 0 ]` test returns false in both cases, so the script always takes
the "piped input" branch and reads stdin — which is empty.

**The fix**: Use `[ -p /dev/stdin ]` which checks if stdin is specifically
a pipe (FIFO). This correctly distinguishes "someone piped data to me"
from "I'm in a subprocess with stdin connected to something else."

```bash
# WRONG — fails in subprocess contexts
if [ ! -t 0 ]; then
    cat > "$CHILD_CONTEXT"  # Reads empty stdin, context file is empty!
fi

# CORRECT — detects actual pipe
if [ -p /dev/stdin ]; then
    cat > "$CHILD_CONTEXT"  # Only reads when data was actually piped
fi
```

**This was the hardest bug to find.** The symptom was "context is empty"
and it was misdiagnosed multiple times as:
- Shell escaping issues with the system prompt
- `ARG_MAX` limits
- `exec` firing EXIT traps
- Environment variables not propagating
- Pi's bash tool not inheriting env vars

All of those were red herrings. The root cause was always the stdin
detection: `[ ! -t 0 ]` returning true in non-terminal subprocess
contexts even when no data was piped.

### Bug #2: System Prompt as File Path

**The problem**: The original script did:
```bash
SYSTEM_PROMPT_TEXT=$(cat "$SYSTEM_PROMPT_FILE")
CMD_ARGS+=(--system-prompt "$SYSTEM_PROMPT_TEXT")
```

This reads a 139-line markdown file with code blocks, backticks, quotes,
and newlines into a shell variable, then passes it as a command-line arg.
This causes shell escaping nightmares and potential `ARG_MAX` issues.

**The fix**: Pi's `resolvePromptInput()` (in `resource-loader.js`)
checks `existsSync(input)` — if the value is a valid file path, it reads
the file. So just pass the path:

```bash
CMD_ARGS+=(--system-prompt "$SYSTEM_PROMPT_FILE")
```

### Bug #3: System Prompt Too Aggressive About Recursion

**The problem**: The original system prompt said:
> "NEVER try to read the entire context file"
> "DELEGATE reading to an rlm_query sub-call"

This made the model call `rlm_query` even for tiny 11-line contexts,
creating recursive chains that hung or produced empty results.

**The fix**: Faithful to Python RLM's prompt which says:
> "Check the content of the context variable to understand what you're
> working with"
> "Sub LLMs can fit around 500K characters"

The model should check context size first, read directly if small,
and only delegate for large contexts. The new system prompt includes
an explicit "short context, direct approach" example.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CONTEXT` | Path to the context file on disk | (required) |
| `RLM_DEPTH` | Current recursion depth | `0` |
| `RLM_MAX_DEPTH` | Maximum recursion depth | `3` |
| `RLM_PROVIDER` | LLM provider name | `cerebras` |
| `RLM_MODEL` | LLM model ID | `gpt-oss-120b` |
| `RLM_SYSTEM_PROMPT` | Path to the system prompt file | (required) |
| `PI_TRACE_FILE` | Path to trace log (optional) | (none) |

## File Layout

```
pi-rlm-extension/
├── rlm_query              # The recursive bash helper (chmod +x)
├── SYSTEM_PROMPT.md       # RLM system prompt for Pi
├── ARCHITECTURE.md        # This file
├── extension.ts           # Approach 3: Pi extension with tool-use REPL
├── rlm_bridge/            # Approach 2: Python bridge (deprecated)
│   └── server.py
├── package.json
└── tsconfig.json
```

## Approaches History

1. **Approach 1** (exp 010/012): Used Pi's `completeWithTools()` — a ReAct
   tool-use loop, NOT true recursion. Achieved 77.6% on LongMemEval.

2. **Approach 2** (`rlm_bridge/`): Python bridge server between Pi and
   Python RLM. Too complex, fragile.

3. **Approach 3** (`extension.ts`): Pi extension registering an "rlm"
   provider with search/session tools. Works but not true recursion.

4. **Approach 4** (`rlm_query` + `SYSTEM_PROMPT.md`): TRUE RLM via bash.
   Faithful port of Python RLM's architecture. Pi's bash tool IS the REPL,
   `rlm_query` IS `llm_query()`, `$CONTEXT` IS the context variable.
   **This is the current approach.**

## Running the Smoke Test

```bash
# Create a test context
cat > /tmp/test_context.txt << 'EOF'
=== Session 1 (2024-01-15) ===
User mentioned they graduated from MIT with a CS degree in 2019.
EOF

# Set up environment
export CONTEXT="/tmp/test_context.txt"
export RLM_DEPTH=0
export RLM_MAX_DEPTH=3
export RLM_PROVIDER=anthropic
export RLM_MODEL=claude-sonnet-4-5-20250929
export RLM_SYSTEM_PROMPT="/path/to/pi-rlm-extension/SYSTEM_PROMPT.md"
export PI_TRACE_FILE="/tmp/rlm_trace.log"
export PATH="/path/to/pi-rlm-extension:$PATH"

# Test: no pipe (inherit context)
rlm_query "What university did the user graduate from?"
# Expected: MIT

# Test: with pipe (chunk becomes context)
echo "The user loves Rust" | rlm_query "What language? Just the name."
# Expected: Rust

# Check trace
cat "$PI_TRACE_FILE"
# Expected: depth=0→1 entries, possibly depth=1→2 for sub-calls
```

## Node Symlink Requirement

Pi's shebang is `#!/usr/bin/env node` but this machine has `bun` not
`node`. A symlink is needed:

```bash
ln -s ~/.bun/bin/bun ~/.bun/bin/node
```

Without this, `exec pi` in rlm_query fails with "env: 'node': No such
file or directory".

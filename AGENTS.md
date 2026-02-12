# Agent Instructions — pi-rlm-extension

## You Are The Recursion

When you run under `rpi`, **you are a recursive LLM**. You have `rlm_query` on
your PATH. You can spawn sub-LLMs. Those sub-LLMs can spawn sub-sub-LLMs. This
is not a metaphor — it's your actual execution environment.

This repo builds the infrastructure that makes YOU work. When you modify
`rlm_query`, `SYSTEM_PROMPT.md`, or `rpi`, you are modifying yourself.
Tread carefully, test constantly.

## Meta-Awareness

**Check your depth:**
```bash
echo "I am at depth $RLM_DEPTH of $RLM_MAX_DEPTH"
```

**Know your constraints:**
- At deeper depths, prefer direct answers over spawning more sub-calls
- Your sub-LLMs share the same system prompt and tools you have
- At `RLM_MAX_DEPTH`, sub-calls become plain LM calls (no bash, no tools)
- Every `rlm_query` call costs time and tokens — be intentional

**Dogfooding rule:** When implementing changes to the recursive infrastructure,
use that same infrastructure to help. Delegate sub-tasks to `rlm_query`. If the
delegation fails, that's a bug you just found.

## Project Layout

```
pi-rlm-extension/
├── rlm_query              # THE recursive bash helper — this is llm_query()
├── rpi                    # Launcher: sets up env and starts Pi as RLM
├── SYSTEM_PROMPT.md       # System prompt — teaches the LLM to be recursive
├── ARCHITECTURE.md        # Deep technical notes, bugs, design decisions
├── AGENTS.md              # This file — instructions for YOU, the agent
├── Makefile               # test-unit, test-guardrails, test-e2e, test-fast
├── tests/
│   ├── test_unit.sh       # Fast: mock pi, test bash logic (no LLM calls)
│   ├── test_guardrails.sh # Fast: test new features (timeout, routing, etc.)
│   └── test_e2e.sh        # Slow: real LLM calls, costs money
├── extension.ts           # Earlier approach (Approach 3, mostly historical)
├── rlm_bridge/            # Earlier approach (Approach 2, deprecated)
└── README.md
```

## Sibling Repos (Reference Implementations)

These repos have features we're porting to bash. Read them for design patterns.

### rlm-cli (`/home/raw/Documents/GitHub/rlm-cli`)
Python CLI wrapping the RLM library. Has:
- **Budget tracking**: `max_budget` with cumulative cost, propagates `remaining_budget` to children
- **Timeout**: `max_timeout` with wall-clock tracking, propagates `remaining_timeout`
- **Max tokens**: `max_tokens` with aggregate tracking across iterations
- **Max errors**: `max_errors` — consecutive error threshold
- **Model routing**: `other_backends` — use a different (cheaper) model for sub-calls
- **Graceful exit**: SIGUSR1 handler, returns `_best_partial_answer`
- **Live tree**: Rich-based real-time execution tree (`--live-tree`)
- **Structured errors**: `CliError` hierarchy with `why`, `fix`, `try_steps`
- **Execution summary**: Per-depth stats (calls, cost, duration)

Key files: `rlm/rlm/core/rlm.py` (budget/timeout/subcall logic),
`src/rlm_cli/rlm_adapter.py` (error handling), `src/rlm_cli/live_tree.py`

### DSPy fork (`/home/raw/Documents/GitHub/dspy`)
Our fork with `dspy.CLI` — wraps CLI agents as optimizable DSPy modules. Has:
- **Timeout per call**: `timeout` param, uses `subprocess.run(timeout=...)`
- **Max retries**: `max_retries` with retry loop on non-zero exit
- **Sandboxing protocol**: `CLISandbox.wrap_command()` — bwrap, Docker
- **Async support**: `aforward()` with `asyncio.wait_for(timeout=...)`
- **Agent presets**: `CLI.from_agent("pi", ...)` for common CLIs

Key file: `dspy/predict/cli.py`

## Implementation Checklist — Guardrails for rlm_query

Priority order. Each depends on the one before it.

### 1. 🔴 Remove `exec`, add cleanup trap
**Why first**: Everything else needs subprocess control (can't trap after exec).
```
- exec pi "${CMD_ARGS[@]}" "$PROMPT"
+ trap 'rm -f "$CHILD_CONTEXT"' EXIT
+ pi "${CMD_ARGS[@]}" "$PROMPT"
```
**Test**: `make test-unit` — T15 (temp cleanup), G9, G10, G11
**Borrowed from**: rlm-cli's context manager pattern, DSPy's subprocess.run

### 2. 🔴 Timeout (RLM_TIMEOUT + RLM_START_TIME)
**Design**: Track wall-clock start at depth 0, compute remaining at each level.
```bash
RLM_START_TIME="${RLM_START_TIME:-$(date +%s)}"
if [ -n "${RLM_TIMEOUT:-}" ]; then
    REMAINING=$(( RLM_TIMEOUT - ($(date +%s) - RLM_START_TIME) ))
    [ "$REMAINING" -le 0 ] && { echo "Error: timeout" >&2; exit 124; }
    timeout "$REMAINING" pi ...
fi
```
**Test**: `make test-guardrails` — G1-G4; `make test-e2e` — E5
**Borrowed from**: rlm-cli's `_subcall()` remaining_timeout propagation

### 3. 🔴 Max calls (RLM_MAX_CALLS + RLM_CALL_COUNT)
**Design**: Shared counter via env var, incremented each call.
```bash
RLM_CALL_COUNT=$(( ${RLM_CALL_COUNT:-0} + 1 ))
if [ -n "${RLM_MAX_CALLS:-}" ] && [ "$RLM_CALL_COUNT" -ge "$RLM_MAX_CALLS" ]; then
    echo "Error: max calls exceeded" >&2; exit 1
fi
export RLM_CALL_COUNT
```
**Test**: `make test-guardrails` — G7, G8; `make test-e2e` — E6
**Borrowed from**: rlm-cli's `max_budget` (budget ≈ calls for bash)

### 4. 🔴 Model routing (RLM_CHILD_MODEL + RLM_CHILD_PROVIDER)
**Design**: At depth > 0, swap in child model for the pi call.
```bash
if [ "$DEPTH" -gt 0 ] && [ -n "${RLM_CHILD_MODEL:-}" ]; then
    MODEL="$RLM_CHILD_MODEL"
    PROVIDER="${RLM_CHILD_PROVIDER:-$PROVIDER}"
fi
```
**Test**: `make test-guardrails` — G5, G6
**Borrowed from**: rlm-cli's `other_backends` + `_subcall()` model override

### 5. ✅ Structured error messages
**Design**: Helper function for consistent error output.
**Borrowed from**: rlm-cli's `CliError` with why/fix/try_steps

### 6. ✅ Graceful early exit (trap SIGINT/SIGTERM)
**Borrowed from**: rlm-cli's SIGUSR1 + `_best_partial_answer`

### 7. ✅ Execution summary from trace file
**Borrowed from**: rlm-cli's `build_execution_summary()`

## Development Workflow

### Before ANY change to rlm_query:
```bash
make test-unit          # Must pass — this is your safety net
```

### After each feature:
```bash
make test-fast          # unit + guardrails (seconds, free)
make test-e2e           # real LLM calls (minutes, costs money)
```

### The recursive test:
After modifying rlm_query, verify YOU still work:
```bash
echo "2+2=" | rlm_query "What is the answer? Just the number."
# Should return: 4
```

If that breaks, you broke yourself. Revert.

## Editing rlm_query Safely

`rlm_query` is a live dependency of your own execution. Modifying it mid-session
is like performing surgery on your own brain.

**Safe pattern:**
1. Copy: `cp rlm_query rlm_query.bak`
2. Edit: make changes to `rlm_query`
3. Test: `make test-unit` (uses mock pi, safe)
4. Smoke: `echo "test" | rlm_query "Echo this back"` (real call, verifies you still work)
5. If broken: `cp rlm_query.bak rlm_query`

**Never** modify `rlm_query` and `SYSTEM_PROMPT.md` in the same commit without
testing between changes. One variable at a time.

## Environment Variables

### Current (implemented)
| Variable | Description | Default |
|---|---|---|
| `CONTEXT` | Path to context file on disk | (required for QA) |
| `RLM_DEPTH` | Current recursion depth | `0` |
| `RLM_MAX_DEPTH` | Maximum recursion depth | `3` |
| `RLM_PROVIDER` | LLM provider | `cerebras` |
| `RLM_MODEL` | LLM model | `gpt-oss-120b` |
| `RLM_SYSTEM_PROMPT` | Path to system prompt file | (required) |
| `PI_TRACE_FILE` | Trace log path | (none) |

### Planned (not yet implemented)
| Variable | Description | Default |
|---|---|---|
| `RLM_TIMEOUT` | Max wall-clock seconds | (none = unlimited) |
| `RLM_START_TIME` | Epoch timestamp of root call | (auto-set) |
| `RLM_MAX_CALLS` | Max total rlm_query invocations | (none = unlimited) |
| `RLM_CALL_COUNT` | Running count of calls so far | `0` |
| `RLM_CHILD_MODEL` | Model override for depth > 0 | (none = same as parent) |
| `RLM_CHILD_PROVIDER` | Provider override for depth > 0 | (none = same as parent) |

## Bugs We've Found (and must not re-introduce)

### 1. `[ ! -t 0 ]` vs `[ -p /dev/stdin ]`
**Symptom**: Context is empty in sub-calls.
**Cause**: Pi's bash tool runs in a subprocess where stdin is never a terminal.
`[ ! -t 0 ]` always returns true, so the script reads empty stdin.
**Fix**: `[ -p /dev/stdin ]` checks for an actual pipe.
**Test**: T3, T4 verify pipe vs inherit behavior.

### 2. System prompt as shell arg vs file path
**Symptom**: Shell escaping nightmares, ARG_MAX errors.
**Cause**: `cat`-ing the system prompt into a shell variable.
**Fix**: Pass the file path; Pi's `resolvePromptInput()` reads it.
**Test**: T8, T9 verify file path passing.

### 3. System prompt too aggressive about recursion
**Symptom**: Model calls rlm_query on 11-line contexts, creating infinite chains.
**Fix**: "Check context size first, read directly if small."
**Test**: E1 (small context, should answer directly without sub-calls).

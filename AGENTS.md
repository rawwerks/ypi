# Agent Instructions — ypi

## Landing

When the user says **"land it"** or **"land the plane"**, run:

```bash
rp ypi .prose/land.prose
```

This runs all tests (fast + e2e), smoke tests `rlm_query`, encrypts private files, pushes to GitHub via jj, and writes a handoff summary. Monitor progress with `rlm_sessions read --last | tail -30`.

## Version Control: Use jj, not git

This repo uses **jj** (Jujutsu) for version control. Git is only for GitHub sync.

```bash
# Working with changes
jj status                    # What's changed
jj diff                      # See the diff
jj describe -m "message"     # Describe current change
jj new                       # Start a new change on top

# Pushing to GitHub
jj bookmark set master       # Point master at current change
jj git push                  # Push to GitHub

# Reviewing sub-agent work
jj log                       # See all changes including sub-agent workspaces
jj diff -r <change-id>       # Review a sub-agent's edits
jj squash --from <change-id> # Absorb a sub-agent's work into yours
jj abandon <change-id>       # Discard a sub-agent's work
```

**Never use `git add`, `git commit`, or `git push` directly.** jj manages git
under the hood. Using git directly creates confusion and potential conflicts.

Sub-agents get their own jj workspaces automatically (via `rlm_query`). Their
edits appear as separate changes in `jj log` that you can review and absorb.

## You Are The Recursion

When you run under `ypi`, **you are a recursive LLM**. You have `rlm_query` on
your PATH. You can spawn sub-LLMs. Those sub-LLMs can spawn sub-sub-LLMs. This
is not a metaphor — it's your actual execution environment.

This repo builds the infrastructure that makes YOU work. When you modify
`rlm_query`, `SYSTEM_PROMPT.md`, or `ypi`, you are modifying yourself.
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

## Architectural Invariants

Three properties make ypi work. All are tested (E7, E8 in test_e2e.sh):

1. **Self-similarity** — Same prompt, same tools, same agent at every depth. No specialized roles. The intelligence is in decomposition, not specialization.
2. **Self-hosting** — SYSTEM_PROMPT.md (SECTION 6) contains the full source of `rlm_query`. The agent reads its own recursion machinery. When it modifies `rlm_query`, it's modifying itself.
3. **Bounded recursion** — 5 guardrails (depth, PATH scrubbing, call count, budget, timeout) guarantee termination. The system prompt adds *cognitive* pressure: deeper agents prefer direct action.
4. **Symbolic access** — Anything the agent needs to manipulate precisely is a file, not just tokens in context. `$CONTEXT` for data, `$RLM_PROMPT_FILE` for the original prompt, hashline for edits. Agents grep/sed/cat instead of copying tokens from memory. (T14d)

**Don't write static architecture docs.** Encode claims as tests. If a property matters, there should be an E2E test that breaks when it stops being true.

## Project Layout
```
ypi/
├── ypi                    # Launcher: sets up env and starts Pi as RLM
├── rlm_query              # THE recursive bash helper — this is llm_query()
├── SYSTEM_PROMPT.md       # System prompt — teaches the LLM to be recursive
├── AGENTS.md              # This file — instructions for YOU, the agent
├── Makefile               # test-unit, test-guardrails, test-extensions, test-e2e
├── extensions/
│   └── ypi.ts             # Status bar extension — "ypi ∞ depth 0/3"
├── tests/
│   ├── test_unit.sh       # Fast: mock pi, test bash logic (no LLM calls)
│   ├── test_guardrails.sh # Fast: test new features (timeout, routing, etc.)
│   ├── test_extensions.sh # Fast: verify extensions load with installed pi
│   └── test_e2e.sh        # Slow: real LLM calls, costs money
├── scripts/
│   ├── check-upstream     # Test ypi against latest pi release
│   ├── encrypt-prose      # Encrypt .prose/runs/ and .prose/agents/ before push
│   └── decrypt-prose      # Decrypt after clone/pull (symlink to encrypt-prose)
├── .prose/
│   ├── *.prose            # OpenProse programs (public, committed plaintext)
│   ├── runs/              # Execution state (private, encrypted before push)
│   └── agents/            # Persistent agent memory (private, encrypted before push)
├── .pi-version            # Last known-good pi version
├── .sops.yaml             # Age encryption rules
├── .githooks/pre-commit   # Safety net for direct git usage
├── .github/workflows/     # CI + upstream compat checks
├── contrib/extensions/    # Extensions not loaded by default (hashline, etc.)
├── experiments/           # Self-experiments (private, encrypted before push)
├── private/               # Sops-encrypted notes (private, encrypted before push)
├── pi-mono/               # Git submodule: upstream Pi coding agent (reference)
└── README.md
```

## Sibling Repos (Reference Implementations)

These repos have features we've ported to bash. Read them for design patterns.

### rlm-cli (`/home/raw/Documents/GitHub/rlm-cli`)
Python CLI wrapping the RLM library. Has:
- **Budget tracking**: `max_budget` with cumulative cost, propagates `remaining_budget` to children
- **Timeout**: `max_timeout` with wall-clock tracking, propagates `remaining_timeout`
- **Max tokens**: `max_tokens` with aggregate tracking across iterations
- **Max errors**: `max_errors` — consecutive error threshold
- **Model routing**: `other_backends` — use a different (cheaper) model for sub-calls
- **Graceful exit**: SIGUSR1 handler, returns `_best_partial_answer`
- **Structured errors**: `CliError` hierarchy with `why`, `fix`, `try_steps`
- **Execution summary**: Per-depth stats (calls, cost, duration)

Key files: `rlm/rlm/core/rlm.py` (budget/timeout/subcall logic),
`src/rlm_cli/rlm_adapter.py` (error handling), `src/rlm_cli/live_tree.py`

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

### Running experiments and evals
**NEVER block the main conversation waiting for a script to finish.**
- Launch long-running work in tmux: `tmux send-keys -t eval:name 'command' Enter`
- Check progress with `tmux capture-pane -t eval:name -p | tail -5` (no sleep)
- Use `uv run` for Python scripts that need dependencies
- If you need to confirm a background process started, `sleep 2` max, then check once
- Do NOT `sleep 30` or `sleep 60` — that blocks the user
- Run A/B conditions **concurrently** in separate tmux windows, not sequentially

### Self-experimentation
You are ypi. When you're unsure whether a feature helps or hurts, **test it on yourself.** Write a small A/B experiment in `experiments/`, run both conditions with `rlm_query`, and measure. Negative results are results — don't keep features out of sunk-cost loyalty. See `.prose/self-experiment.prose` for the workflow.

### Reading session history
Use `rlm_sessions` to inspect what you or other agents have done:
```bash
rlm_sessions                     # List all sessions for this project
rlm_sessions --trace             # List only sessions from current recursive tree
rlm_sessions read --last         # Read most recent session transcript
rlm_sessions read <filename>     # Read a specific session
rlm_sessions grep "pattern"      # Search across all sessions
rlm_sessions grep -t "pattern"   # Search only current trace
```

Common patterns:
```bash
# What is a background ypi doing right now?
rlm_sessions read --last | tail -20

# What did a sub-agent find?
rlm_sessions --trace
rlm_sessions read <trace-file> | tail -20

# Did any previous agent work on X?
rlm_sessions grep "feature-name"
```

Set `RLM_SHARED_SESSIONS=0` to disable session sharing (full isolation).

### Starting a feature branch:
```bash
jj new -m "feat: description of the feature"
jj bookmark create feature-name   # optional, for pushing to GitHub
# ... do work ...
jj describe -m "feat: final description"
jj bookmark set master             # when ready to land
jj git push
```

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

| Variable | Description | Default |
|---|---|---|
| `CONTEXT` | Path to context file on disk | (required for QA) |
| `RLM_DEPTH` | Current recursion depth | `0` |
| `RLM_MAX_DEPTH` | Maximum recursion depth | `3` |
| `RLM_PROVIDER` | LLM provider for sub-calls | Pi's default |
| `RLM_MODEL` | LLM model for sub-calls | Pi's default |
| `RLM_SYSTEM_PROMPT` | Path to system prompt file | (required) |
| `PI_TRACE_FILE` | Trace log path | (none) |
| `RLM_TIMEOUT` | Max wall-clock seconds | (none = unlimited) |
| `RLM_START_TIME` | Epoch timestamp of root call | (auto-set) |
| `RLM_MAX_CALLS` | Max total rlm_query invocations | (none = unlimited) |
| `RLM_CALL_COUNT` | Running count of calls so far | `0` |
| `RLM_CHILD_MODEL` | Model override for depth > 0 | (none = same as parent) |
| `RLM_CHILD_PROVIDER` | Provider override for depth > 0 | (none = same as parent) |
| `RLM_JJ` | Enable jj workspace isolation | `1` (set `0` to disable) |
| `RLM_SHARED_SESSIONS` | Allow agents to read sibling/parent session logs | `1` (set `0` to disable) |

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

### Secrets & Encryption
Files in `private/`, `experiments/`, `.prose/runs/`, and `.prose/agents/` are encrypted with
[sops](https://github.com/getsops/sops) + [age](https://github.com/FiloSottile/age)
before push. They live **plaintext on disk** so agents and editors can read them.

```bash
# Before pushing (MANDATORY)
scripts/encrypt-prose
jj git push

# After cloning or pulling
scripts/decrypt-prose

# Check if anything needs encrypting
scripts/encrypt-prose --check
```

**Never push without encrypting first.** The `.githooks/pre-commit` blocks
unencrypted files if someone uses git directly, but jj bypasses git hooks.

### OpenProse Programs

`.prose/*.prose` files are public workflow programs committed in plaintext.
Execution state (`.prose/runs/`, `.prose/agents/`) is private — encrypt before push.

```bash
# Run a prose program
rp pi .prose/check-upstream.prose

# Or via the bash script directly
scripts/check-upstream
```

# Agent Instructions — ypi

## Running Prose Programs & Background Tasks
Launch long-running tasks in tmux with a sentinel file. The `notify-done` extension
watches `/tmp/ypi-signal-*` and **injects a message into your conversation** when
the task finishes — no sleeping, no polling, no `tmux capture-pane` loops.
**How it works:**
- Idle → `triggerTurn` fires immediately, you get a new turn
- Busy (mid-tool-execution) → message is **steered** in, delivered after the current tool finishes
- Either way, the notification appears in your message history and you respond to it
```bash
# Launch with sentinel (you'll be woken up when it finishes)
tmux send-keys -t eval:land "cd ~/Documents/GitHub/ypi && rp ypi .prose/land.prose; echo done > /tmp/ypi-signal-${YPI_INSTANCE_ID}-land" Enter
# That's it. Keep working on other things. You'll get a message like:
#   ⚡ Background task "land" completed: done
# ...and a new turn is triggered so you can respond to it.
```
**IMPORTANT: Do NOT poll or sleep-loop waiting for background tasks.**
Do not `sleep && tmux capture-pane` in a loop. Do not check progress unless
asked. Just keep working — the extension will interrupt you when it's ready.

**Sentinel naming:** `/tmp/ypi-signal-${YPI_INSTANCE_ID}-{name}` — always include
`$YPI_INSTANCE_ID` so the signal reaches THIS instance, not a sibling. The `{name}`
part appears in the notification. File contents become the notification body.
The file is deleted after consumption.
**Key programs:**
- `rp ypi .prose/land.prose` — "land it" / "land the plane": tests, push, handoff
- `rp ypi .prose/release.prose confirm_release='Approved.'` — cut an npm release
- `rp ypi .prose/check-upstream.prose` — verify Pi compatibility
- `rp ypi .prose/incorporate-insight.prose insight='...'` — propagate an insight across the repo

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

Three properties make ypi work. All are tested (E7, E8, E9 in test_e2e.sh):

1. **Self-similarity** — Same prompt, same tools, same agent at every depth. No specialized roles. The intelligence is in decomposition, not specialization.
2. **Self-hosting** — When the shell helper is enabled (`YPI_SHELL_HELPER=1`, set by the `ypi` wrapper), the system prompt's SECTION 6 is generated with the full source of `rlm_query`, so the agent can read its own recursion machinery — when it modifies `rlm_query`, it's modifying itself. A bare `pi -e` / native-tool install omits SECTION 6 and recurses through the native tool.
3. **Bounded recursion** — 5 guardrails (depth, PATH scrubbing, call count, budget, timeout) guarantee termination. The system prompt adds *cognitive* pressure: deeper agents prefer direct action.
4. **Symbolic access** — Anything the agent needs to manipulate precisely is a file, not just tokens in context. `$CONTEXT` for data, `$RLM_PROMPT_FILE` for the original prompt, hashline for edits. Agents grep/sed/cat instead of copying tokens from memory. (T14d)

**Don't write static architecture docs.** Encode claims as tests. If a property matters, there should be an E2E test that breaks when it stops being true.

## Troubleshooting — run this first

If recursion misbehaves or `ypi` "seems broken," run `make doctor` before anything else. The #1 cause is a wrong/stale host `pi` — the old `@mariozechner/pi-coding-agent` shadowing `@earendil-works/pi-coding-agent`, or a version below `.pi-version` — which fails silently with no clear signal. `make doctor` names the exact problem and the fix. (This guard exists because that failure cost a full debugging session; it must never be silent again.)

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
│   ├── pre-push-checks    # Shared local/CI test gate (fast + extensions)
│   ├── release-preflight  # One-command hooks + checks + upstream dry-run
│   ├── land               # Deterministic-ish landing helper
│   ├── ci-status          # Show recent GitHub Actions runs
│   ├── ci-last-failure    # Print latest failed run logs
│   ├── install-hooks      # Configure core.hooksPath and chmod hook scripts
│   ├── encrypt-prose      # Encrypt .prose/runs/ and .prose/agents/ before push
│   └── decrypt-prose      # Decrypt after clone/pull (symlink to encrypt-prose)
├── .prose/
│   ├── *.prose            # OpenProse programs (public, committed plaintext)
│   ├── runs/              # Execution state (private, encrypted before push)
│   └── agents/            # Persistent agent memory (private, encrypted before push)
├── .pi-version            # Last known-good pi version
├── .sops.yaml             # Age encryption rules
├── .githooks/             # pre-commit + pre-push safety nets for direct git usage
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

### Before pushing to GitHub:
```bash
make pre-push-checks       # same gate used by CI
```

For release/upstream work, use one command:
```bash
make release-preflight
make land
```
Install local hooks once per clone:
```bash
make install-hooks
```
This sets `core.hooksPath=.githooks` so `pre-push` runs automatically.

CI helpers:
```bash
make ci-status N=15
make ci-last-failure
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
- Launch in tmux with a sentinel: `tmux send-keys -t eval:name 'command; echo done > /tmp/ypi-signal-name' Enter`
- The `notify-done` extension wakes you automatically — do NOT `sleep`/poll/`capture-pane` in a loop
- Use `uv run` for Python scripts that need dependencies
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
| `RLM_PROVIDER` | LLM provider override for root + sub-calls; otherwise seeded from Pi's active/root provider | Pi settings/active model |
| `RLM_MODEL` | LLM model override for root + sub-calls; otherwise seeded from Pi's active/root model | Pi settings/active model |
| `RLM_THINKING_LEVEL` | Thinking level propagated to child calls; otherwise seeded from Pi's active/root thinking level | Pi settings/active thinking |
| `RLM_SYSTEM_PROMPT` | Path to system prompt file | (required) |
| `PI_TRACE_FILE` | Trace log path | (none) |
| `RLM_TIMEOUT` | Max wall-clock seconds | (none = unlimited) |
| `RLM_START_TIME` | Epoch seconds when the current depth-0 tree began | (auto-set per top-level call) |
| `RLM_MAX_CALLS` | Max total rlm_query invocations (permits 1..N, rejects N+1) | (none = unlimited) |
| `RLM_CALL_COUNT` | Running count of calls so far | `0` |
| `RLM_CHILD_MODEL` | Model override for all child depths | (none = same as parent/root route) |
| `RLM_CHILD_PROVIDER` | Provider override used with `RLM_CHILD_MODEL` | (none = same as parent/root route) |
| `RLM_CHILD_THINKING_LEVEL` | Thinking override for all child depths | (none = same as parent/root thinking) |
| `RLM_CHILD_MODELS` | Comma-separated per-child-depth model route, depth 1,2,... | (none) |
| `RLM_CHILD_PROVIDERS` | Comma-separated per-child-depth provider route, depth 1,2,... | (none) |
| `RLM_CHILD_THINKING_LEVELS` | Comma-separated per-child-depth thinking route, depth 1,2,... | (none) |
| `RLM_JJ` | Enable jj workspace isolation | `1` (set `0` to disable) |
| `RLM_UNSAFE_NO_JJ_WRITE` | Allow writable child tools when jj is disabled/unavailable | `0` |
| `RLM_SHARED_SESSIONS` | Allow child agents to write trace-named Pi sessions | `1` (set `0` for `--no-session`) |
| `RLM_CHILD_DISCOVERY` | Allow child Pi to load project skills, prompt templates, themes, context files, and approval prompts | `0` |
| `YPI_SHELL_HELPER` | Expose the shell `rlm_query` helper (its dir on `PATH` + its source in the prompt); the `ypi` wrapper sets this | `0` (a bare `pi -e` / npm install uses the native tool only) |

## Bugs We've Found (and must not re-introduce)

### 1. False stdin detection in CI (`[ -p /dev/stdin ]` can be true with empty input)
**Symptom**: Context is empty in sub-calls (T2/T4 failures in GitHub Actions).
**Cause**: Some CI shells expose stdin as a pipe inside `$(...)` even when nothing is piped.
`cat > "$CHILD_CONTEXT"` reads empty stdin and overwrites inherited context.
**Fix**: Prefer explicit `RLM_STDIN`; when pipe-read is empty and `RLM_STDIN` is unset,
fall back to inherited `CONTEXT`.
**Test**: T2/T4 (inherit), T3 (real pipe), CI run parity via `scripts/pre-push-checks`.

### 2. System prompt as shell arg vs file path
**Symptom**: Shell escaping nightmares, ARG_MAX errors.
**Cause**: `cat`-ing the system prompt into a shell variable.
**Fix**: Pass the file path; Pi's `resolvePromptInput()` reads it.
**Test**: T8, T9 verify file path passing.

### 3. System prompt too aggressive about recursion
**Symptom**: Model calls rlm_query on 11-line contexts, creating infinite chains.
**Fix**: "Check context size first, read directly if small."
**Test**: E1 (small context, should answer directly without sub-calls).

### 4. `RLM_MAX_CALLS` off-by-one (the Nth call was blocked)
**Symptom**: `RLM_MAX_CALLS=1` allowed zero calls; the budget under-counted by one.
**Cause**: the call count is allocated 1-based, but the guard used `>=` / `-ge`, rejecting call N.
**Fix**: reject only when the count exceeds the limit (`>` native, `-gt` shell) in both `native-tool.ts` and `rlm_query`.
**Test**: N2 (native harness), G8/G8b (guardrails).

### 5. Unsanitized trace IDs in session/temp filenames
**Symptom**: a hostile `RLM_TRACE_ID` (e.g. `../../x`) could traverse out of the session directory.
**Cause**: the raw `RLM_TRACE_ID` was interpolated into the child session filename and async job ID.
**Fix**: normalize `RLM_TRACE_ID` in place (`safe_trace_id` / `safeTraceId`) before any path use; also sanitize at the native filename site.
**Test**: N13 (native harness), G52 (guardrails).

### 6. Stale `RLM_START_TIME` on a long-running root Pi
**Symptom**: after a root Pi session was open longer than `RLM_TIMEOUT`, every `rlm_query` immediately "timed out."
**Cause**: the extension froze `RLM_START_TIME` at session start instead of when a recursion tree begins.
**Fix**: anchor `RLM_START_TIME` at each depth-0 call (native tool + shell); the extension no longer seeds it at load.
**Test**: N3/N12 (native harness), G4/G16 (guardrails).

### 7. Async `--notify` wrote invalid JSON; async temp files ignored `TMPDIR`
**Symptom**: child output with quotes/newlines/backslashes produced malformed peer-inbox JSONL; async temp files were hardcoded to `/tmp`.
**Cause**: raw string interpolation into the JSON message; `ASYNC_OUTPUT`/`ASYNC_SENTINEL` ignored `${TMPDIR:-/tmp}`.
**Fix**: build the inbox line with `python3 json.dumps`; honor `${TMPDIR:-/tmp}`.
**Test**: G53 (guardrails).

### 8. Provider env allowlist drift from upstream Pi (incl. a blind completeness test)
**Symptom**: a recursive child could not authenticate where the parent could — for env-var-only
auth on github-copilot (`COPILOT_GITHUB_TOKEN`) and huggingface (`HF_TOKEN`). The native tool's
`buildChildEnvironment` forwards only an allowlist, and both names were missing. A regression
versus master, which used no allowlist and inherited the full ambient env.
**Cause (two layers)**: (1) the hand-maintained allowlist drifted from Pi's provider env vars;
(2) the first completeness test only matched names ending in `_API_KEY`/`_OAUTH_TOKEN`, so it was
structurally blind to `COPILOT_GITHUB_TOKEN` / `HF_TOKEN` and passed despite the real gap.
**Fix**: added both names to the native + shell allowlists, and rewrote the completeness check to
derive the credential set from pi-mono's `getApiKeyEnvVars()` (the source of truth) by extracting
the actual env var NAMES — suffix-agnostic, so it can never go blind to a new provider name.
**Lesson**: a self-validating test must derive from the source of truth, not a guessed pattern;
a pattern-based "completeness" check gives false confidence.
**Test**: `tests/test_provider_allowlist.sh` (P1/P2 parity, P3 populated, C1 completeness derived
from `getApiKeyEnvVars()` in pinned pi-mono).

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

# Changelog

All notable changes to ypi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-02-12

### Added
- **Cost tracking**: children default to `--mode json`, parsed by `rlm_parse_json` for structured cost/token data
- **Budget enforcement**: `RLM_BUDGET=0.50` caps dollar spend for entire recursive tree
- **`rlm_cost` command**: agent can query cumulative spend at any time (`rlm_cost` or `rlm_cost --json`)
- **`rlm_parse_json`**: streams text to stdout, captures cost via fd 3 to shared cost file
- System prompt updated with cost awareness (SECTION 4 teaches `rlm_cost`)
- `rlm_query` source embedded in system prompt (SECTION 6) so agents understand their own infrastructure

### Changed
- **Uniform children**: removed separate leaf path — all depths get full tools, extensions, sessions, jj workspaces
- **Extensions on by default** at all depths (`RLM_EXTENSIONS=1`)
- **`RLM_CHILD_EXTENSIONS`**: per-instance extension override for depth > 0
- Recursion limited by removing `rlm_query` from PATH at max depth (not `--no-tools`)
- `RLM_JSON=0` opt-out for plain text mode (disables cost tracking)

### Removed
- Separate leaf code path (`--no-tools`, `--no-extensions`, `--no-session` at max depth)
- sops/age/gitleaks references from README and install.sh (internal only)

## [0.1.0] - 2026-02-12

Initial release.

### Added
- `ypi` launcher — starts Pi as a recursive coding agent
- `rlm_query` — bash recursive sub-call function (analog of Python RLM's `llm_query()`)
- `SYSTEM_PROMPT.md` — teaches the LLM to use recursion + bash for divide-and-conquer
- Guardrails: timeout (`RLM_TIMEOUT`), call limits (`RLM_MAX_CALLS`), depth limits (`RLM_MAX_DEPTH`)
- Model routing: `RLM_CHILD_MODEL` / `RLM_CHILD_PROVIDER` for cheaper sub-calls
- jj workspace isolation for recursive children (`RLM_JJ`)
- Session forking and trace logging (`PI_TRACE_FILE`, `RLM_TRACE_ID`)
- Pi extensions support (`RLM_EXTENSIONS`, `RLM_CHILD_EXTENSIONS`)
- `install.sh` for curl-pipe-bash installation
- npm package with `ypi` and `rlm_query` as global CLI commands

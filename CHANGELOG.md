# Changelog

All notable changes to ypi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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

# summary

kind: output

source:
```prose
output summary = session "Summarize what was done"
```

---

## Incorporation Result: Symbolic Access to Prompts

**Insight:** Anything the agent needs to manipulate precisely should be a file, not just tokens in context. Even short prompts benefit from `$RLM_PROMPT_FILE`.

**Result: Already fully incorporated. No changes made.**

The insight was found in all five knowledge layers:

- **SYSTEM_PROMPT.md** — Section 2 documents `$RLM_PROMPT_FILE` with usage guidance (line 12)
- **AGENTS.md** — Architectural Invariant #4 "Symbolic access" covers `$CONTEXT`, `$RLM_PROMPT_FILE`, and hashline (line 65)
- **README.md** — Design principle #4 mirrors the invariant for external users (line 101)
- **rlm_query** — Implementation creates the temp file and exports `$RLM_PROMPT_FILE` (lines 155-158, 218)
- **tests/test_unit.sh** — T14d verifies the file is set and contains the original prompt

**Tests:** 72 passed, 0 failed (no changes to verify, but confirmed existing tests cover this)

**Follow-up:** None needed. This insight has reached saturation in the repo.

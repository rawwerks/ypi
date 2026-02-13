# plan

kind: let

source:
```prose
let plan = session: planner
  prompt: "Analyze this insight and determine where it should be incorporated..."
```

---

## Insight Analysis: Symbolic Access to Prompts

**INSIGHT:** Symbolic access to prompts: anything the agent needs to manipulate precisely should be a file, not just tokens in context. Even short prompts benefit from being accessible as files ($RLM_PROMPT_FILE), because agents can grep/sed/cat them programmatically instead of copying tokens from memory. This applies to data ($CONTEXT), prompts ($RLM_PROMPT_FILE), and code edits (hashline).

## Current State Assessment

This insight is **already well-incorporated** across the repo. It was added as Architectural Invariant #4 and is present in all key locations:

### Where It Already Exists

1. **SYSTEM_PROMPT.md (line 12):** `$RLM_PROMPT_FILE` is documented in Section 2 with guidance on when to use it (extracting exact strings, counting characters).

2. **AGENTS.md (line 65):** Architectural Invariant #4 — "Symbolic access" — covers `$CONTEXT`, `$RLM_PROMPT_FILE`, and hashline. Tagged (T14d).

3. **README.md (line 101):** Design principle #4 — mirrors the AGENTS.md invariant for external users.

4. **rlm_query (lines 155-158):** Implementation — creates `$PROMPT_FILE`, writes the prompt to it, exports as `$RLM_PROMPT_FILE`.

5. **tests/test_unit.sh (T14d):** Tests that `RLM_PROMPT_FILE` is set and contains the original prompt content.

## Per-Location Recommendations

1. **SYSTEM_PROMPT.md** → SKIP. Already has the $RLM_PROMPT_FILE guidance in Section 2. The current text is concise and well-placed.

2. **AGENTS.md** → SKIP. Architectural Invariant #4 already captures this verbatim.

3. **README.md** → SKIP. Design principle #4 already covers this.

4. **tests/** → UPDATE. T14d tests that the file exists and has content, but doesn't test that an agent can actually *use* it programmatically (grep/sed). A stronger test would verify the file is readable and grep-able. However, this is a unit test with a mock pi — the current test is sufficient for the bash-level contract (file exists, has content). The actual "can grep it" property is trivially true if the file exists. **No new test needed.**

5. **Code (rlm_query)** → SKIP. Already implements the feature (lines 155-158, 218).

6. **CHANGELOG.md** → SKIP. No new changes to log.

## Conclusion

**No changes needed.** The insight is already fully incorporated across all layers: specification (SYSTEM_PROMPT.md), documentation (AGENTS.md, README.md), implementation (rlm_query), and tests (T14d). The repo is aligned with this principle.

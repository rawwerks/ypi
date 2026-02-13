# agents_md

kind: let

source:
```prose
agents_md = session "Update AGENTS.md (if planned)"
```

---

Skipped. AGENTS.md Architectural Invariant #4 already captures this insight: "Symbolic access — Anything the agent needs to manipulate precisely is a file, not just tokens in context. $CONTEXT for data, $RLM_PROMPT_FILE for the original prompt, hashline for edits. Agents grep/sed/cat instead of copying tokens from memory. (T14d)"

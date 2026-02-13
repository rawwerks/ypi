# code

kind: let

source:
```prose
let code = session "Apply code changes"
```

---

No code changes needed. The plan determined that the insight about symbolic access to prompts is already fully implemented in `rlm_query` (lines 155-158 create `$PROMPT_FILE`, line 218 exports it as `$RLM_PROMPT_FILE`). No behavioral changes required.

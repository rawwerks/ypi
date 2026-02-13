# tests

kind: let

source:
```prose
let tests = session "Add regression tests"
```

---

No new tests needed. T14d already covers the symbolic access contract:

```
T14d: RLM_PROMPT_FILE is set and contains the original prompt (symbolic access)
```

This test verifies that:
1. `RLM_PROMPT_FILE` is set to a temp file path (`/tmp/rlm_prompt_*`)
2. The file contains the exact original prompt text

The "can agents grep/sed it?" property is trivially satisfied if the file exists with correct content — it's a regular file on disk. No additional test provides meaningful value beyond T14d.

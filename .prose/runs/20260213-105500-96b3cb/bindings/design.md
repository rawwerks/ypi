# design

kind: let

source:
```prose
let design = session "Design an A/B experiment"
```

---

## Experiment: pipe-vs-filename

**Hypothesis:** Piping source to rlm_query as context produces better edits than telling the child the filename.

**Conditions:**
- **A (pipe):** Cat the rlm_sessions source into rlm_query via stdin, prompt asks it to add --version flag
- **B (filename):** Tell rlm_query the path to rlm_sessions, let it read the file itself, same task

**Task:** Add a `--version` flag to `rlm_sessions` that reads version from `.pi-version`

**Measurements:**
- Time to complete
- Does the output parse (`bash -n`)?
- Does it contain a `--version` handler?
- Diff size (how much changed vs original)
- Were existing functions preserved?
- Line count preservation

**Trials:** 1 each (A and B)

**Script:** `experiments/pipe-vs-filename/run.sh`

Usage:
```bash
bash experiments/pipe-vs-filename/run.sh A   # Pipe condition
bash experiments/pipe-vs-filename/run.sh B   # Filename condition
```

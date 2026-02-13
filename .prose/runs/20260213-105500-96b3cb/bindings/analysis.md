# analysis

kind: output

source:
```prose
output analysis = session "Analyze results and decide"
```

---

## Experiment Results: pipe-vs-filename

**Hypothesis:** Piping source to rlm_query as context produces better edits than telling the child the filename.

### Raw Metrics

| Metric | Condition A (pipe) | Condition B (filename) |
|--------|-------------------|----------------------|
| Time | 10s | 7s |
| Parse OK | ✅ yes | ✅ yes |
| Has --version flag | ✅ yes | ✅ yes |
| Modified lines | 238 (+19) | 228 (+9) |
| Functions preserved | ✅ yes | ✅ yes |
| Diff lines | ~20 | ~16 |

### Qualitative Analysis

**Condition A (pipe — source as context):**
- Added 19 lines — clean, well-commented `--version` block
- Placed correctly after the shebang/header, before other logic
- Used `BASH_SOURCE[0]` for robust path resolution
- Added extra whitespace handling (`strip newline`)
- **No regressions** — rest of script perfectly preserved

**Condition B (filename — let child read):**
- Added 10 lines — minimal, compact `--version` block
- Also placed correctly (after the shared_sessions gate)
- Used `dirname "$0"` for path resolution
- **INTRODUCED A REGRESSION:** Removed `elif isinstance(content, list):` on line 199-200, replacing it with a bare `for part in content:`. This breaks the grep command's Python snippet — it would iterate over characters when `content` is a string instead of only iterating when it's a list.

### Verdict

**Hypothesis: SUPPORTED (weakly)**

Condition A (pipe) produced a **correct, regression-free edit**. Condition B (filename) produced a working `--version` flag but **also introduced an unrelated regression** in the Python code within the grep handler.

The likely explanation: when the child reads the file itself, it may truncate or selectively reproduce parts, introducing copy errors. When the source is piped as context, the child has the exact original text available and is more likely to reproduce it faithfully.

However, this is **weak signal** from n=1. The regression in B could be a random LLM error. Key observations:

1. **Speed:** B was 3s faster (7s vs 10s) — expected, since it can skip reading
2. **Correctness:** A was more correct — no regressions
3. **Minimality:** B was more minimal (+9 lines vs +19 lines)
4. **Reliability:** A preserved the original code exactly; B did not

### Recommendation

**Keep the pipe pattern as the default for edit tasks.** The regression-free behavior is more valuable than the 3s speed improvement. When you need an agent to modify a file, piping the content gives it the exact source of truth rather than trusting it to read and reproduce faithfully.

**Better experiment for next time:**
- Run 3-5 trials per condition to distinguish signal from noise
- Use a more complex edit task (the --version flag is too simple)
- Measure with `shellcheck` for deeper quality analysis
- Have a human judge score the diffs blindly

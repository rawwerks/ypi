# insight

kind: input

source:
```prose
input insight: "The insight to incorporate across the repo"
```

---

Symbolic access to prompts: anything the agent needs to manipulate precisely should be a file, not just tokens in context. Even short prompts benefit from being accessible as files ($RLM_PROMPT_FILE), because agents can grep/sed/cat them programmatically instead of copying tokens from memory. This applies to data ($CONTEXT), prompts ($RLM_PROMPT_FILE), and code edits (hashline).

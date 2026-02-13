# e2e

kind: let

source:
```prose
let e2e = exec "cd /home/raw/Documents/GitHub/ypi && make test-e2e 2>&1 | tail -25"
```

exit_code: 1
stderr: (empty)

---

Failures:

  ✗ E7: small context no-recurse: expected '42', got: 
  ✗ E8: self-similarity: depth0='What is the user's name? Reply with ONLY the name.What is the history of mathematics? Summarize the history of mathematics in one paragraph.' depth1='Tokyo'

make: *** [Makefile:24: test-e2e] Error 1

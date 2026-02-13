# known_good

kind: let

source:
```prose
let known_good = exec "cat .pi-version 2>/dev/null || echo unknown"
```

exit_code: 0
stderr: (empty)

---

0.52.10

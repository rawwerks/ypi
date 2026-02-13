# e2e

kind: let

source:
```prose
let e2e = exec "make test-e2e 2>&1 | tail -20"
```

exit_code: 2
stderr: (empty)

---

  ✗ E8: self-similarity: depth0='What is the user's name? Reply with ONLY the name.The history of mathematics is a vast and intricate tapestry, woven across millennia by thinkers from every corner of the globe. From the earliest tally sticks of the Paleolithic era to the complex abstractions of modern category theory, the human quest to understand quantity, structure, space, and change has driven technological progress and shaped nuestro world.' depth1='Tokyo'

make: *** [Makefile:24: test-e2e] Error 1

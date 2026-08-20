## The write-back wiring test failed on Windows and passed in CI [low]

**Symptom** — `tests/autocountWritebackWiring.test.ts` reported "anchor not
found after mfgSalesOrders.post('/:docNo/items/:itemId/tbc-update'" on a local
Windows checkout, while the same commit was green in CI.

**Root cause** — Traced to the bytes, not guessed. `?raw` hands back the WORKING
TREE contents, and with `core.autocrlf=true` those are CRLF while git stores LF.
Three of the anchors end in `});
`, which exists in the blob and not in the
checked-out file. Every other anchor in the suite is a single line, which is why
only these three failed.

**Fix** — Normalise the raw imports to LF before matching, in that suite and in
the new contract suite beside it. A source-anchored test must not mean different
things on different platforms — and this one runs on the owner's Windows box.

**Ref** — 2026-08-10, PR test/ac-writeback-trial.

## The re-decoder would have upper-cased 8038-Console [medium]

**Symptom.** Caught in the DRY-RUN, before any row was written. The first
production plan of `redecode-collapsed-sofa-lines.mjs` (run 33664350222,
2026-09-02) proposed `1A(P)(LHF)+CONSOLE+1A(P)(RHF)` for HC-SO-012695 and
`1A(LHF)+CNR+CONSOLE+1NA+1A(RHF)` for HC-SO-013226 — but the product master
spells that piece **`8038-Console`**, not `8038-CONSOLE`
(`scripts/data/minted-sofa-skus-2026-08.json` holds `2376-Console`,
`8030-Console`, `8038-Console`, and nine more of the same shape).

Two of the eight builds in scope would have landed an `item_code` that matches
no row in `scm.mfg_products` by equality — findable by `upper(code)`, invisible
to a plain join. Every other compartment the decoder emits is already upper-case,
which is exactly why nothing noticed: `Console` is the only mixed-case
compartment in the vocabulary.

**Root cause (traced).** `pieceCodes()` upper-cased both the model and the piece,
and `planRow()` upper-cased its targets again, so the catalogue's own spelling
was destroyed twice on the way to the write. The existence check that vetted
those codes ran against a `Set` of upper-cased codes and passed — the classic
shape CLAUDE.md warns about, a check that answers a DIFFERENT question: "does a
product with this code exist, ignoring case" is true while "is this the string
the master holds" is false.

**Fix.** `canonicaliser(codes)` in `scripts/lib/redecode-sofa-plan.mjs` turns any
casing of a code into the one `scm.mfg_products` actually holds, and it is
applied to every decoded piece list. `pieceCodes()` now preserves case with a
case-insensitive prefix test, and `planRow()` compares case-insensitively while
returning its targets verbatim. Three tests in
`backend/tests/redecodeSofaPlan.test.mjs` pin it, named after the two documents
above.

Nothing was applied to production before or after this: the script has only ever
been run in `MODE=plan`.

**Ref.** `fix/redecode-sofa-catalogue-casing`, 2026-09-02. Dry-run that found it:
run 33664350222.

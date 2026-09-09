## A new probe compared sofa codes unfolded and printed six decompositions as differences on its first run [low]

<!-- area: Sofa, fabric, variants -->
<!-- status: fixed -->

**Symptom.** `probe-gr-iv-pi-remainder.mjs`, first production run
`34202080707`, printed four goods receipts as `BAGS DIFFER` and two invoice rows
as goods the book does not have:

```
BAGS DIFFER GR-003922|PO-007009   book: 9058-1S x1
                                  ours: 9058-1A(LHF) x1 | 9058-1A(RHF) x1 | 9058-1NA x2 | 9058-CNR x1
BAGS DIFFER GR-000997|PO-001696   book: 2379-1S x1        ours: 2379-2S x1
PI PI-001793: we hold "2379-2S" qty 1 at RM 1600.00 — the book has 0 of it
IV I-2412-0065: we hold "2379-2S" qty 1 at RM 2600.00 — the book has 0 of it
```

All six are one sofa each. None is a difference.

**Root cause (traced).** A sofa is ONE book line and ONE ERP ROW PER
COMPARTMENT, so the raw code bags can never be equal on a sofa document. The
probe's own sofa exclusion tested `line_suffix` on our side and `/SOFA/` on the
book's TRANSLATED code — and `scm.grn_items.line_suffix` is NULL on every
migrated receipt, while the book's `AMN-SF2379 SOFA` becomes `2379-1S` through
the mapping sheet, which contains no "SOFA" at all. Both halves of the exclusion
were therefore dead, and the comparison ran on codes that are not commensurable.

This is `docs/bugs/0694-a-sofa-exclusion-that-tested-only-line-suffix-printed-40-dec.md`
happening again in a new file — the same weak exclusion, the same invented
findings, four days later. Writing a third opinion about what a sofa code means
is what makes it recur.

**Fix, in two rounds, and the FIRST ROUND WAS NOT ENOUGH — which is the part
worth reading.** Round one folded both sides through `comparisonKey`, the
canonicalisation the reconcile's keyless verdict uses. Run `34203599150` proved
it half right: the two invoice rows were gone, and the four goods receipts still
printed, now as `book: SOFA 9058 x1` against `ours: SOFA 9058 x5`. Folding the
CODE is not folding the QUANTITY — five compartment rows are one sofa, not five —
and `comparisonKey` never claimed to do that. Writing the division here would
have been the third opinion about a sofa that produced this bug in the first
place.

Round two calls the module that already answers the whole question:
`bagOf` + `compareBags`, which folds our compartments by the BOOK's own build
text (`description2`, stored verbatim on every compartment row by both cutover
importers) and DIVIDES rather than taking `MIN` — its header carries the two ways
`MIN` gets it wrong. `compareMoney: false`, because a migrated receipt's price
comes from the purchase ORDER by design and a book-vs-ERP price here would
measure our own derivation; the money axis is compared against the header
instead, where it is real. The book side is handed its UNTRANSLATED `itemKey` as
`rawCode` — the half that was dead — and a shortfall on a folded `SOFA <model>`
key is skipped in the extra-row scan, because our rows outnumber the book's line
there by construction.

**RUN, and it is no longer UNTESTED** — run `34206144168`, 2026-09-08 16:44
(+08), against production:

```
GR unkeyed rows — 29 pair(s) still carry at least one ERP row with NO AutoCount
key. Compared as MULTISETS (sofa builds folded by the book's own build text):
28 PROVEN identical, 1 carry a real difference, 0 genuinely undecidable.
PI — 1 ERP row(s) the book does not account for.   (CELENE 2.0 (A)(F)-(Q) on PI-007875)
IV — 0 ERP row(s) the book does not account for.
```

Six false rows before, one row after — and the one that survives is a DIFFERENT
defect, not this one: `GR-000997|PO-001696`, where the book's own code for that
sofa is `2379-1S` and carries no "SOFA" at all, so `comparisonKey`'s book branch
does not fold it while our compartment code does. `docs/bugs/0709`.

The KEYED verdict this probe's conclusions actually rest on — `0 line(s) where
the ERP row and the book line carry the SAME AutoCount key and DIFFERENT
products` — is unchanged on all four runs (`34202080707`, `34202524554`,
`34203599150`, `34206144168`). It never used the bag.

**Ref.** fix/gr-iv-pi-remainder, 2026-09-08.

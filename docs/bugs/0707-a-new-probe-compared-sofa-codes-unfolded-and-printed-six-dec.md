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

**Fix.** Both sides now go through `lib/keyless-multiset.mjs`'s `comparisonKey`,
the same canonicalisation the reconcile's own keyless verdict uses (model-folded
through `SOFA_MODEL_ALIAS`; 5535 is its own model and is not in that table). The
book side is handed its UNTRANSLATED `itemKey` as `rawCode`, which is the half
that was dead, and a shortfall on a folded `SOFA <model>` key is skipped in the
extra-row scan rather than reported — our rows outnumber the book's line there by
construction. Verified against production, run TBD-BELOW: the four `BAGS DIFFER`
and the two invoice rows are gone and the keyed item-code verdict (`0 line(s)
where the ERP row and the book line carry the SAME AutoCount key and DIFFERENT
products`) is unchanged.

**Ref.** fix/gr-iv-pi-remainder, 2026-09-08.

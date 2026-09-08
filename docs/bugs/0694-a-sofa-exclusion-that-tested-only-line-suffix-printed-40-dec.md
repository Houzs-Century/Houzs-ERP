## A sofa exclusion that tested only line_suffix printed 40 decompositions as wrong products [medium]

**Symptom.** `probe-gr-pi-iv-residue.mjs`, run 34186539198 (2026-09-08 12:22
+08), announced:

```
GR ITEM CODE AS A SET — 339 pairs where the book's item codes and ours are the SAME MULTISET;
61 where they genuinely DIFFER; 0 sofa-decomposed pairs not comparable as sets
   THE MULTISET GENUINELY DIFFERS — a product is wrong on these, and each is real work:
     GR-004037|PO-007479   book: 9028-1S x1
                           ours: 9028-1A(RHF) x1 | 9028-2A(LHF) x1
```

Read literally, that says 61 goods receipts name the wrong product, on go-live
morning, in the column the owner is waiting on. It is false.

**Root cause (traced).** `9028-1S` is a whole sofa; `9028-1A(RHF)` and
`9028-2A(LHF)` are its COMPARTMENTS. Every one of those rows is the sofa
decomposition the reconcile has declared for months — one book line becoming one
ERP row per compartment.

The probe was supposed to exclude exactly that and could not, because it tested
one property:

```js
const isSofa = erp.lines.some((l) => l.line_suffix);
```

`scm.grn_items.line_suffix` is **NULL on every migrated receipt** —
`reshape-migrated-grns.mjs` writes `poi?.line_suffix ?? null` and an
unattributed line has no `poi`. So the test could never fire, which is why the
same line of output reports **`0 sofa-decomposed pairs`** while listing sofas.

`check-ac-erp-reconcile.mjs:1109` had already learned this and detects it three
ways, with a comment saying why: *"because no single one is reliable across the
import rounds"*. The probe copied one of the three.

**Why this is the same bug class as a matcher that misses.** This repo's rule is
*"a checker that cannot match reports a clean run"* — a dead pattern makes a
verdict read as a pass. This is that failure with the sign flipped: a dead
EXCLUSION makes a verdict read as 61 defects. Both come from a predicate that
cannot fire, and the invented finding costs what the missed one does — the real
differences in the same list stop being believed. `docs/bugs/0689` recorded the
identical shape when a naive CSV split invented 40 of 101 item-code defects.

**Fix.** The probe now detects a decomposed document the same three ways the
reconcile does: an ERP `line_suffix`, AutoCount's own `/SOFA/` code on a book
line, or an ERP compartment suffix (`-1A(LHF)`, `-L(RHF)`, `-CNR`, `-1NA`,
`-STOOL`, `-CONSOLE`, `-1S`). The comment at the site records the measured
reason rather than the rule, so the next reader learns why one test is not
enough.

**What the corrected reading does NOT change.** The three findings this probe
was written for stand, and none of them rests on the sofa exclusion:

* GR money — 9 receipts carry a non-zero total that is not the book's, each with
  its line-price census (`GR-004909|PO-009017`: 1 of 4 lines priced).
* IV / PI line shape — **44 documents (13 + 31) whose line COUNT differs, and on
  all 44 the document TOTAL is identical to the sen; 0 are not.**
* IV absent — 6, each with its source delivery order named.

**Ref.** fix/gr-pi-iv-classify, 2026-09-08.

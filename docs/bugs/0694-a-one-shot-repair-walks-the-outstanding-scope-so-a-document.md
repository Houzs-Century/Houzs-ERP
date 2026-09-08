## A one-shot repair walks the outstanding SCOPE, so a document that has since been delivered keeps its wrong money forever [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `repair-po-line-discount.yml` was APPLIED on 2026-09-07 19:22
Malaysia (run `34116301278`) and reported, truthfully:

```
IN THE MIGRATED SCOPE: 89 line(s) across 10 purchase order(s), RM 42,662.80.
  lines written: 89 of 89
  headers written: 10 of 10
  89 of 89 corrected line(s) re-read; invariant broken on 0
```

Sixteen hours later the reconcile still printed a purchase-order money
difference: `PO-009770: AutoCount RM 13893.75 vs ERP RM 18525.00`. Re-dispatched
in PLAN mode over the current snapshot (run `34186213070`) it answered
**`The ERP overstates these 9 purchase order(s) by RM 0.00`** and
`Lines to correct: 0`. Both runs are correct and the document is still wrong,
which is the finding.

**Root cause (traced).** The repair's population is
`buildScope(book).PO` — the OUTSTANDING purchase orders. `PO-009770` is not in
it. Run against the same committed snapshot the reconcile uses:

```
scope sizes: { SO: 2789, PO: 484, GR: 214, DO: 84, IV: 47, PI: 192 }
PO-009770 in scope.PO? false
readBookDiscounts inScope { docs: 9, lines: 84 }
byDoc keys: PO-009887, PO-009948, PO-009982, PO-010019, PO-010021,
            PO-010069, PO-010072, PO-010104, PO-010165
```

**The scope answers "which documents SHOULD the ERP have". The damage's
population is "which documents DOES the ERP have", and the two drift apart the
moment the book moves.** A purchase order that was outstanding when it was
imported stops being outstanding once its goods arrive; it leaves the scope
while our copy of it — discount dropped, RM 4,631.25 too high — stays exactly
where it is. The reconcile compares every document on both sides, so it SEES
`PO-009770`; every repair keyed on the scope cannot.

The size of the gap, from the same reconcile run `34185154444`: the ERP holds
**574 migrated purchase orders and the scope has 484 — 91 are "present though
out of scope"**, and the sales-order side is the same shape (2,882 held against
2,789 in scope, 93 out of scope). Four of the sales orders on the go-live
reconcile's own offender list are in that 93 — `SO-003945`, `SO-007144`,
`SO-012571`, `SO-013181` — and `ac-outstanding-so.json.gz` carries **zero** lines
for any of them, which is why `topup-ac-so-lines.mjs` reports them as neither
missing nor unjudgeable: they are not in the file it reads at all.

**Fix.** `repairPopulation(scopePo, erpHeldAcNos)` in
`backend/scripts/lib/po-discount-plan.mjs` — the UNION of the scope and the
`linked_ac_docno` values the ERP actually holds. The union rather than the ERP
set alone, so that "in scope but absent from the ERP" stays reportable; dropping
it would silently delete the only signal that a document never arrived.
`repair-po-line-discount.mjs` now reads that set from the database BEFORE it
filters the book, and prints the three counts so the difference between the two
populations is on screen instead of implicit.

Pinned by three cases in `backend/tests/poDiscountPlan.test.mjs` under *the
population a repair walks is what the ERP HOLDS*. **Proved RED on the unfixed
rule** — with the union replaced by the old scope-only set, `2 failed | 21
passed`, failing on `expected false to be true` for `byDoc.has("PO-OUT")`;
restored, `23 passed`.

**Ref.** fix/so-do-money-reconcile, 2026-09-08.

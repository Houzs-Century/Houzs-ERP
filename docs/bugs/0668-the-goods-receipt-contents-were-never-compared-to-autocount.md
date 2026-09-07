## The goods receipt contents were never compared to AutoCount and NOT APPLICABLE was read as checked [high]

<!-- area: Cutover + migrated data -->

**Symptom.** The owner, 2026-09-07, before tallying stock against AutoCount:
「可是 DO GR 你都检查对了？」 — are the delivery orders AND the goods receipts
actually verified? The delivery orders were: `check-ac-erp-reconcile.mjs` walks
171 of them field by field. The goods receipts were not. `check-migration-fidelity.mjs`
prints, for the GR section:

```
GR DATA — line and money comparison NOT APPLICABLE.
```

and stops. Nothing downstream distinguished that sentence from a pass, so 320
migrated goods receipts carrying 591 lines went to the edge of go-live with
their contents compared to the book on exactly zero axes.

**Root cause (traced).** The "not applicable" reasoning is sound as far as it
goes, and it is the reason nobody looked again. `create-migrated-documents.mjs`
`doGrns()` writes `qty_received = it.received_qty` from the PO line, and one ERP
GRN covers a whole purchase order while an AutoCount receipt can span several —
so a line-for-line comparison would measure the ERP's own derivation rather than
the book. Both facts are true. What does not follow is that NOTHING is
comparable:

- `ac-fidelity-manifest.json` records `grdtl_rows_with_line_key: 0` of 21,001, so
  the LINE grain is genuinely lost — but the export already aggregates to
  `(PO document, item code)` in `ac-fidelity-gr-by-po-item.json.gz` (15,569 rows
  over 8,920 purchase orders), and the PO document total above that is immune to
  both the item-code map and to sofa decomposition.
- Beneath every quantity question sits one that needs no arithmetic at all: did
  AutoCount receive ANYTHING against this purchase order? A migrated GRN on a
  purchase order AutoCount never received against is a receipt the ERP invented,
  and that test is presence against presence.

The gap is therefore a REPORTING defect, not a data-shape one: the checker had
the snapshot in hand — it already loads `ac-fidelity-gr-by-po-item.json.gz` at
`check-migration-fidelity.mjs:224` to annotate a different finding — and used it
for a footnote instead of for a verdict.

**Fix.** `backend/scripts/check-gr-fidelity.mjs` + `.github/workflows/check-gr-fidelity.yml`,
read-only, manual dispatch, its own concurrency group. Four tests, each with its
denominator, and an UNVERIFIABLE bucket that is printed rather than dropped:

1. is each goods receipt line still a faithful mirror of its purchase order line
   (which is what makes every later statement also a statement about
   `purchase_order_items.received_qty`);
2. receipts the ERP has that AutoCount never made, and receipts it is missing —
   presence against presence;
3. received quantity per purchase order, reported SEPARATELY for purchase orders
   with no sofa line (where the row shapes match and the verdict is exact) and
   for those with one (where one AutoCount sofa line is one ERP line per
   compartment, so an ERP total is a compartment count);
4. received quantity at `(purchase order, item code)` grain, sofa excluded.

Before any of it is used as truth the check cross-examines the snapshot against
itself: `PODTL.TransferedQty` and `SUM(GRDTL.Qty)` are written by different parts
of AutoCount and agree on **9,061 of 9,080 purchase orders**; the 19 that
disagree are reported UNVERIFIABLE rather than resolved by picking a winner.

**The rule to keep.** "NOT APPLICABLE" is not a verdict, and a checker that
prints it must say what IS applicable or say UNKNOWN. An aggregate that cannot
reach the line grain still reaches the document grain, and presence-against-
absence needs no grain at all.

**Ref.** fix/gr-do-verify, 2026-09-07.

## A mixed sofa receipt keeps the accessory's money and drops the sofa's, so it looks priced and is 96 percent wrong [high]

**Symptom.** The reconcile reports 109 goods-receipt document-total differences.
100 carry RM 0.00 in the ERP and are covered by the owner's 2026-09-08 ruling
「GR 0 没关系」. Nine carry a **non-zero** figure that is not the book's:

```
GR-004909|PO-009017  book RM 3200.00  ERP RM  120.00
GR-005171|PO-009344  book RM 2330.00  ERP RM   80.00
GR-005169|PO-009475  book RM 2230.00  ERP RM   60.00
GR-005151|PO-009415  book RM 2290.00  ERP RM   90.00
GR-005303|PO-009676  book RM 3150.00  ERP RM  200.00
```

**Root cause (traced).** The explanation written into the source is refuted by
the book. `probe-gr-pi-iv-residue.mjs:34-40` says a receipt "totals only the
lines whose order happened to carry money", which predicts a partial sum of the
priced purchase-order lines. Measured against the committed cut, **not one
purchase-order line on any of those five pairs is priced** — every one would
have to be RM 0.00, i.e. inside the accepted 100. They are not.

What the money actually is: the ERP total equals, to the sen, the book's
**goods-receipt** subtotals of the **non-sofa** lines only. The shortfall is
exactly the sofa.

```
GR-004909|PO-009017  AMN-SF9058 SOFA    qty 1  GRDTL sub RM 3080.00  <- dropped
                     AMN-SQUARE PILLOW  qty 4  GRDTL sub  RM 120.00  <- the ERP total
```

`reshape-migrated-grns.mjs:722-734` prices a line through a three-branch
cascade. A sofa line is attributed to its own compartment purchase-order line
(`:550-557`) and so takes branch 2, `poi.unit_price_sen` — a byte copy of the
book's PODTL UnitPrice (`import-ac-outstanding-po.mjs:292`), which is **0**,
because Houzs prices a purchase when the goods arrive. The accessory beside it
is not so attributed and keeps its own receipt-line money. An all-sofa receipt
therefore lands at RM 0.00 and is swallowed by the owner's ruling; a **mixed**
receipt leaks a small, plausible, wrong number.

Census over all 400 book `(GR x PO)` pairs: 51 all-sofa, **22 mixed**, 327
no-sofa; 19 of the 22 mixed pairs carry book money, and the 9 are a subset of
those 19.

**The ruling does not cover these.** 「GR 0 没关系」 says a migrated receipt may
carry no money. It does not say a receipt may carry RM 120.00 where the book
says RM 3,200.00. The sorting predicate is `ac-not-a-difference.mjs:166`,
`Number(r.erpSen ?? 0) === 0`, so a wrong non-zero total is never even offered
to the proof that clears the 100.

The same per-document sofa flag disqualifies the item-code multiset check.
`check-ac-erp-reconcile.mjs:1108-1109` sets `sofa` from
`acLines.some(isSofaCode)`, and `:1128` only fills `bags` when `!sofa`. On
`GR-005304|PO-009714` a `HOK-5536 SOFA` sits beside a transposed
`LONG PILLOW` / `SQUARE PILLOW` pair whose multisets **are** equal; because the
sofa is on the document the classifier is never allowed to look, and
`ac-not-a-difference.mjs:339` prints "no item-code multiset was measured". Those
are the two GR item-code differences, and they are the checker's own guess.

**Fix.** Not fixed here — the remedy is an owner call, because writing the
book's total onto 9 receipts while 100 stay at RM 0.00 is a different rule from
the one he gave. This entry records the mechanism, the bounded population and
the refutation of the source's own stated cause.

**Ref.** fix/cutover-127-sweep, 2026-09-08. Measured offline from
`backend/scripts/data/ac-reconcile-truth.json.gz` and `ac-convert-edges.json.gz`;
no database was contacted. Same per-document sofa flag as
`docs/bugs/0691-a-missing-line-on-a-sofa-document-is-invisible-because-line.md`.

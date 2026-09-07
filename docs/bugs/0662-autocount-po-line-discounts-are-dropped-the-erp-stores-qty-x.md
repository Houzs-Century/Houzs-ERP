## AutoCount PO line discounts are dropped: the ERP stores qty x unit price undiscounted [high]

**Symptom.** A migrated purchase order shows a bigger line amount and a bigger
document total than the same purchase order in AutoCount. `PO-009948` line 16 is
one unit of `AK-ARMOUR MATT (K)` at a unit price of RM 1,880.00; AutoCount totals
that line at RM 1,410.00 — exactly 75%, a 25% line discount — and the ERP holds
RM 1,880.00.

**Root cause (traced).** AutoCount stores `PODTL.UnitPrice` and `PODTL.SubTotal`
as separate columns, and the discount lives in the gap between them: `SubTotal`
is the discounted amount, `UnitPrice` is not. All three purchase-order writers
compute the line amount themselves from the undiscounted half and never read the
book's own amount:

- `import-ac-outstanding-po.mjs:230` — `const up = centi(l.UnitPrice); const lt = up * qty; subtotal += lt;`
- `import-ac-outstanding-po.mjs:379` — `subtotal_sen` / `total_sen` are that same sum
- `import-ac-so-linked-pos.mjs:403` — `${it.qty * it.priceSen}` as `line_total_sen`

`export-ac-reimport.py`'s PO select carries `UnitPrice` and not `SubTotal`, so the
discounted amount never reaches the ERP side at all — the writers could not have
copied it even if they had tried to. The defect is therefore in the EXPORT plus
the WRITE, not in one line of arithmetic.

**Measured**, whole book, against `ac-reconcile-truth.json.gz` exported
2026-09-07T07:34:00Z (the pre-lock cut — the FINAL 16:21 cut does not re-cut this
file): **2,976 lines across 533 purchase orders, RM 1,760,189.99** of difference.
Inside the migrated set as `lib/ac-scope.mjs` defines it: **10 purchase orders** —
PO-009335, PO-009887, PO-009948, PO-009982, PO-010019, PO-010021, PO-010069,
PO-010072, PO-010104, PO-010165.

**Fix.** NOT YET FIXED — this entry records the defect and the instrument that
now finds it. `check-ac-erp-reconcile.mjs` grew a FIELD IDENTITY section
(`scripts/lib/ac-field-identity*.mjs`) which reports the discount as its own row,
whole-book and in-scope, with the money value and worked examples, so the size of
the exposure is visible before anyone decides what to do about it. The repair
itself is an owner decision, because it changes money on documents that already
exist: either re-export with `PODTL.SubTotal` and back-fill `line_total_sen` /
`subtotal_sen` / `total_sen`, or leave the migrated purchase orders at the
undiscounted figure and correct them at invoice time. Both change what staff see
on 10 live documents, so neither is a unilateral fix.

**Ref.** feat/ac-field-identity, 2026-09-07.

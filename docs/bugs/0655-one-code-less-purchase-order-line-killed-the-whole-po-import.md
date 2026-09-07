## One code-less purchase-order line killed the whole PO import [high]

**Symptom.** The go-live rehearsal dispatched `Import AutoCount outstanding PO
(go-live)` against production in DRY-RUN on 2026-09-07 and the job died after
reading 512 outstanding PO lines:

```
##[notice]  code-less line imported as accessory: PO-009979 "ERGOTEX PILLOW CASE - FAIR" x20
TypeError: Cannot read properties of null (reading 'toUpperCase')
    at main (backend/scripts/import-ac-outstanding-po.mjs:298:39)
##[error]Process completed with exit code 1
```

Not one line was skipped and the rest imported — **the whole purchase-order
import produced nothing**, on the day of the cutover.

**Root cause (traced).** `import-ac-outstanding-po.mjs:199` sets
`let erp = hit ? hit.erp : null`, so `erp` is NULL whenever the AutoCount<->ERP
binding has no row. `:212` computes `codeless`, and `:217` then deliberately
**accepts** such a line when the book carries a description — the owner's
2026-09-02 ruling 「要进 accessories」 — logging it and falling through. Every
later use honours that: `:308` writes `erp: codeless ? null : erp`, `:309`
falls back to the description for the name.

The one site in between did not. `:298` read
`prodByCode.get(erp.toUpperCase())` with no guard, so the first accepted
code-less line threw. A code-less line has no product to look up; `null` is the
correct answer, not an error.

It had never fired because no accepted code-less line existed in an earlier
export cut. `PO-009979` arrived in the 2026-09-07 re-cut, and one row turned an
accepted case into a total failure.

**Fix, in two parts, because the crash was hiding a second defect.**

1. `const prod = erp ? prodByCode.get(erp.toUpperCase()) : null;` — the crash.
   Re-dispatching the same workflow from the fix branch against production in
   DRY-RUN then ran to completion (`POs to import: 165; lines: 439; value RM
   580,277.9`) and exited **2**, refused by the catalog guard.

2. That refusal was the second defect. `nonCatalogRefs` counts a blank code as
   an orphan — correct for every other caller — so the one accepted code-less
   line refused **all 165 purchase orders**, on cutover day. And the acceptance
   itself was unsound: the item push wrote `item_code: null`, marked *UNVERIFIED
   against the live column*, and the column is **NOT NULL** (`material_code text
   NOT NULL`, mig `0090_scm_purchase_consignment_tables.sql:70`, renamed by mig
   `0307_item_code_unify.sql:34`, never relaxed anywhere in the tree). The row
   could never have been inserted.

   So a code-less line is now recorded as an EXCEPTION naming what it needs — an
   accessory product minted, or the code pointed at a real one in
   `data/autocount-erp-mapping-1561.csv` — and the other 164 documents import.
   The shared guard is untouched: weakening it would have removed a real
   protection from every other caller to serve one owner-sanctioned case.

**Lesson.** An UNVERIFIED note in a comment is a live bug with a date on it. This
one sat until the run that would have exercised it, and it arrived attached to a
crash, so it cost two rounds to find instead of one.

**Ref.** fix/po-import-codeless-crash, 2026-09-07.

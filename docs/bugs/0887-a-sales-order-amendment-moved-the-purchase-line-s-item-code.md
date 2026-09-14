## A sales-order amendment moved the purchase line's item code and left the supplier code naming the old piece [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** HC-SO-013497/A1 ("ERP convert wrong item code", approved
2026-09-14 01:09 UTC) corrected two sofa pieces, `9058-L(LHF)` -> `9058-1A(LHF)`
and `9058-1NA` -> `9058-CNR`. Its PO follow-up HC-PO-2609-064/A1 was confirmed at
01:19 UTC (PO revision 2). The PO lines then read, on production (trace run
34813546330):

| line | our item code | supplier code (what the factory builds from) |
| --- | --- | --- |
| 1 | `9058-1A(LHF)` | `5536-L(LHF)` |
| 2 | `9058-CNR` | `5536-1NA` |

The PO PDF prints `supplier_sku` as "Supplier Code", and the AutoCount write-back
sends it as the ItemCode, so the supplier was being told to build a lounger end
where we need an arm, and a second 1NA where we need the corner.

**Root cause (traced).** Both amendment engines rewrite a PO line's item code
and never its supplier code.

- The SO-sourced follow-up (the path this PO took, `routes/po-amendments.ts`
  approve -> `reviseBoundPo` with `onlyPoId`): `backend/src/scm/lib/so-revision.ts`
  step (12a), the `purchase_order_items` UPDATE at line 1452 on `main`
  (`item_code: itemCode`, `material_name`, cost, variants, photos) — no
  `supplier_sku`. Its own ADD branch (12c) DID carry the binding's
  `supplier_sku`; the in-place re-derive never learned it.
- The manual PO amendment (`applyPoAmendment`): `backend/src/scm/lib/po-revision.ts`
  line 266 sets `patch.item_code` from `new_item_code`, no `supplier_sku`; its ADD
  insert carried none either.

Observed, not inferred: trace run 34814256189 printed the binding for each line
(`supplier_material_bindings`, supplier HOOKKA INDUSTRIES `d930541c`): `9058-1A(LHF)`
-> `5536-1A(LHF)`, `9058-CNR` -> `5536-CNR`, while the lines held `5536-L(LHF)` and
`5536-1NA`. The two lines whose code did not change matched their bindings.

This is the writer-side half of docs/bugs/0822, which taught the repair SCRIPTS
to move `supplier_sku` with a code correction; the two amendment engines in the
Worker were never taught, so every approved SPEC code change re-opened it.

**Fix.**

- `backend/src/scm/lib/po-line-supplier-sku.ts` `supplierSkuFor` — this
  supplier's binding for the item code, through the shared
  `readMfgProductBindings` reader with a supplier filter: the same row the
  convert path's append pass takes `supplier_sku` from. Company is a required
  argument.
- `reviseBoundPo` (12a) and `applyPoAmendment` (SPEC) call it ONLY when the item
  code actually moves, so a supplier code keyed on the PO by hand survives an
  unrelated amendment. No binding for that supplier clears the code (the PDF then
  falls back to the live binding, else `—`) and adds a plain-language warning to
  the confirm toast — never the old piece's code. `applyPoAmendment`'s ADD now
  carries the code too, and a header supplier change is honoured (the code is
  looked up for the supplier the PO has AFTER the amendment).
- Tests, proved RED on the unfixed tree first: `so-revision.reviseBoundPo.test.ts`
  "a code change re-derives the supplier code from the binding" reproduces this
  PO verbatim (4 lines, `L(LHF)`->`1A(LHF)`, `1NA`->`CNR`, a decoy binding on a
  second supplier) — 2 of 3 failed (`expected '5536-1NA' to be null`, the
  1A(LHF)/CNR match); `po-revision.applyPoAmendment.test.ts` — 3 of 3 failed.
  Green after. A fourth case pins that a header supplier change decides whose
  code a moved line takes (written with the fix, not red-first).

**Data.** `repair-sofa-line-shown-vs-code.mjs` gained a `DOCS` scope so one PO can
be corrected alone. Plan, company 1, scoped (run 34814902912): out of scope 0,
exactly `5536-1NA` -> `5536-CNR` and `5536-L(LHF)` -> `5536-1A(LHF)` on
HC-PO-2609-064. The unscoped plan before it (run 34813916035) found the same two
values and nothing else in 14 tables. Applied (run 34815009439): 2 of 2, verify OK
on a fresh connection. Fresh trace (run 34815098686): all four lines MATCH their
bindings; open-PO sweep 196 sofa lines, 0 naming another piece.

**Not fixed here, found on the way.** AutoCount still holds the pre-amendment
PO: the only outbox row for HC-PO-2609-064 is the 2026-09-11 `create_po`
(ItemCodes `5536-1A(RHF)`, `5536-1NA`, `5536-L(LHF)`, `5536-1NA`); the confirm's
`enqueueEdit` left no row at all, not even a skipped one, and neither did the two
SO amendments on HC-SO-013497. The PO was never emailed (`po_email_sent_at` null).
Whether a PDF was sent by hand leaves no trace.

**Ref.** fix/po-amendment-supplier-sku, 2026-09-14.

## Hookka purchase orders were refused because their item bindings named no AutoCount item, though the owner had ruled Hookka and Ohana one factory [medium]

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34834055311)
listed edits of three purchase orders for supplier 400-H004 (Hookka) refused
before sending: HC-PO-2609-068, HC-PO-2609-086 and the order behind outbox
doc id 044f73de (HC-PO-2609-001), each with *"ERP item code 'JAGER-(Q)' maps to
2 AutoCount items and none belongs to supplier 400-H004"* (likewise `CODY-(K)`,
`CELENE (A)-(K)`). A refused edit sends nothing, so those orders' changes never
reached the account book.

**Root cause (traced).** `resolveAcItemCode`
(`backend/src/services/autocount-item-code.ts`) is given the order's creditor.
`JAGER-(Q)` has two book items, `HOK-1013 (Q)` (main supplier 400-O002, Ohana)
and `NB-LSD013 (Q)` (400-N002, NB Furniture), neither recorded against 400-H004,
so without a binding it refuses as ambiguous. The Hookka binding in
`scm.supplier_material_bindings` carries `supplier_sku = '1013-(Q)'` and a NULL
`ac_item_code`, while the Ohana binding of the same item carries
`ac_item_code = 'HOK-1013 (Q)'`. Run locally with the real resolver: supplier
400-H004 and binding `1013-(Q)` refuses exactly as production did; binding
`HOK-1013 (Q)` resolves (`via: binding`). The same holds for `CODY-(K)` ->
`HOK-1007 (K)` and `CELENE (A)-(K)` -> `HOK-2038 (A) (K)`.

`seed-ac-item-code.mjs`, which fills `ac_item_code`, refused these rows on
purpose on 2026-08-25: choosing between Ohana's and NB's item "is a business
fact about who makes the item". The owner has since stated that fact — the HOK
series bound to both Hookka and Ohana with Hookka main (2026-08-28,
`docs/ac-reimport-2026-08-28-ledger.md`), and 「Ohana 跟 Hookka，所以跟 Hookka
Manufacturing 其实是一样的」 (2026-09-12) — and the seeder was never taught it.
Measured read-only 2026-09-14: of 285 company-1 bindings for 400-H004, 149 carry
a HOK `ac_item_code`, 5 carry another code and 131 carry none.

**Fix.** Rule R4 in `backend/scripts/seed-ac-item-code.mjs`: when an ERP code
maps to several book items, none recorded against the binding's supplier, and
exactly one recorded against a supplier in the same owner-declared factory
group (company 1: 400-H003, 400-H004, 400-O002), that item is the answer. The
group lives in one constant with the ruling cited beside it. Plan run locally
against production: R4 would seed 104 rows (Hookka 400-H003 and 400-H004
bindings), alongside 44 rows the existing R1-R3 now decide; 1,010 rows stay NULL
for a person. Apply runs through the existing *seed-ac-item-code* workflow,
which writes only where `ac_item_code` is NULL and verifies on a fresh
connection.

**Not fixed here.** The refused edits of the three orders need queueing again
once the codes are in. Separately, and not changed: 400-H004 is HAO HUA
FURNITURE by name in the book, the arrangement the 2026-08-28 ruling accepted.

**Ref.** fix/ac-item-code-same-factory, 2026-09-14.

## A sofa added to or edited on an existing Sales Order kept the request's item_group, so it lost hard binding and read SHORT in MRP with its purchase order open [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** The shape of docs/bugs/0813 (owner, 2026-09-11: *"SO-013389 this
already have PO-010087, please update it"* — an open, linked purchase order
that MRP still reported SHORT because the line's `item_group` was `others`
instead of `sofa`). 0813 traced and closed the PURCHASE-ORDER convert door. The
2026-09-12 foundation audit found the same hole on the document every other
one copies from: the Sales Order's own add-item and edit doors.

**Root cause (traced).** `item_group` is an input to the stock bucket and to
hard binding (`lib/sku-category.ts` header; `isHardBoundLine` in
`lib/so-stock-allocation.ts`; `isDedicated` in `routes/mrp.ts`). The rule
docs/bugs/0514 installed — the SKU master decides the group, the request is a
fallback — stood at nine doors (PO create / add-item / convert, GRN create /
add-line, DO add-line, consignment x2, SO create at
`routes/mfg-sales-orders.ts:4305`) and at none of these two:

- `POST /:docNo/items` wrote `item_group: it.itemGroup ?? 'others'` — the
  request body verbatim (`it = await c.req.json()`).
- `PATCH /:docNo/items/:itemId` computed `itemGroupAfter = it.itemGroup !==
  undefined ? String(it.itemGroup) : prev.item_group` and copied
  `['itemGroup', 'item_group']` straight into `updates`.

Both surfaces reach these doors: desktop `vendor/scm/lib/sales-order-queries.ts`
and the phone `mobile/MobileNewSO.tsx`, whose add-item payload sends
`itemGroup: l.itemGroup || "others"` — so an empty group on the phone becomes
`others` on the row. Enumerated from source (grep of the three
`item_group:` writers in the route file); which door wrote any given
production row is not established here, same as 0813 said of its own row.

**Fix.** Both doors now resolve the group through `skuCategoryResolver` — the
same call PO, GRN, DO and consignment make — with the request's value as the
fallback only when the code is not catalogued, and the stored value as the last
resort on PATCH. `item_group` is no longer copied through from the request on
PATCH; it is written only when it actually moves.

Pinned by `backend/tests/soLineItemGroupFollowsSku.test.ts` (light project,
gates the merge): the two handler slices must call `skuCategoryResolver` and
must not contain either caller-wins spelling. **Proved RED on the unfixed
tree** (2 of 3 failing: `expected … to contain 'skuCategoryResolver('`), green
after. `tsc` clean; the two existing SO route source-pin suites still pass
(13 tests).

**What this does NOT do.** Rows already stored with the wrong group are not
repaired here; docs/bugs/0813's dry-run census covers the PO side and the same
shape is owed for `mfg_sales_order_items` (item_group ≠ SKU category on
company-1 sofa lines) before any apply. The eleventh door is now in; the gate
that counts the doors (the audit's G8 parity check) is not yet written.

**Ref.** `fix/so-add-edit-item-group-follows-sku`, 2026-09-12. Foundation
audit handoff: `HANDOFF-2026-09-12-foundation-and-rehearsal.md` (G4a).

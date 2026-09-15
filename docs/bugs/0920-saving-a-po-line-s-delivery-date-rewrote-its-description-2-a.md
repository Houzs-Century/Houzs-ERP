## Saving a PO line's delivery date rewrote its Description 2 and sent that to AutoCount [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Found while building the PO line import (owner ruling 2026-09-15,
which makes Item Description 2 editable from a file): an imported Description 2
would be erased by the next ordinary edit of that line on the PO screen.

**Root cause (traced).** `PATCH /mfg-purchase-orders/:id/items/:itemId`
(`backend/src/scm/routes/mfg-purchase-orders.ts`) set
`updates.description2 = buildVariantSummary(itemGroup, variants) || null` on EVERY
call. The desktop editor (`PurchaseOrderDetail.tsx` `handleSave`) sends the whole
line, `variants` included, whenever any field of the line changed. So moving a
delivery date replaced the stored Description 2 with a freshly built spec summary,
and for a line with no variants `buildVariantSummary` returns `''`, which the
PATCH stores as NULL. The PATCH then queues the AutoCount edit, and
`PO_ITEM_COLS` (`autocount-outbox.ts`) carries `description2` as `Desc2`.

Measured on production, read-only, 2026-09-15 (DSN project
`anogrigyjbduyzclzjgn`): 1,525 PO lines carry a Description 2; 124 of them have no
variants, 35 of those sit on a DRAFT/SUBMITTED PO with no live Goods Receipt, so
a date or remark save on any of the 35 would blank it. `entity_audit_log` holds
42 "Line edited" rows on purchase orders between 2026-07-29 and 2026-09-14.
Whether any of those 42 blanked a Description 2 is UNKNOWN: the audit does not
record `description2` (`PO_LINE_AUDIT_FIELDS` leaves it out as "server-owned").

**Fix.** Description 2 is re-derived only when `item_group` or `variants`
actually changes (`backend/src/scm/lib/po-line-description2.ts`,
`description2InputsChanged`; key order and `{}` vs NULL do not count as a change).
A save that moves neither keeps the stored text. Pinned in
`po-line-description2.test.ts`, proved RED by forcing the function to `true` (the
old behaviour): 3 of its 4 tests failed.

**Ref.** feat/po-line-import, 2026-09-15.

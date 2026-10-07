# Stock Adjustment

Manual stock correction (found stock, recount, damage, write-off) as a numbered document: `scm.stock_adjustments` (header, one warehouse) + `scm.stock_adjustment_lines` (the current lines). Number `<prefix>SA-YYMM-NNN` (`HC-SA-2610-001`), minted through the doc-number counter. Posted on create; there is no draft and no cancel.

## Statuses and flow

- `POST /inventory/adjustments` `{ warehouseId, notes?, lines: [...] }` mints the number, inserts header + lines, and writes one signed `ADJUSTMENT` movement per line in ONE insert statement, so a failure moves nothing (the header and lines are then deleted). Found stock (+) is inserted before write-offs (-).
- The pre-document single-row body (`{ itemCode, qtyDelta, ... }`) is still accepted as a one-line document.
- `PATCH /inventory/adjustments/:id` `{ notes?, lines? }`. `lines` is a FULL replace. Per (item, variant_key, batch_no) bucket the route compares the new net with what the document's movements already moved, and writes ONE signed `ADJUSTMENT` for each bucket whose net changed. A bucket that is unchanged gets no movement, so a reason or notes fix moves no stock.
- `GET /inventory/adjustments` (list with lines) and `GET /inventory/adjustments/:id`.
- Pages: `/scm/stock-adjustments` (one row per document), `/:id` (detail, History, Edit), `/:id/edit` (the New form seeded from the saved lines), `/new`.

## Permissions

- Everything under `/inventory/adjustments/*` is gated on `scm.warehouse.adjustments`, NOT `scm.warehouse.inventory`. The router is mounted before the broad `/inventory/*` guard; its guard must stay a wildcard or `/:id` would be unguarded.

## Rules that must not break

- Every movement carries `source_doc_type = 'ADJUSTMENT'`, `source_doc_id = header id`, `source_doc_no = adjustment_no`. What a document has moved is read from those movements, never from its lines.
- A write-off (or an edit that lowers a bucket) may not take out more than the bucket's open qty: 422 on create, 409 on edit, nothing written. A null batch means un-batched lots only.
- Found stock never enters at RM0: operator cost, else (on an edit that puts written-off stock back) the cost it was written off at, else the bucket's lot cost; no basis at all = 422 `cost_required`.
- A sofa / bedframe increase needs its variant axes (and sofa a batch). On edit only a bucket that changes is gated, so an untouched legacy line never blocks a notes fix.
- The warehouse is fixed once saved.
- Every create and edit writes an `INVENTORY_ADJUSTMENT` audit row (`lines`, `lineCount`, `netQty`, `notes`; edit adds a note naming each bucket corrected).

## Gotchas

- DO-cancel and DR-resync add-backs also use `source_doc_type = 'ADJUSTMENT'` but carry their DO / DR id and number. Only an `SA-`numbered row links to an adjustment page (`stock-adjustment-link.ts`).
- Documents created before 2026-10-07 were backfilled one per old movement; their header id IS the movement id, which keeps their older audit rows on the right document.
- An edited line keeps the variant_key it is stored under unless its SKU or variants change, so a legacy line whose key would recompute differently does not read as a new bucket.
- The New form sends no idempotency key.

## Where the code is

- `backend/src/scm/routes/inventory-adjustments.ts` — API surface.
- `backend/src/scm/lib/stock-adjustment-doc.ts` — line parsing and per-bucket deltas (pure).
- `backend/src/db/migrations-pg/20261007T1100_scm_stock_adjustments.sql`, `20261007T1110_scm_stock_adjustments_backfill.sql`.
- `frontend/src/pages/scm-v2/StockAdjustments.tsx`, `StockAdjustmentDetail.tsx`, `StockAdjustmentNew.tsx` (New + Edit).

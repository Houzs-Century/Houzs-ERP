# Stock Transfer

Warehouse-to-warehouse stock movement — `scm.stock_transfers` + `scm.stock_transfer_lines`. POSTED on create -> CANCELLED. There is no draft stage. `PATCH /:id` edits header Notes at any status; editing items (SKU/variant/qty/line notes) is POSTED-only and reverses + re-applies the movements. The warehouse pair itself is never editable — cancel and re-create for that.

## Statuses and flow

- `POST /stock-transfers` creates AND posts in one call — mints the doc number, inserts the header as `POSTED`, inserts lines, writes the movements. A `DRAFT` request is explicitly refused.
- `PATCH /:id/post` is a back-compat idempotent no-op; a non-posted row 409s.
- `PATCH /:id/cancel` moves `POSTED -> CANCELLED` and reverses the paired movements. `DELETE` is disabled — cancel is the only way out.
- `PATCH /:id` body carries two independent things: `notes` (header, any status, plain column write) and `items` (POSTED only — a FULL replace of the line list: SKU/variant/qty/line-notes). An `items` edit reverses every movement the transfer wrote (`reverseMovements`, same helper Cancel uses), replaces the lines, then re-applies via `fn_stock_transfer_apply` — un-post + re-post under the same doc id/number. Every new (item, variant) bucket's requested qty is checked against on-hand at the source warehouse BEFORE anything is written (today's open qty + however much of that same bucket the transfer's OLD lines already took, since reversal returns exactly that) — a bucket that would go negative 409s (`insufficient_stock`) with nothing touched. The warehouse pair itself is not editable.
- After a successful post, the create screen locks (Post button replaced by "Open transfer" / "New stock transfer") — "New" remounts the form rather than navigating or resetting fields, because each create screen mints one idempotency key per mount and a same-route navigation is a router no-op that would let the next, different transfer go out under the first one's key.
- The right-click menu offers only Open, Print and Cancel — no Confirm (the document is POSTED at the moment it's created), no convert/transfer-to (it is the end of its own document chain). The detail page itself has an Edit button (next to History/Print, beside the status pill, and as a row action on the main list) that unlocks Notes and, while POSTED, the line SKU/variant/qty.

## Permissions

- Mounted under the standard SCM warehouse area guard; read and write share one gate.

## Rules that must not break

- The whole transfer's stock movement (every line's paired OUT@source + IN@destination) is written in ONE database transaction (`fn_stock_transfer_apply`) — any failure rolls back the entire transfer; nothing is ever left half-moved.
- The destination lot inherits the source's FIFO cost basis — the function reads back what the OUT's FIFO trigger consumed and opens the IN at that exact unit cost, never a separately guessed one.
- A dye-lot `batch_no` is carried onto a transferred line only when the source bucket sits in a single, unambiguous non-null batch — an ambiguous or unbatched bucket goes through as plain FIFO rather than guessing a batch.
- A failed apply auto-cancels the header (422 `transfer_movements_failed`) — a transfer that did not complete must never be left looking posted.
- Cancel reverses movements rather than deleting them, and is idempotent both by the status-flip gate and by skipping any bucket whose signed net is already zero.
- Both warehouse ids must be proved to belong to the active company before anything is written, on both create and cancel — the FIFO consumer keys on `(warehouse_id, item_code, variant_key)` with no company argument, so an unproven cross-company warehouse id would consume the other company's lots at their cost.
- The printed sheet must never state a money figure — only quantity (labelled TOTAL QTY) — the cost side of a transfer lives only in the movement rows, not on the document.

## Gotchas

- Don't reset a create form's fields and reuse the same route for "start the next one" — mint a fresh mount (and therefore a fresh idempotency key), or the next transfer can replay or collide with the previous one's key.
- An item/qty edit on a POSTED transfer reverses + re-applies ALL of that transfer's lines, not just the one(s) that changed — the availability check and reversal both operate bucket-wide (per item+variant), not per line-id, because `reverseMovements` nets by bucket. A single-line "surgical" edit is not how this works under the hood.
- The warehouse pair is still not editable, ever — only Notes and the line list (SKU/variant/qty/notes). Changing warehouses needs Cancel + a new transfer.
- The printed sheet renders the server's saved rows, not the create/detail page's in-memory draft — a draft's dropped fields (like `variant_key`) are exactly what a warehouse hand-off sheet needs to say, so printing must read from the saved record.
- Stock Adjustment's "New" flow uses the same remount pattern but currently sends no idempotency key at all — don't assume it has the same replay protection as Stock Transfer.

## Where the code is

- `backend/src/scm/routes/stock-transfers.ts` — API surface.
- `backend/src/scm/lib/stock-transfer-atomic.ts` — `buildTransferPayload`.
- `backend/src/db/migrations-pg/0192_scm_stock_transfer_atomic.sql` — `fn_stock_transfer_apply`.
- `frontend/src/pages/scm-v2/StockTransfersListV2.tsx`, `StockTransferNew.tsx`, `StockTransferDetail.tsx` — desktop surfaces.
- `frontend/src/mobile/MobileStockTransferNew.tsx` — mobile create.
- `frontend/src/vendor/scm/lib/stock-transfer-pdf.ts` — printed document.
- `frontend/src/lib/freshMount.tsx` — the remount-for-fresh-idempotency-key helper.

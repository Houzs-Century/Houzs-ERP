# Stock Transfer

Warehouse-to-warehouse stock movement — `scm.stock_transfers` + `scm.stock_transfer_lines`. POSTED on create -> CANCELLED. There is no draft stage and no edit.

## Statuses and flow

- `POST /stock-transfers` creates AND posts in one call — mints the doc number, inserts the header as `POSTED`, inserts lines, writes the movements. A `DRAFT` request is explicitly refused.
- `PATCH /:id/post` is a back-compat idempotent no-op; a non-posted row 409s.
- `PATCH /:id/cancel` moves `POSTED -> CANCELLED` and reverses the paired movements. `DELETE` is disabled — cancel is the only way out.
- After a successful post, the create screen locks (Post button replaced by "Open transfer" / "New stock transfer") — "New" remounts the form rather than navigating or resetting fields, because each create screen mints one idempotency key per mount and a same-route navigation is a router no-op that would let the next, different transfer go out under the first one's key.
- The right-click menu offers only Open, Print and Cancel — no Edit (the detail page is permanently read-only), no Confirm (the document is POSTED at the moment it's created), no convert/transfer-to (it is the end of its own document chain).

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
- The detail page is read-only by design — don't look for an edit route; there isn't one.
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

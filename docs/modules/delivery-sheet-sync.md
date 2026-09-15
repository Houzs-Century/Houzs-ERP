# Delivery Sheet Sync (ERP <-> HC Delivery Updated)

Feeds the dispatch team's working Google Sheet ("HC Delivery Updated": tabs *Delivery Details* = West Malaysia, *EM Order* = Sabah/Sarawak, *SG Order*) from the ERP instead of from AutoCount. Sibling pre-auth intake: `docs/modules/service-case.md`.

## Statuses and flow

- The sheet keys every row on col B (Doc. No.), rows from row 4. A pull writes three column blocks using AutoCount's original field names (so the existing Apps Script and sheet columns did not need to change shape) — a Total/status/customer block, an address/remark block, and an Attention/Sync-Status block.
- Col A (delivery message status) and columns Q..X are team-owned and are NEVER written by a pull — an `onEdit` in the sheet copies A→P and Q→O and marks the row PENDING; the next push sends PENDING rows back to the ERP.
- `GET /so-since?since=&limit=` returns orders modified strictly after `since` (oldest first, page size ≤1000, default 300); the checkpoint (`next_since`) is the last record's `LastModified` and must be stored only after every row of that page has been written.
- `POST /updates` writes back up to 300 rows per call as ONE batched `UPDATE ... FROM (VALUES ...)` statement — a present `Remark4` (including blank) is written, an absent one keeps the ERP's value, and a blank `ExpiryDate` KEEPS the ERP's date rather than nulling it (the prior AutoCount sync nulled text dates on a blank; this leg must not repeat that).
- DRAFT and CANCELLED orders are never sent — a cancelled order's row keeps whatever it last showed in the sheet.

## Permissions

- Both routes are mounted PRE-AUTH and instead check a single shared secret header, `X-Intake-Key` = `SHEET_SYNC_KEY` — no session, no permission key. A wrong key answers 401 after a fixed delay, and 429 after repeated failures from one IP (the same rate-limit shape as the other pre-auth intake endpoints).

## Rules that must not break

- The sheet's `DocNo` must be `COALESCE(linked_ac_docno, doc_no)` — the sheet keys on the AutoCount document number, so a migrated order must be emitted under its AutoCount number (`ErpDocNo` carries the ERP's own number alongside it) or its row duplicates.
- The dispatch date (`SalesExemptionExpiryDate`, sheet col O) must be sourced from `customer_delivery_date`, never from the dead `sales_exemption_expiry` column or from `amended_delivery_date` — this is the specific date the owner chose for this feed.
- `Remark4` (sheet col P) is written back from the sheet's col A, but col A itself must never be written BY the ERP pull — it is the dispatch team's own field.
- `LastModified` must be the greatest of the order's own `updated_at`, its payments' `created_at`, and its delivery orders' `updated_at` — the header timestamp alone misses a large share of updates driven by a new collection.
- A pull must never blank a cell the ERP has no value for — the Apps Script preserves the sheet's existing value for any field the ERP returns as null, so an old migrated row keeps its AutoCount delivery-order number until the ERP actually raises one.
- `TransferTo` must be read from `scm.delivery_orders.do_number` (non-cancelled, comma-joined) — the header's own `transfer_to`/`linked_do_doc_no` columns are unused and always NULL.
- `Total`/`SOUDF_BALANCE` must be computed from `local_total_sen` (and payments), never from the base table's `balance_sen`, which is not the outstanding amount.

## Gotchas

- Until the Apps Script cutover (`reference/ERPDeliverySync.gs` pasted into the live project and armed via `setupErpTriggers()`) has actually run, the sheet still pulls from AutoCount — shipping the backend route alone does not change what the sheet shows.
- Several AutoCount-sourced pulls stay in place for phase 2 (overdue, balance/collection, outstanding-PO / PO-date sync) — this cutover only replaced the delivery-sheet feed, not every sync this sheet or its siblings depend on.
- The AutoCount push of the expiry date (col O → the book's own `SalesExemptionExpiryDate` UDF) stops the moment this cutover is live — the ERP write-back does not send that header field to AutoCount, so AutoCount's own copy of that date will no longer update from this path.

## Where the code is

- `backend/src/routes/deliverySheetSync.ts` — the two pre-auth routes.
- `backend/src/lib/delivery-sheet-feed.ts` — pull SQL, field mapper, parsers.
- `backend/src/lib/intake-company.ts` — shared company resolution (also used by ASSR form intake).
- `reference/ERPDeliverySync.gs`, `reference/GetAutoCountData.gs` — the Apps Script sides (new ERP-fed vs legacy AutoCount-fed).

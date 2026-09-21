# Purchase Invoice

The AP (accounts payable) document billing a supplier for goods received — converted from a GRN, or raised manually — driving what is owed and how it gets paid.

## Statuses and flow

- Creating a purchase invoice does not by itself record an AP liability — a non-draft create must be followed by a separate POST/post call (`usePostPurchaseInvoice`), on both desktop and mobile.
- Scan invoice (desktop list menu + mobile Purchase Invoices camera): photo a supplier invoice → a background job reads it, matches the DO No (grns.delivery_note_ref) then PO No then item code/Article No, and CONVERTS the matching GRN(s) into a DRAFT PI. It NEVER creates a standalone invoice: no GRN match, or no line match, lands a needs-review notice with no document. The DRAFT → POSTED confirm promotes an unchanged scan into the OCR few-shot pool (`notePiScanAccepted`).
- A missing/unset status is treated as OPEN for the line-add lock — the document only closes to new lines on CANCELLED or once a payment lands.
- `piAwaitsPayment`: POSTED or PARTIALLY_PAID, something owed, not held — the same filter the AP Payment page itself uses to decide what it can bill.
- Paid only via an AP Payment voucher (`purpose: SUPPLIER_PAYMENT`) — ticking the invoice, the voucher's approval cycle, then posting settles it through `scm.settle_pi_paid_sen` (clamped to what's owed; refuses a held invoice). There is no direct "mark paid": `PATCH /purchase-invoices/:id/payment` is retired and always answers `409 payment_voucher_required`.

## Permissions

- `scm.procurement.pi`, `edit` or better — required to create or post a PI, add a line, or reach the mobile create / add-line surfaces (`canOperatePurchaseInvoices`).
- Opening the AP Payment button needs `scm.access` (which `*` satisfies) or the `scm.finance.accounting` page grant — a purchasing clerk holding only `scm.procurement.pi` does not see the button.

## Rules that must not break

- `po_unit_price_sen` on a line is a snapshot taken once at insert (server-written only, across all insert paths), never a live join — a later PO amendment must not rewrite an existing invoice line's reference price.
- A line's source PO (`source_po_id`/`source_po_number`) and its PO price must be read from the SAME `purchase_order_items` row — never derive one without the other.
- The line-add lock (`purchaseInvoiceLinesLocked`) is the single shared source for whether the document still accepts new lines — desktop and mobile both call it; don't reimplement it inline.
- The "which prices differ" comparison (a PO price of 0 never counts as differing) lives in one byte-identical file mirrored to frontend and backend — edit both or neither.
- Every read behind the "Bill a GRN" picker and the export is company-scoped, and a failed read must answer a server error, never a silently empty list.
- A GRN carried over from AutoCount (`migrated_no_stock`) is refused by every bill path (`from-grn`, `from-grn-items`, the `?grnId=` draft create, `POST /:id/items`) — its invoice must mirror AutoCount's — EXCEPT a GRN AutoCount never invoiced, which bills like any other, but only when it is on `migrated-receipts-not-invoiced.generated.ts` (`receiptMustMirrorAutoCount`). That allow-list ships empty, so the exemption is inert until the office measures the book.

## Gotchas

- On the phone, PI-from-GRN, foreign currency + exchange rate, freight allocation, and product-option fields are all still desktop-only; the phone's unit price starts blank.
- There is no payment sheet on the phone at all — the footer only names where to record it; don't expect a mobile voucher flow yet.
- The "Bill a Goods-Received Note" picker's search only matches loaded rows — check the response's `truncated` flag rather than assuming the visible list is complete.
- FOC (free) lines show in the Amount cell here (purchase documents have no Discount column) — unlike sales documents, where the same badge sits in the Discount cell. Don't move the badge to match the sales layout.
- The desktop list's Export writes one row per LINE for every document matching the current tab/search/sort — not just the loaded page — in AutoCount's own column layout by default; a sofa line is one ERP piece per row even though AutoCount holds one set line, so quantities and totals differ from the book by design.
- The mobile list has no export and no import — importing is desktop-only by design.

## Where the code is

- `backend/src/scm/routes/purchase-invoices.ts` — main API surface, insert paths, PO price snapshot writer. The from-GRN-items convert logic lives in the off-request core `createDraftPisFromGrnItemsCore` (draft-only, never posts, never books AP) so the OCR scan queue raises the same draft via `createDraftPiFromGrnItems`; the HTTP `/from-grn-items` handler calls the core then auto-posts.
- `backend/src/scm/lib/pi-po-price.ts`, `pi-po-price-rule.ts` — PO price snapshot + diff rule (mirrored to frontend).
- `backend/src/scm/lib/outstanding-grn-lines.ts` — GRN lines still to bill.
- Invoice scanner (OCR slice 5): `backend/src/scm/routes/scan-pi.ts` (enqueue + poll, shares scan_jobs/SCAN_QUEUE with scan-so), `backend/src/scm/lib/pi-scan-extract.ts` (invoice OCR), `pi-scan-match.ts` (DO/PO + item-code matcher, pure + unit-tested), `pi-scan-run.ts` (headless pipeline → `createDraftPiFromGrnItems`). Shared OCR transport is `backend/src/scm/lib/scan-anthropic.ts`. Frontend: `ScanInvoiceModal.tsx` (desktop), `MobileScanInvoice.tsx` (mobile), `pi-scan-jobs.ts` (shared client).
- `backend/src/scm/lib/pi-export-rows.ts` — line-level export.
- `frontend/src/pages/scm-v2/PurchaseInvoiceDetailV2.tsx`, `PurchaseInvoiceDetail.tsx`, `PurchaseInvoiceNew.tsx`, `PurchaseInvoiceFromGrn.tsx` — desktop surfaces.
- `frontend/src/mobile/MobilePurchaseDocNew.tsx`, `MobileLinePoRef.tsx`, `MobileAddLine.tsx` — mobile surfaces.
- `frontend/src/vendor/scm/lib/pi-payment-path.ts` — AP payment routing/permission rule.

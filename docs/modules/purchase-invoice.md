# Purchase Invoice

The AP (accounts payable) document billing a supplier for goods received — converted from a GRN, or raised manually — driving what is owed and how it gets paid.

## Statuses and flow

- Creating a purchase invoice does not by itself record an AP liability — a non-draft create must be followed by a separate POST/post call (`usePostPurchaseInvoice`), on both desktop and mobile.
- A 200 from `PATCH /:id/post` means the invoice is POSTED, not that its AP journal exists: a refused journal (zero total, a product group with no purchase account, a write failure) keeps the post. The answer's `ledger` field says which (`posted: true` with `jeNo`, or `posted: false` with `status` + `reason`; `migrated_source` = AutoCount already booked it). `usePostPurchaseInvoice` raises a dialog for every caller when the journal is missing, and the New-PI screen claims "AP liability recorded" only on `posted: true` (`vendor/scm/lib/pi-ledger-outcome.ts`). Absent on a cancelled invoice or a lost confirm race.
- Scan invoice (desktop list menu + mobile Purchase Invoices camera): photo a supplier invoice → a background job reads it, matches the DO No (grns.delivery_note_ref) then PO No then item code/Article No (the PO No is compared with the receipt's header PO AND the PO of each receipt line, via `purchase_order_item_id` — one receipt can take goods from several POs and its header names only the first; since 2026-11-10, `findAnchorGrns` + `loadPoByPoItem`), and CONVERTS the matching GRN(s) into a DRAFT PI. It NEVER creates a standalone invoice: no GRN match, or no line match, lands a needs-review notice with no document. The DRAFT → POSTED confirm promotes an unchanged scan into the OCR few-shot pool (`notePiScanAccepted`).
- Which receipt lines the item-code matcher sees (owner 2026-11-10, `matchAnchoredLines` in `pi-scan-run.ts`): once the receipt(s) are anchored (by DO No or PO No, unchanged), and the invoice PRINTS a PO, only the unbilled lines whose own PO is that PO are offered first (a line with no PO link counts as the receipt header's PO). Only if none of them matches does the scan fall back to every unbilled line of the receipt(s). So when the same item code is on two POs of one receipt, the draft bills the printed PO's line, not whichever came first. An invoice with no PO printed matches exactly as before. Which tier was used is recorded as `lineTier` (`invoice_po` / `whole_receipt` / null) on the check-first copy (`scan_jobs.review`, jsonb, no migration) and shown on the card as a hint (`lineTierNote`); the headless `/enqueue` path names it in the operator's notice. Still draft-only, still company-scoped.
- A missing/unset status is treated as OPEN for the line-add lock — the document only closes to new lines on CANCELLED or once a payment lands.
- `piAwaitsPayment`: POSTED or PARTIALLY_PAID, something owed, not held — the same filter the AP Payment page itself uses to decide what it can bill.
- Paid only via an AP Payment voucher (`purpose: SUPPLIER_PAYMENT`) — ticking the invoice, the voucher's approval cycle, then posting settles it through `scm.settle_pi_paid_sen` (clamped to what's owed; refuses a held invoice). There is no direct "mark paid": `PATCH /purchase-invoices/:id/payment` is retired and always answers `409 payment_voucher_required`.

## Permissions

- `scm.procurement.pi`, `edit` or better — required to create or post a PI, add a line, or reach the mobile create / add-line surfaces (`canOperatePurchaseInvoices`).
- Opening the AP Payment button needs `scm.access` (which `*` satisfies) or the `scm.finance.accounting` page grant — a purchasing clerk holding only `scm.procurement.pi` does not see the button.

## Rules that must not break

- One supplier bill is owed once: a second non-cancelled PI of the same company + supplier carrying the same `supplier_invoice_ref` (whitespace removed, upper case) is refused `409 duplicate_supplier_bill`, naming the existing invoice, on `POST /`, `PATCH /:id` (when the supplier or the ref changes), `POST /from-grn-items` and the headless scan run (`lib/duplicate-supplier-bill.ts`). The one exception is the scan queue's Create (`/scan-pi/check/create`): it showed "Already billed" (`duplicateOf`) first, so the operator's create-anyway stands (`duplicateBill: 'allow'`). AP invoices carry the same rule within their own `doc_kind`. Existing duplicates: counted by Actions › *Duplicate supplier bill numbers (read-only)*, listed for Finance (with doc numbers and what paid each copy) at Money out › Supplier bills › *Duplicate supplier bills* (`GET /ap-invoices/duplicate-bills`, see `docs/modules/accounting.md`); no unique index yet.
- `po_unit_price_sen` on a line is a snapshot taken once at insert (server-written only, across all insert paths), never a live join — a later PO amendment must not rewrite an existing invoice line's reference price.
- A line's source PO (`source_po_id`/`source_po_number`) and its PO price must be read from the SAME `purchase_order_items` row — never derive one without the other.
- The line-add lock (`purchaseInvoiceLinesLocked`) is the single shared source for whether the document still accepts new lines — desktop and mobile both call it; don't reimplement it inline.
- The "which prices differ" comparison (a PO price of 0 never counts as differing) lives in one byte-identical file mirrored to frontend and backend — edit both or neither.
- Every read behind the "Bill a GRN" picker and the export is company-scoped, and a failed read must answer a server error, never a silently empty list.
- A picker line's PO (`purchaseOrderId` / `poDocNo` on `GET /outstanding-grn-items`) is the line's OWN, resolved through `grn_items.purchase_order_item_id`; a goods receipt can take lines from several POs, so the receipt header's `purchase_order_id` is used only for a line with no PO link. Staff saw every line of HC-GRN-2611-052 labelled with one PO before this (2026-11-09). The PI-from-GRN note heading lists every PO its lines name (`notePoLabel`). Census: `backend/scripts/census-grn-multi-po.mjs` (read-only).
- The invoice HEADER's purchase orders are read off its LINES, never off `purchase_invoices.purchase_order_id` alone (owner 2026-11-10). That column is one FK holding the FIRST receipt's PO, while an invoice can bill lines from several (154 of 1,104 posted GRNs span more than one PO, PR #5496). Each line's `source_po_number` (from `attachGrnLineFacts`, the same value the line card shows as "From PO") is collected by `piPoNumbers` in `frontend/src/vendor/scm/lib/pi-header-pos.ts`; the FK is shown only when no line names a PO. Shown on the desktop detail ("Purchase orders · N", first 3 then "+N more", full list on hover), the list's PO No column (from `GET /list-po-price`, which now also returns `poNumbers` per invoice, built by `piPoNumbersByInvoice` in one batched read), the PDF ("PO Refs", two per printed line) and the phone detail ("POs (N)", full list). Display only: the FK is unchanged.
- A GRN carried over from AutoCount (`migrated_no_stock`) bills into a purchase invoice by hand like any native one — the ERP is the sole book (`AUTOCOUNT_IS_ACTIVE_BOOK = false`, owner 2026-09-22), so `receiptMustMirrorAutoCount` returns false for all. No double-book: the `gr_to_pi` write-back stays suppressed for a migrated source (nothing reaches AutoCount) and the ordinary remaining-qty check still blocks re-billing a GRN the ERP already invoiced. Flip `AUTOCOUNT_IS_ACTIVE_BOOK` back to true to restore the mirror regime, where the `migrated-receipts-not-invoiced.generated.ts` allow-list governs the exceptions.

## Gotchas

- On the phone, PI-from-GRN, foreign currency + exchange rate, freight allocation, and product-option fields are all still desktop-only; the phone's unit price starts blank.
- There is no payment sheet on the phone at all — the footer only names where to record it; don't expect a mobile voucher flow yet.
- The "Bill a Goods-Received Note" picker's search only matches loaded rows — check the response's `truncated` flag rather than assuming the visible list is complete.
- FOC (free) lines show in the Amount cell here (purchase documents have no Discount column) — unlike sales documents, where the same badge sits in the Discount cell. Don't move the badge to match the sales layout.
- The desktop list's Export writes one row per LINE for every document matching the current tab/search/sort — not just the loaded page — in AutoCount's own column layout by default; a sofa line is one ERP piece per row even though AutoCount holds one set line, so quantities and totals differ from the book by design.
- The list ticks several drafts and Confirm (N) posts them in turn through the same `/:id/post`; a refused one stays a draft and the summary names it. Invoice Amount and PO Amount sit side by side, PO Price and PI Price likewise; PO Amount counts only lines with a PO price and says how many. PO Price and PO Amount are screen-only, so the default export stays AutoCount's.
- The mobile list has no export and no import — importing is desktop-only by design.

## Files and photos (`/purchase-invoices/:id/files`)

Since 2026-11-09 (backlog A3, sister Conts-ERP#278) a purchase invoice keeps attached files: the supplier's paperwork, an invoice scan, photos of the goods. Images (JPEG / PNG / WebP) and PDFs, 20 MB each, many per document.

- `POST /:id/files` `{fileName, mime, dataBase64}`, `GET /:id/files` (rows + `locked`), `GET /:id/files/:fileId` (streams), `DELETE /:id/files/:fileId`.
- Write = `edit` on `scm.procurement.pi`, the same `scmAreaGuard` that gates every other write here; the router passes `mayWrite` because this document has no flat permission key.
- `CANCELLED` takes no more files. A file stops being removable once the document is finished: `PARTIALLY_PAID` or `PAID` (money has gone out against it). Not at posting, on purpose.
- Index `scm.purchase_invoice_files` (mig `20261110T0300_scm_flow_doc_files.sql`), bytes in the SLIPS R2 bucket under `purchase-invoice-files/<company>/<doc>/<uuid>.<ext>`. Company-scoped on every read and write.
- UI: the Files card (`FlowDocFilesCard`) on the desktop detail page and on the phone's generic detail screen (`MobileModuleDetail`), both through `vendor/scm/lib/flow-doc-files.ts`.
- Code: `backend/src/scm/routes/flow-doc-files.ts` (one spec per document over `lib/doc-files.ts`). Tests: `backend/tests/flowDocFiles.test.ts`, `frontend/src/vendor/scm/components/FlowDocFilesCard.test.tsx`.

## Where the code is

- `backend/src/scm/routes/purchase-invoices.ts` — main API surface, insert paths, PO price snapshot writer. The from-GRN-items convert logic lives in the off-request core `createDraftPisFromGrnItemsCore` (draft-only, never posts, never books AP) so the OCR scan queue raises the same draft via `createDraftPiFromGrnItems`; the HTTP `/from-grn-items` handler calls the core then auto-posts.
- `backend/src/scm/lib/pi-po-price.ts`, `pi-po-price-rule.ts` — PO price snapshot + diff rule (mirrored to frontend).
- `backend/src/scm/lib/outstanding-grn-lines.ts` — GRN lines still to bill.
- Invoice scanner (OCR slice 5): `backend/src/scm/routes/scan-pi.ts` (enqueue + poll, shares scan_jobs/SCAN_QUEUE with scan-so), `backend/src/scm/lib/pi-scan-extract.ts` (invoice OCR), `pi-scan-match.ts` (DO/PO + item-code matcher, pure + unit-tested), `pi-scan-run.ts` (headless pipeline → `createDraftPiFromGrnItems`). Shared OCR transport is `backend/src/scm/lib/scan-anthropic.ts`. Frontend: `ScanInvoiceModal.tsx` (desktop), `MobileScanInvoice.tsx` (mobile), `pi-scan-jobs.ts` (shared client).
- `backend/src/scm/lib/pi-export-rows.ts` — line-level export.
- `frontend/src/pages/scm-v2/PurchaseInvoiceDetailV2.tsx`, `PurchaseInvoiceDetail.tsx`, `PurchaseInvoiceNew.tsx`, `PurchaseInvoiceFromGrn.tsx` — desktop surfaces.
- `frontend/src/mobile/MobilePurchaseDocNew.tsx`, `MobileLinePoRef.tsx`, `MobileAddLine.tsx` — mobile surfaces.
- `frontend/src/vendor/scm/lib/pi-payment-path.ts` — AP payment routing/permission rule.

## Scan, check, then create (`/scan-pi/check/*`, `routes/scan-pi-check.ts`)

The desktop scan works as for goods receipts (`docs/modules/scan-to-gr.md`; shared handlers in
`routes/scan-check-shared.ts`, modal in `ScanCheckModal.tsx`): a PDF is split into its invoices, each is
read in the background, and waits as an editable copy (`lib/pi-scan-check.ts`) until the operator creates
the drafts or deletes it. Rows bill GRN lines. The supplier resolves by code, then name, then `matchSupplier`
(punctuation and SDN BHD tails aside; only a single fit pre-selects). An unplaced row finds its SKU by our code,
a model prefix taught by any bound size (`1007-(K)` = CODY-(K), so `1007-(Q)` = CODY-(Q); `lib/pi-scan-sku.ts`),
the model name printed plus the printed size, then name heuristics; then its line on the anchored GRNs, else the
supplier's GRN holding most rows, then the oldest, never between two equally good. Rows still untied go to ONE
AI call per invoice (`lib/pi-scan-ai-match.ts`, feature `scan_pi_match`): only high confidence, a listed SKU and
the same size are kept, shown "AI match, please check". All of these arrive `suggested`. Raising
`PI_REVIEW_VERSION` re-matches waiting copies on the next load: tied rows stay, untied rows take the new tie.
PO Amount sums the tied rows ("N lines not matched") and turns red only against the invoice's amount for those rows. Create
is `createDraftPiFromGrnItems`: DRAFT only, from posted GRN lines, at the supplier's printed price (the receipt's when none was read), never over what
is left to bill. A printed price that differs is shown on the row. `duplicateOf` = a non-cancelled PI of the
supplier with that `supplier_invoice_ref`. Codes confirmed are saved in `supplier_scan_codes`, shared with
the delivery-order scanner. Mobile (`MobileScanInvoice`) still uses `/enqueue`.

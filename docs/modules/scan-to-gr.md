# Scan → Goods Receipt (delivery-order OCR)

Photo/scan a supplier **delivery order** → a background job reads it and creates
a **DRAFT Goods Receipt** by **converting the matching open PO line(s)**. The GR
twin of `scan-to-so.md`; read that first for the shared pipeline. This guide
lists only what differs for GR.

## Safety invariants (do not weaken)

- A scan **only ever lands a DRAFT / unposted GRN.** Stock posts later, on the
  operator's DRAFT→POSTED (`PATCH /grns/:id/post`). No OCR read moves stock.
- **Convert, never standalone.** The GRN is created from PO line(s) via
  `createDraftGrnFromPoItems` (`lib/grn-from-po-core.ts`), so PO outstanding
  clears. A standalone GRN is never fabricated.
- **Never a wrong link.** If the matcher cannot confidently resolve the PO
  line(s), **nothing is created** — the job lands *needs-review* (status `done`,
  `linked_doc_no` null, slip retained, a plain note) and the operator receives
  from the PO by hand.

## Endpoints (`/scan-gr/*`, gated `scm.procurement.grn`, writeLevel `view`)

| Route | Purpose |
| --- | --- |
| `POST /scan-gr/enqueue` | multipart, repeated `file` (delivery-order pages). Stores photos to R2, inserts a `scan_jobs` row `document_type='GR'`, queues it, returns `202 {job_id}`. |
| `GET /scan-gr/jobs` | latest 20 GR jobs for the active company. |
| `GET /scan-gr/jobs/:id` | poll one job. |
| `POST /scan-gr/jobs/clear-failed` | delete this company's terminal `error` GR rows. |
| `GET /scan-gr/slip-image?key=scan-slips/<id>` | serve the stored delivery-order photo (R2 proxy, `scan-slips/` prefix guard). |

## Pipeline (`routes/scan-gr.ts`)

`runGrnScanJob`: OCR → sample → match → convert.
1. `callClaudeGrExtract` (`lib/grn-scan-extract.ts`) — delivery-order prompt;
   extracts supplier, `poNo`, `doNo`, `deliveryDate`, and lines (item code /
   Article No / barcode, description, qty). Few-shot from prior GR samples.
2. `insertGrnScanSample` writes `so_scan_samples` `document_type='GR'`.
3. `matchGrnScanToPoLines` (`lib/grn-scan-match.ts`, **pure**) over open PO lines
   + supplier bindings (`lib/grn-scan-load.ts`).
4. Confident picks → `createDraftGrnFromPoItems` → stamp `scan_jobs.linked_doc_no`
   with the GRN number. No picks → needs-review (no doc).

**Queue routing:** the SO consumer (`processScanQueueMessage`) reads
`document_type` and delegates `'GR'` to `processGrnScanQueueMessage` (one-way
import, no cycle). The SO reaper is scoped `document_type='SO'`; GR has its own
`document_type='GR'` reaper on the GR poll endpoints, so the two never touch each
other's rows.

## Matcher (`lib/grn-scan-match.ts`) — how confidence is decided

Match order: **PO number first, then item code / barcode.**
- The scanned `poNo` (e.g. `PO-010070`) is normalised (uppercase, strip non-alnum)
  and compared to our `po_number` (`HC-PO-…` / `2990-PO-…`). A hit **scopes**
  matching to that PO. Supplier-printed PO numbers usually differ from ours, so
  this often misses and matching falls to item code.
- A scanned line resolves to our item code via: its own printed code (direct),
  or `supplier_material_bindings.supplier_sku` / `ac_item_code` → `item_code`, or
  a PO line's own `supplier_sku`. (Suppliers print `AMN-SF9050 SOFA 2B(RHF)`; we
  store `9050-2B(RHF)`.)
- A scanned line becomes a **pick only when it resolves to EXACTLY ONE open PO
  line.** Zero → `no_open_po_line`; many → `ambiguous`; both leave it unmatched
  (never guessed). Qty is clamped to the PO line's remaining.

**Outcomes:** ≥1 pick → DRAFT GRN(s) linked to the source PO(s), any unmatched
lines noted for the operator to add. 0 picks (or convert refused, e.g. an
over-receipt race) → needs-review, no document.

## Learning (`lib/grn-scan-review.ts`)

`noteGrnScanAccepted(svc, grnNumber)` fires from `grns.ts` `postGrnHandler` on
DRAFT→POSTED. It finds the GR `scan_jobs` row by `linked_doc_no`, then promotes
its `so_scan_samples` row `EXTRACTED → ACCEPTED` (feeds the GR few-shot pool).
It **only ever marks ACCEPTED** — no rebuilt-correction blob like SO — because
the sample is the supplier delivery order (supplier codes), while the GRN lines
are our codes carried from the PO; there is nothing faithfully invertible, so
reading GRN lines back would manufacture a rule nobody wrote. Best-effort;
never blocks the post.

## Database

No new migration. Uses `document_type` + `linked_doc_no` on `scan_jobs` and
`document_type` on `so_scan_samples` (migration `20260919T1000`, slice 1). GR
jobs write `linked_doc_no` only (never `so_doc_no`).

## Frontend (desktop + mobile, one product)

- Desktop: `GoodsReceivedListV2.tsx` "Scan Delivery Order" secondary action →
  `ScanGrnModal` (`vendor/scm/components/ScanGrnModal.tsx`).
- Mobile: `MobileModuleList` scan icon (wired for `grns` in `MobileApp.tsx`) →
  `MobileGrnScan` (`mobile/MobileGrnScan.tsx`).
- Both reuse `vendor/scm/lib/scan-jobs.ts` (+ `linkedDocNo`) and `authedFetch`.

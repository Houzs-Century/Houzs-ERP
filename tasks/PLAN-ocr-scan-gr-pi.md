# OCR scan → convert to GR / Purchase Invoice — build plan

Owner opted in 2026-09-19 to the FULL pipeline (option A) for BOTH Goods Receipt and
Purchase Invoice, built as a series of PRs. This doc is the design authority so the
slices stay coherent and the work is handoff-safe.

## Owner requirements (verbatim intent)
- Take a photo / scan a supplier document → auto-create the document, like the Sales
  Order scanner: background queue, always lands a draft, self-learning.
- **Convert, never create standalone.** A GR MUST convert FROM its PO(s); a PI MUST
  convert FROM its GR(s). Otherwise the PO/GR sits outstanding and the owner thinks he
  never received the goods.
- Support **multiple PO → one GR** and **multiple GR → one invoice (PI)**.
- Both GR and PI.

## Source documents (from the DIGLANT samples the owner sent)
- **Delivery Order** (source for GR): carries `P.O. No` (e.g. `PO-010070`), `D.O. No`,
  SKU / Article No / Barcode, Descriptions, Quantity. Computer-generated, clean text.
- **Invoice** (source for PI): carries `PO No` + `DO No`, Item Code / Article No,
  Quantity, Unit Price, Sales Tax, Total.
- **Credit Note**: references an invoice. OUT OF SCOPE for now (future extension).

## What is REUSED from the SO scanner (backend/src/scm/routes/scan-so.ts,
## lib/scan-sample-review.ts, docs/modules/scan-to-so.md)
- OCR transport: `anthropicFetchWithRetry`, `callClaudeSlipExtract`, `parseScanFiles`,
  `stripJsonFences`, `toBase64`, prompt-cache mechanics (`buildCachedPrefix`).
- Infra: R2 bucket `houzs-erp` (binding `SO_ITEM_PHOTOS`), Cloudflare queue `SCAN_QUEUE`,
  `scan_jobs` lifecycle + `reapStaleScanJobs`, `storeScanImages`, `GET /slip-image`.
  Secret already set: `ANTHROPIC_API_KEY` (metered — each scan is one Claude vision call).
- Learning framework: `so_scan_samples` / `so_scan_rules`, few-shot injection at extract
  time, the `noteScanDraftAccepted` DRAFT→CONFIRMED trigger (the ONLY live learning writer
  today; the frontend `/samples/:id/confirm` path is built-but-dead — we wire ours right).

## What is NEW per document type
- **OCR prompt** — delivery-order-shaped for GR (supplier, PO No, item code/barcode, qty);
  invoice-shaped for PI (supplier, PO/DO No, item code, qty, unit price, tax).
- **Matcher** — scanned PO No + item code/barcode + qty → our OPEN PO lines (GR) / our
  OPEN GR lines (PI). Match on PO/GR number first, then item code/barcode. It must FAIL to
  "needs review" (a shell draft the operator completes) rather than guess a wrong link.
- **Server-callable convert core** — extracted from the request-bound handlers so the queue
  consumer can call it without an HTTP context:
  - `createDraftGrnFromPoItems(env, {...})` from `createGrnsFromPoItemsHandler` (grns.ts).
  - `createDraftPiFromGrnItems(env, {...})` from `createPurchaseInvoicesFromGrnItemsHandler`
    (purchase-invoices.ts).
- **Learning writer** — `noteGrnScanAccepted` / `notePiScanAccepted`, keyed to the GR/PI
  document + its audit log, fired on the draft→posted / draft→submitted transition.

## Database
- `scm.scan_jobs`: add `document_type text NOT NULL DEFAULT 'SO'` and a generic linked-doc
  column (reuse `so_doc_no` semantics via a `linked_doc_no`, or add `grn_doc_no`/`pi_doc_no`).
- `scm.so_scan_samples` / `scm.so_scan_rules`: add `document_type` (share ONE pool, default
  'SO') so learning is per doc type. Migrations in `backend/src/db/migrations-pg/`, each with
  `-- REVERSAL:`.

## Money / stock SAFETY (non-negotiable)
- A scan ONLY ever creates a **DRAFT / unposted** GRN or PI. A GRN posts stock only on the
  DRAFT→POSTED step; a PI is reviewed before it books AP. No OCR read moves stock or books
  money. (Mirrors SO's "always lands a DRAFT".)
- **Convert, never create standalone** — always link to the source PO/GRN so outstanding
  clears. If the matcher cannot confidently find the PO/GRN, it produces a *needs-review*
  draft, never a fabricated standalone document, and never a wrong link.

## Slices (one PR each, each DRAFT-safe and independently shippable)
1. **DB + pipeline generalization** — `document_type` on scan tables; route the shared
   pipeline by doc type. SO behavior byte-unchanged (document_type='SO' default). No new
   user-facing behavior yet.
2. **GR convert core** — extract `createDraftGrnFromPoItems(env, …)`; unit tests; the route
   handler calls the same core (no behavior change to the existing UI convert).
3. **GR scan** — GR prompt + matcher + enqueue/queue/runScanJob → DRAFT GRN via convert +
   `noteGrnScanAccepted` learning + GR-list "Scan" entry + mobile scanner.
4. **PI convert core** — extract `createDraftPiFromGrnItems(env, …)`; unit tests.
5. **PI scan** — PI prompt + matcher + queue → DRAFT PI via convert + `notePiScanAccepted`
   learning + PI-list "Scan" entry + mobile scanner.

## Open questions to confirm with the owner as slices land
- The scanned supplier "PO No" (e.g. `PO-010070`) maps to our PO doc number — confirm the
  exact prefix/format match (our POs read `HC-PO-…` / `PO-0…`).
- Matching by barcode vs our internal item code (the supplier's Article No differs from our
  SKU code) — the matcher may need the supplier_material_bindings / supplier_sku map.

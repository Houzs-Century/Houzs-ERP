# Scan to Sales Order (OCR)

A phone photo of a handwritten showroom slip becomes a DRAFT Sales Order in
the background; the operator's corrections train the next scan for that rep.
Used by Sales reps (mobile, primary) and office staff (desktop batch modal).
Lives in the `scm` Postgres schema, reached under `/api/scm/scan-so/*`.

## Statuses and flow

- `scm.scan_jobs.status`: `queued → running → done | error`. A job stuck
  queued/running past 3 minutes is re-run once from its stored photos
  (reaper), then errors if the retry also stalls.
- `scm.so_scan_samples.status` (free text, no CHECK constraint):
  `EXTRACTED` (unreviewed) → `CONFIRMED` (operator changed something — the
  stored value means *corrected*, constant name `SAMPLE_CORRECTED`) or
  `ACCEPTED` (reviewed, taken as-is); `FAILED` (extraction errored).
- The learning verdict is recorded when the created DRAFT Sales Order is
  itself confirmed (`DRAFT → CONFIRMED` status transition,
  `noteScanDraftAccepted`) — not by a dedicated review screen; see Gotchas.
- Pipeline: `POST /enqueue` → duplicate probe → photos to R2 → `scan_jobs`
  row → dispatched on a Cloudflare Queue → `runScanJob` extracts, creates the
  DRAFT SO via the shared `createDraftSalesOrder` core, records any receipt
  payments, posts a private completion notice to the scanning rep.
- The pipeline carries a `document_type` (`scm.scan_jobs` / `so_scan_samples` /
  `so_scan_rules`, default `SO`) so the same queue serves the Goods Receipt and
  Purchase Invoice scanners; the SO path threads `SO` explicitly and writes
  `linked_doc_no` alongside `so_doc_no`. See `lib/scan-document-type.ts` and
  `tasks/PLAN-ocr-scan-gr-pi.md`.

## Permissions

- `scmAreaGuard("scm.sales.orders", { writeLevel: "view" })` on all of
  `/scan-so/*` — deliberately `view`, not `edit`: these POSTs only stage
  uploads and background OCR producing the caller's OWN draft, never mutate
  an existing SO, so a view-level rep (Sales Executive) can use the phone
  scan flow.
- Read scope is thin above the area guard: `GET /jobs` is company-scoped
  only (`?salesperson=` is a client filter, not a gate); `GET /jobs/:id` has
  **no** company or owner filter (any admitted caller, cross-company);
  `/slip-image` only checks the R2 key prefix; `/rules/:salesperson` (read or
  distill) has no owner/admin check; `/samples/:id/confirm` has no ownership
  check. None of this leaks order content (payload is status/doc-no/image
  keys) but do not assume per-rep or cross-company isolation here.
- `clear-failed`: a rep clears only their own failed rows; `*` clears the
  whole active company's.

## Rules that must not break

- The learning pool has two different readers with different needs: the
  **distillers** mine only `status = CONFIRMED` (the diff teaches the
  rules); the **few-shot pool** ranks (never filters) on `corrected IS NOT
  NULL`, so a zero-diff `ACCEPTED` sample still teaches the few-shot pool
  even though it teaches the distillers nothing.
- Never invent an unread field — an unreadable value is `null`, rendered as
  "unreadable — will need typing", never a guessed default like RM 0.00.
- Line pairing (`alignSoLinesToSlip`) refuses to guess across an
  unequal-length gap between anchored lines — a wrong pair is worse than no
  pair, so the line keeps the operator's own code/qty with no slip
  provenance rather than risk mis-teaching a handwriting→SKU mapping.
- Fields in `CARRIED_NOT_INVERTED` must never be reverse-mapped into
  `corrected` — they are lossy, derived, or overwritten downstream, and
  re-stamping them manufactures a fake diff that teaches a wrong rule.
- Duplicate rule **A** (same image SHA within 30 days, already minted an SO)
  is a synchronous hard `409` at `/enqueue` unless `force=1`; duplicate rule
  **B** (same phone + ref, or same phone + slip date + total) only stamps
  `duplicate_of` and still creates the draft. Do not swap which one blocks.
- The SO note is never prefixed with the duplicate warning — the signal
  rides `scan_jobs.duplicate_of` and the private notice only.
- Dispatch goes through the Cloudflare Queue (`SCAN_QUEUE`); `waitUntil` is a
  fallback only for an unbound runtime — Workers evicts the isolate on a
  60-110s OCR call, which is what stuck jobs `running` forever under the old
  design.
- Salesperson attribution on write is never caller-trusted —
  `resolveScanUploaderStaffId` reads the authed session, never the request
  body.
- A geocoded postcode/state (when the Maps key is set) is preferred over the
  model's own address parse; postcode is the driver.
- The header deposit is stamped on the DRAFT **only** when a classified
  payment receipt exists in the same scan — never book money off an
  unclassified photo.
- The slip's own date and the SO's Processing Date are different facts; a
  scan DRAFT never carries a Processing Date — do not seed one from the
  other.

## Gotchas

- `processingDate` used to name three unrelated facts (slip date / receipt
  transaction date / the SO's real Processing Date) in one field name —
  current code uses `slipDate`, `receiptTxnDate` and `processingDate`
  distinctly; read the field name literally, not by old habit.
- The interactive review-and-confirm UI path is **dead** — nothing in the
  frontend reaches `POST /samples/:id/confirm` today. The only live learning
  writer is the DRAFT→CONFIRMED SO status transition
  (`noteScanDraftAccepted`). Do not assume a review screen exists.
- Distillers fire on `/samples/:id/confirm` (dead), so today a correction
  lands in the few-shot pool immediately but distilled **rules** only
  refresh via the weekly Sunday cron or a manual `/rules/:salesperson/distill`
  call — not per-correction.
- Prompt injection order is global-alias → global-rules → per-rep →
  few-shot, not "personal first" (see `loadPromptInjections`).
- A "manual technique upload" (rep types their own quirks) described in the
  design doc does **not** exist in code — a rep can only teach the scanner by
  correcting it.
- Desktop and mobile must change together for: job shape/poll normalization
  (`scan-jobs.ts`), OCR-result→New-SO-form mapping (`scan-prefill.ts`), image
  compression (`image-compress.ts`), and the known-reps list — each is one
  shared module; do not hand-copy into either shell.

## Where the code is

- `backend/src/scm/routes/scan-so.ts` — the pipeline, prompts, endpoints.
- `frontend/src/vendor/scm/components/ScanOrderModal.tsx` — desktop batch
  scan.
- `frontend/src/mobile/MobileScan.tsx` — mobile scan (primary surface).
- `frontend/src/vendor/scm/lib/scan-jobs.ts` — shared job/poll helper.
- `frontend/src/vendor/scm/lib/scan-prefill.ts` — shared OCR→form mapping.
- `backend/src/scm/lib/scan-sample-review.ts` — the DRAFT→CONFIRMED learning
  feed.
- `backend/src/scm/routes/scan-payment.ts` — sibling: card/receipt OCR
  (extraction-only, no learning).
- `backend/src/scm/routes/scan-lorry-invoice.ts` — sibling: workshop
  quotation/invoice OCR (extraction-only, no learning).

# OCR dashboard (IT)

Page `/ocr`, endpoint `GET /api/admin/ocr?month=YYYY-MM`. IT pages gate (`it.view`, `services/itAccess.ts`). Read-only. Active company only. Desktop only.

Built from `scm.scan_jobs` joined to `scm.so_scan_samples`. No new tracking. Outcome per scan (`services/ocrStats.ts` `classifyScan`):

- Failed: the read itself broke. Job `error`; sample `FAILED`; SO `done` with "The scan could not read..." (blank shell draft).
- Needs review: GR/PI only. `done`, no document made, not in the check queue (no PO / goods receipt matched, wrong company, empty read). Reason = job `error`.
- Discarded: SO draft deleted; GR/PI check-queue scan discarded (`review_state = 'discarded'`).
- Clean / Corrected: SO only, sample `ACCEPTED` / `CONFIRMED` (set when the draft is confirmed).
- Awaiting review: SO sample still `EXTRACTED` (also a confirmed SO edited only in fields the AI does not read); GR/PI waiting in the check queue (`review_state = 'pending'`).
- Imported: GR/PI with a document. Accuracy is not recorded for them: GR marks every posted scan `ACCEPTED`, an edited PI writes nothing.

- Fields read right (SO): per reviewed slip, filled fields the person did not change (`scm/lib/scan-field-accuracy.ts`). Blank on both sides is not counted; a missed or extra line counts each of its fields. Accuracy, Fields read right and field misses count only slips with a draft baseline; without one the pipeline's own changes (phone format) read as edits, so no slip is ever clean.

Gotchas:
- Time = job `created_at` to `updated_at`. A retried job includes the 3 minute stall.
- "Clear failed" hard-deletes error jobs, so cleared failures are not counted.
- The model is the `CLAUDE_MODEL` constant; it is not saved per scan, so there is no per-model split.
- Field misses compare `extracted` to `corrected` key by key. When a line was added or removed, only "Line added/removed" is counted for the lines. A problem scan's card lists each removed and added line; a line pairs only by its unique slip text, so an edited line with no slip text shows as one removed and one added.
- Recent problem scans: one tab per document type (`?problems=SO|GR|PI`), the latest 30 per type. The tab count is the month's full total (failed + needs review + corrected), so it can exceed 30.
- Tapping a problem scan's SO number opens a drawer (`?slip=<scanId>`) with the slip photo the scan read (sample `image_key`) beside its changes; it does not leave for the sales order. GR/PI numbers have no preview.
- Payment, workshop, bill and credit note scans keep no read record and are not on this page.

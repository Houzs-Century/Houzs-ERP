# OCR dashboard (IT)

Page `/ocr`, endpoint `GET /api/admin/ocr?month=YYYY-MM`. IT pages gate (`it.view`, `services/itAccess.ts`). Read-only. Active company only. Desktop only.

Built from `scm.scan_jobs` joined to `scm.so_scan_samples`. No new tracking. Outcome per scan (`services/ocrStats.ts` `classifyScan`):

- Failed: job `error`; sample `FAILED`; SO `done` with "The scan could not read..." (blank shell draft); GR/PI `done` with no document made.
- Discarded: SO only, the draft SO was deleted.
- Clean / Corrected: SO only, sample `ACCEPTED` / `CONFIRMED` (set when the draft is confirmed).
- Awaiting review: SO sample still `EXTRACTED`. Also covers a confirmed SO edited only in fields the AI does not read.
- Imported: GR/PI with a document. Accuracy is not recorded for them: GR marks every posted scan `ACCEPTED`, an edited PI writes nothing.

Gotchas:
- Time = job `created_at` to `updated_at`. A retried job includes the 3 minute stall.
- "Clear failed" hard-deletes error jobs, so cleared failures are not counted.
- The model is the `CLAUDE_MODEL` constant; it is not saved per scan, so there is no per-model split.
- Field misses compare `extracted` to `corrected` key by key. When a line was added or removed, only "Line added/removed" is reported for the lines.
- Payment, workshop, bill and credit note scans keep no read record and are not on this page.

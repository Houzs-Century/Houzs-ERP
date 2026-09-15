## The amendment requeue planned a second AutoCount edit for approvals that had already queued their own [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** After #3833, approvals of 2026-09-14 08:49-08:58 UTC (HC-SO-012714,
012713, 012442, 011215, 001139, HC-PO-009517, 009540, 009529, 009652, 009952,
009933, 009972, 009872, 2609-068) each queued their edit correctly
(`window_edit=1`, probe run 34826419283), yet the unscoped
`requeue-amendment-ac-edits.mjs` plan listed every one as "would queue". An
unscoped apply would have queued them twice.

**Root cause (traced).** The script counted an edit row as carrying the
amendment only when `o.created_at > d.last_approved_at`. The approve routes call
`enqueueEdit` inside the approval's transaction: `autocount_outbox.created_at` is
`DEFAULT now()`, the TRANSACTION START, while `approved_at` / `so_approved_at` is a
JS timestamp taken later in that transaction — so the approval's own row is
always seconds OLDER than the approval.

**Fix.** The rule lives in `backend/scripts/lib/amendment-requeue-coverage.mjs`
(`coveringEdit`): a `pending` or `sent` edit created at or after
`approved_at - 2 min` covers; `failed` / `skipped` never do. The script reads
the candidate rows and decides in JS. Pinned in
`backend/tests/amendmentRequeueCoverage.test.mjs`: RED on the old rule (3 of 7 —
the in-transaction row for an SO and a PO, and the source anchor), green after.
What the window gives up: an ordinary save committed within two minutes before
an approval that itself queued nothing would read as covering it.

**Ref.** fix/ac-refused-amendment-docs, 2026-09-14.

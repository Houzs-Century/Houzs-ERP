## Imported processing dates landed in the retired column so the order screen showed none [medium]

**Symptom.** The owner opened HC-SO-013097 after the 2026-08-28 re-import:
Processing Date and Delivery Date both blank. The book holds both for that
order (`UDF_PDate` 2026-08-17, line `DeliveryDate` 2026-09-24), and 538 of the
2,756 re-imported orders carry a processing date in the book — none visible.

**Root cause (traced).** Two halves. (1) `import-ac-outstanding-so.mjs` wrote
`UDF_PDate` into **`proceeded_at`** — the column the order screen stopped
reading when migration 0286 made `processing_date` the single home
(`src/scm/shared/so-processing-date.ts`; `mfg-sales-orders.ts:1164` records
that `proceeded_at` "rode along until 2026-08-18 and nothing read it"). The
import script predates the rename and was never moved with it. (2) Delivery
dates were never expected from the import — they come from
`backfill-so-dates.mjs`, which had not run yet this round AND wrote
`proceeded_at` too.

**Fix.** Both scripts now write `processing_date` (the backfill's read, its
three UPDATE arms and its already-set checks all moved; its
TOUCHED_BY_A_PERSON refusal list deliberately KEEPS matching the retired
`proceeded_at`/`proceededAt` names — an audit row written while the date lived
there still marks a human decision). Verified by running the backfill against
production after the merge — the run's own RETURNING counts and the owner's
screen are the evidence (recorded in the round ledger §4c).

**Ref.** fix/so-dates-processing-column, 2026-08-28.

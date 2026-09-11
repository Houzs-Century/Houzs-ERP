## A repair script bound text ids against uuid columns and read two columns that do not exist [medium]

**Symptom.** None yet — both were caught before the scripts ran against
production. That is the only reason this entry is cheap.

**Root cause (traced).** Two shapes only the live database has, in the pair of
scripts added by [0730](0730-twenty-two-migrated-goods-receipts-point-at-no-purchase-orde.md):

1. `backend/scripts/diag-gr-money-gap.mjs` counted a receipt's stock movements
   with `WHERE m.ref_type = 'GRN' AND m.ref_id = g.id`. `scm.inventory_movements`
   has no `ref_type` and no `ref_id`. It names its source `source_doc_type` /
   `source_doc_id` (`backend/scripts/scm-schema/2990s-full-schema.sql`), and
   `backend/src/scm/routes/grns.ts` writes `'GRN'` into the first. The
   diagnostic is the LAST step of its job, so it would have failed the run after
   the plan had already been read — a red run over work that had succeeded.
2. `backend/scripts/repair-gr-po-line-links.mjs` wrote
   `UPDATE scm.grn_items SET purchase_order_item_id = $1 WHERE id = $2` with both
   ids bound as text. The plan file is plain JSON, so both are selected with
   `::text`; the column is `uuid`. The read-back in the same script already cast
   (`ANY($1::uuid[])`) and the write did not — the asymmetry is what made it easy
   to miss.

Neither is reachable from a unit test: one is a column name in a table no test
creates, the other a driver-level type binding. Both were found by opening the
schema the query names instead of trusting that the query was right, which is
what CLAUDE.md means by evidence rather than intention.

**Fix.** The movement count reads `source_doc_type` / `source_doc_id`. The
`UPDATE` casts both ids with `::uuid`, with a comment saying why the plan file
carries them as text.

**Proved by running it, not by reading it.** Plan run
[34268199105](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34268199105)
carried the diagnostic to completion and printed all six receipts; apply run
[34268381590](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34268381590)
wrote 17 of 17 links and read them back clean on a fresh connection.

**The lesson worth keeping.** A repair script's own SQL is production code that
CI never executes. The four release-discipline rules gate what it does to the
data; nothing gates whether its columns exist. Read the schema for every column
a one-shot names, before dispatching it.

**Ref.** fix/gr-po-links-plan-2026-09-09, 2026-09-08.

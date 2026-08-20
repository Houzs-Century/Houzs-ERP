## A migrated DO line carries no item_group, so every DO-side audit filtered itself down to nothing [medium]

**Symptom** - the sofa document chain had never been checked past the purchase
order, and every attempt to check it came back empty rather than clean. A
delivery-order query written the obvious way, `WHERE item_group IN
('sofa','bedframe')`, returns **zero rows** over the entire 2026-08 cutover
corpus. Zero reads as "nothing to worry about", so the DO leg of the chain had
no coverage at all while appearing to have some.

**Root cause (traced, not guessed)** - `create-migrated-documents.mjs:257`
writes a DO line with exactly seven columns: `delivery_order_id`,
`so_item_id`, `item_code`, `description`, `uom`, `qty`, `company_id`.
`item_group`, `variants` and `description2` are never written, so they are NULL
on every migrated DO line. The GRN writer in the same file (`:142`) *does* copy
`item_group` and `variants` from the PO line, which is why the same mistake on
the GRN leg never showed up and why the DO shape was assumed to match. Measured
on prod company 1: item_group NULL on 10 of 10 sofa/bedframe DO lines,
variants NULL on 10 of 10, description2 NULL on 10 of 10. Company 2's 41 DO
lines all carry their own item_group - they were not made by this writer, and
that contrast is what proves the NULLs are the writer's doing rather than the
data's.

**Fix** - `check-sofa-chain-alignment.mjs` classifies a DO line by its own tag,
then by the `item_group` of the SO line its `so_item_id` names, then by
`scm.mfg_products.category` for its `item_code` - the last being the only route
that works for a line whose `so_item_id` is NULL, which is exactly the
population that most needs classifying. The DO leg then reports 10 lines
instead of 0. No data was changed: the NULLs are the migrated writer's shape,
and backfilling them is a separate decision recorded in
`docs/sofa-document-chain-map.md`.

**Lesson** - a filter that returns zero rows is a claim about the data AND a
claim about the column being populated, and only one of those is usually
checked. When a child document is written by a migration script rather than by
the app, read the INSERT's column list before trusting any column in it. The
same audit now prints a per-column NULL census as its first section so the next
reader cannot repeat this.

**Ref** - #1923, chore/sofa-chain-alignment-audit, 2026-08-10

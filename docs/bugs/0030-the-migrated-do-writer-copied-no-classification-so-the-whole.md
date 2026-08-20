## The migrated DO writer copied no classification, so the whole SO -> DO leg audited an empty set [high]

**Symptom** - `check-sofa-chain-alignment.mjs` reported LEG 3 (SO -> DO) as "10
pairs, 0 aligned, 10 carry no variants", and every earlier report filtering
delivery-order lines with `WHERE item_group IN ('sofa','bedframe')` returned
nothing at all and read as clean. Company 2's 41 sofa/bedframe DO lines all
carry their own tag; company 1's carry none.

**Root cause (traced, not guessed)** - `create-migrated-documents.mjs:257`
inserts a delivery-order line with SEVEN columns - `delivery_order_id`,
`so_item_id`, `item_code`, `description`, `uom`, `qty`, `company_id` - and never
`item_group`, `variants` or `description2`. The GRN writer in the SAME FILE
(`:142`) copies `item_group` and `variants` from its PO line, which is exactly
why nobody noticed: one arm of one script was right and the other was silent.
`scm.delivery_order_items` has all three columns - the UI's own writer
(`delivery-orders-mfg.ts:3484`) fills them - so this was never a schema gap.
The contrast with company 2, whose DO lines were not made by this writer, is the
proof that the NULLs are the writer's doing and not drift.

**Fix** - the writer now pulls `item_group`, `variants` and `description2` with
the SO line and writes all three, and `backfill-do-line-snapshot.mjs` fills the
rows it already wrote from their parent SO line (`so_item_id`), because a
delivery order is a SNAPSHOT OF THE SALES ORDER AT DISPATCH. Lines whose
`so_item_id` is NULL are reported and LEFT ALONE - inferring the group from
`mfg_products.category` would work and would also be a guess written into a
snapshot column, indistinguishable from a fact afterwards.

**Lesson** - a child document is a snapshot, so a writer that copies the
quantity and not the classification produces rows that are invisible to every
filter written against the parent's vocabulary. The failure mode is not an
error, it is a zero - and a zero reads as "clean". When two writers in one file
copy different column sets, that asymmetry is the bug.

**Ref** - fix/chain-residue-repair, 2026-08-11

## A compartment correction hard-DELETED two sales-order lines, against the owner's cancel-only rule [medium]

**Symptom** - `HC-SO-012624` and `HC-SO-013167` each hold two live sofa lines
and no cancelled third, while production run 31393696809 logged `removed 2`.
The record that a third piece was ever on either order is gone.

**Root cause (traced, not guessed)** - `apply-sofa-compartment-corrections.mjs`
pairs existing rows to the corrected piece list and DELETEs whatever is left
over (`:182`, `:198-199`). It refuses when a PO, GRN or DO line points at the
surplus row, and it aborts the build if the document total would move, so the
deletion was guarded on money and on references - but not on the owner's rule
`不可以删只可以 cancel`, which arrived after the run. Confirmed against the
DATABASE rather than the log, because a log line is not evidence:
`diag-sofa-cutover-residue.mjs` section E prints both documents' current rows
and finds no cancelled row to recover.

**Fix** - `restore-deleted-so-lines.mjs` reinstates each row CANCELLED at 0
price. `scm.mfg_sales_order_items.cancelled` is `boolean NOT NULL DEFAULT
false`, so no schema change was needed - but `scm.purchase_order_items`,
`scm.grn_items` and `scm.delivery_order_items` have NO `cancelled` column at
all (asked of `information_schema`, section H), so the two arms of that script
are NOT symmetrical and the PO arm cannot simply mirror the SO arm. The restore
snapshots the whole header row as jsonb before and after, inside the same
transaction, compares every key plus the line sums, and ROLLS BACK if anything
moved.

**Lesson** - "no money moved" is not the same as "nothing was lost". A guard
that checks totals and foreign keys still lets a document forget its own
history. And never assume two line tables are symmetrical: ask
`information_schema`, or the second arm dies at 42703 mid-run.

**Ref** - fix/chain-residue-repair, 2026-08-11

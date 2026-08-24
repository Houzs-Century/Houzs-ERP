## The DO code disagrees with itself about a UNIQUE index, and production settled it against the resync path [high]

**Symptom** - two comments in `delivery-orders-mfg.ts` assert opposite facts
about the same index. `deductInventoryForDo` says "the existence check + UNIQUE
index mean this never double-deducts"; `resyncInventoryForDo` says "Migration
0109 dropped the per-bucket UNIQUE so we can freely write multiple delta rows
over time". Both cannot be true. Migration `0230:130-134` enumerates this
table's indexes as `warehouse_id/product_code`, `source_doc_type/source_doc_id`,
`created_at`, `company_id` and calls out that `batch_no` "had no index at all" -
four non-unique indexes, no mention of a unique one - so reading the migration
tree makes the deduction guard look like a bare TOCTOU check.

**Root cause (traced, not guessed)** - the migration tree is not the schema. The
index's DDL is prod-only, ported from 2990, and exists in no file in this repo.
Read live from `pg_indexes` on 2026-08-11 (Actions run 31417585775, the existing
read-only *Duplicate movements check*):

```
CREATE UNIQUE INDEX uq_inv_mov_do_source ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE (source_doc_type = 'DO'::text)
```

Four such indexes are live (`_do_`, `_dr_`, `_cs_do_`, `_cs_dr_`). So the
deduction comment is TRUE and the resync comment is FALSE. Which matters,
because `movement_type` is NOT in that key: one `(DO, product_code,
variant_key)` bucket may hold exactly one movement row of any kind, ever. Every
delta `resyncInventoryForDo` writes for a bucket the first ship already wrote is
a duplicate key, is rejected, and the ledger does not move. The same run
confirms it empirically - zero DO buckets anywhere in production hold more than
one movement row, which is what an enforced index looks like, not what a
"freely write multiple delta rows" design looks like.

What still lands is a delta for a bucket with NO first-ship row: a newly added
line, or an existing line whose recomputed `variant_key` differs from the one it
shipped under. That second case is how the MAKOTO divergence
(`docs/inventory-ledger-divergence-coe.md`) wrote an OUT that consumed no lot -
it got through the index precisely because its key had drifted.

**Fix** - documentation only, deliberately. Every comment that named "migration
0100" / "migration 0109" now carries the live-verified definition and the run id
instead of a migration number that does not exist in this tree;
`resyncInventoryForDo` and the line-delete handler carry an explicit warning
that their delta write is rejected for an already-shipped bucket;
`docs/modules/delivery-order.md` quotes the index verbatim. The ACTUAL defect -
edit-after-ship qty changes never reaching the ledger - is NOT fixed here. It is
an owner-owned, staging-first change to the money-critical FIFO layer, and there
are exactly two shapes (add `movement_type` to the index, or stop the delta rows
reusing the DO source key, which is how the reversal path already solved it with
signed ADJUSTMENT rows). Since 2026-08-05 the rejection is at least logged
rather than silent.

**Lesson** - this repo's own rule, earned twice now: verify schema claims
against the live database, not migration files. The second half of the lesson is
new - when two comments in one file contradict each other about a constraint,
that is not a documentation defect, it is a design that was built on the losing
half.

**Ref** - fix/do-deduct-guard-truth, 2026-08-11 (evidence: Actions run 31417585775)

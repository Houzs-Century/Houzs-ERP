## Editing a SHIPPED delivery order never reached the stock ledger [high]

**Symptom** - silent, and stock. An operator changes a line qty, deletes a line
or adds one on a DO that has already shipped. The document saves, the screen
agrees, the paperwork is right - and inventory does not move. Since 2026-08-05
the failure at least leaves a `RECOUNT_FAILED` audit row instead of nothing.

**Root cause (traced, not guessed)** - `resyncInventoryForDo` writes DELTA
movements into the same `(source_doc_type='DO', source_doc_id, product_code,
variant_key)` bucket the first ship already wrote. Production carries a PARTIAL
UNIQUE index on exactly that key, `uq_inv_mov_do_source`, and `movement_type` is
NOT in it - so one bucket holds exactly ONE row, ever, and every delta is a
duplicate key. `writeMovements` returns `{ ok: false }` and the ledger never
moves.

That index is **prod-only DDL that existed in no file in this repo**, which is
why the comment above the function claimed for months that "migration 0109
dropped the per-bucket UNIQUE so we can freely write multiple delta rows over
time". Read against the migration tree, that was a reasonable belief. Read
against `pg_indexes`, it was false. Measured on production 2026-08-11 (Actions
run 31426819498): **ZERO** movements carry the function's own notes marker - it
had never landed a single row. PR #1941 corrected the comments; the DEFECT was
still open.

**Damage** - 8 `(DO, item)` pairs across **4** delivery orders have a ledger that
disagrees with their document (2990-DO-2607-016/017/018/019), and all 8 are
ORPHAN MOVEMENTS - stock that moved with no line behind it - i.e. the
already-ledgered duplicate-DO pair and the MAKOTO variant drift, not this defect.
A first pass reported 19 DOs; the extra 15 were Houzs Century documents flagged
`migrated_no_stock` (mig 0276) that move no stock BY DESIGN. **No backfill is
needed for this defect**: because every delta was REJECTED rather than
mis-posted, the ledger was never corrupted by it - it simply never followed the
edit. What is lost is unrecoverable-by-code anyway (nobody knows what the pre-fix
edits intended), and nothing must be deleted to repair it.

**Fix** - migration 0279 adds `scm.inventory_movements.correction_seq smallint`
and replaces `uq_inv_mov_do_source` with `uq_inv_mov_do_source_v2`, keyed on
`(..., COALESCE(correction_seq, 0))`. NULL = the document's PRIMARY posting, so
every existing row folds to 0 and the double-post backstop is unchanged; 1..N =
numbered corrections, which now insert. The `COALESCE` is load-bearing - a bare
nullable column in a UNIQUE key would let two NULL first-ship rows coexist and
silently remove the backstop. The migration cannot fail to build: over existing
data the new index is byte-for-byte as strict as the old one, and production has
0 duplicate DO buckets (the 503 that exist are 501 `AC_CUTOVER` + 2
`STOCK_TRANSFER`, neither indexed). The three sibling prod-only indexes (DR /
CS_DO / CS_DR) are recorded in the same file with `IF NOT EXISTS` - a no-op
against production - so the repo stops lying about its own schema.

**Rejected alternatives, and why** - (a) *add `movement_type` to the index*: it
permits exactly one IN and one OUT per bucket, so the operator's SECOND edit is
still rejected. A half-fix on a silent money path is worse than none;
`doResyncCorrectionSeq.pg.test.ts` pins that case. (b) *post the deltas as
`source_doc_type='ADJUSTMENT'`, the way the CANCEL path sidesteps the same
index*: this looks like consistency and is a trap. The whole DO family already
assumes a resync delta IS a `'DO'` row - `restampDoActualCost` nets over `'DO'`,
`fn_reverse_do_out` aggregates `'DO'`, and its step (c) exists SOLELY to close
"phantom lots minted by this DO's OWN delta-IN movements"; `fn_reconcile_uncosted_out`
and `fn_reconcile_dropship_batch` both require `'DO'` before they will cost a
short OUT; and the FIFO trigger copies `source_doc_type` onto every lot and
consumption row. Worst of all, **both** cancel-path idempotency guards
(`reverseInventoryForDo` and `fn_reverse_do_out`'s `v_existing` check) read "an
ADJUSTMENT row exists for this DO id" as "already reversed" - so a DO that had
merely been EDITED could never be CANCELLED: consumptions never deleted, lots
never restored, stock permanently deducted. That is a worse bug than the one
being fixed and it is invisible from the resync function alone.

**Ref** - 2026-08-11, PR #1957 (fix/do-resync-ledger). Comments corrected earlier
in #1941; see the entry below for that.

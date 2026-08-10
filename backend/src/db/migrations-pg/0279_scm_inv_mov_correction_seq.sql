-- ----------------------------------------------------------------------------
-- RE-CHECK NUMBER AT MERGE — parallel PRs; last on main was 0278 when branched.
-- (Money-path / FIFO-costing adjacent: DDL on scm.inventory_movements.)
--
-- 0279 — editing a SHIPPED delivery order can finally reach the stock ledger.
--
-- THE DEFECT
--   resyncInventoryForDo (delivery-orders-mfg.ts) is the edit-after-ship path.
--   When an operator changes a line qty, deletes a line or adds one on a DO that
--   has already shipped, it writes DELTA movements so the booked net OUT matches
--   the live document. Those deltas reuse the DO's own source key.
--
--   Production carries a PARTIAL UNIQUE index on exactly that key:
--
--     CREATE UNIQUE INDEX uq_inv_mov_do_source ON scm.inventory_movements
--       USING btree (source_doc_type, source_doc_id, product_code, variant_key)
--       WHERE (source_doc_type = 'DO'::text)
--
--   movement_type is NOT in it, so one (DO, product, variant) bucket holds
--   exactly ONE row, ever. Every delta on an already-shipped bucket is a
--   duplicate key and is REJECTED; writeMovements returns { ok: false } and the
--   ledger never moves. Read live 2026-08-11 (Actions run 31426819498):
--   ZERO movements in production carry the resync path's own notes marker. It
--   has never landed a single row.
--
--   The index is PROD-ONLY DDL. It appears in no file in this repo, which is why
--   the code comment above resyncInventoryForDo claimed for months that
--   "migration 0109 dropped the per-bucket UNIQUE so we can freely write
--   multiple delta rows over time". Reading the migration tree, that was a
--   reasonable thing to believe. It was false. This file makes all four of them
--   real in the repo so nobody has to believe anything again.
--
-- WHY THE FIX IS AN INDEX CHANGE AND NOT A RE-TARGETED WRITE
--   The obvious alternative — stop the delta rows reusing the DO source key and
--   post them as source_doc_type='ADJUSTMENT', the way the CANCEL path sidesteps
--   the same index — was designed and rejected. The entire DO family is already
--   written on the assumption that a resync delta IS a source_doc_type='DO' row:
--
--     · restampDoActualCost nets OUT − IN over source_doc_type='DO' to derive
--       each line's actual FIFO cost;
--     · fn_reverse_do_out aggregates source_doc_type='DO' AND movement_type IN
--       ('IN','OUT') per bucket to compute what a cancel must give back;
--     · fn_reverse_do_out step (c) exists SOLELY to close "phantom lots minted by
--       this DO's OWN delta-IN movements" and filters mi.source_doc_type='DO';
--     · fn_reconcile_uncosted_out and fn_reconcile_dropship_batch both require
--       source_doc_type='DO' before they will cost a short OUT;
--     · the FIFO trigger COPIES source_doc_type onto every inventory_lot and
--       inventory_lot_consumptions row it creates, so relabelling the movement
--       silently relabels its COGS rows too.
--
--   Worst of all, both cancel-path idempotency guards (this repo's
--   reverseInventoryForDo and fn_reverse_do_out's own v_existing check) treat
--   "an ADJUSTMENT row exists for this DO id" as "this DO was already reversed".
--   A DO that had merely been EDITED would carry such a row, so CANCELLING it
--   would become a silent no-op: consumptions never deleted, lots never
--   restored, stock permanently deducted. That is a worse bug than the one being
--   fixed, and it is not visible from the resync function alone.
--
--   So: leave the rows where every reader already expects them, and make the
--   INDEX admit them.
--
-- THE FIX
--   1. scm.inventory_movements.correction_seq smallint NULL.
--        NULL = the document's PRIMARY posting (the first ship). This is what
--        every existing row is, and what deductInventoryForDo keeps writing.
--        1..N = successive CORRECTIONS to that posting from resyncInventoryForDo.
--   2. uq_inv_mov_do_source is replaced by uq_inv_mov_do_source_v2, which adds
--      COALESCE(correction_seq, 0) to the key.
--
--      COALESCE is load-bearing. A bare correction_seq column in a multi-column
--      UNIQUE index would defeat the whole point: SQL NULLs are distinct from one
--      another, so two first-ship rows (both NULL) would stop conflicting and the
--      double-post backstop would be gone. COALESCE(...,0) folds every primary
--      posting into one slot and keeps that guarantee exactly as strong.
--
--      SAFETY, and it is provable rather than hoped for: every existing row has
--      correction_seq NULL, so COALESCE(correction_seq,0) = 0 for all of them and
--      the new index is byte-for-byte as strict as the old one over existing
--      data. Since uq_inv_mov_do_source exists and is valid TODAY, the new index
--      cannot fail to build. Verified independently against production the same
--      day: 0 duplicate buckets under source_doc_type='DO' (the 503 duplicates
--      that DO exist are 501 AC_CUTOVER + 2 STOCK_TRANSFER, neither of which
--      carries or gains a unique index here).
--
--      The drop and the create are in ONE transaction — pg-migrate owns it — so
--      there is no window in which a DO double-post is unprotected. CONCURRENTLY
--      is deliberately not used for that reason; it cannot run inside a
--      transaction, and a brief lock on a 4.5k-row table is the cheaper risk.
--   3. The three SIBLING prod-only indexes (DR / CS_DO / CS_DR) are recorded here
--      with IF NOT EXISTS. They are UNCHANGED — this is a no-op against
--      production and simply stops the repo lying about its own schema, the same
--      "known recording gap being closed here, not a new column" precedent 0277
--      set for purchase_orders.linked_ac_docno.
--
--      Their paths are NOT given correction_seq: the DR resync already solved the
--      identical collision its own way (delivery-returns.ts posts under
--      source_doc_type='ADJUSTMENT'), and the consignment paths write once.
--      Widening an index nobody needs widened is how the next person inherits a
--      constraint they cannot explain.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*), search_path pinned, no inner
-- BEGIN/COMMIT, IF NOT EXISTS everywhere so the file is idempotent.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. The discriminator.
ALTER TABLE scm.inventory_movements
  ADD COLUMN IF NOT EXISTS correction_seq smallint;

COMMENT ON COLUMN scm.inventory_movements.correction_seq IS
  'NULL = this row is the document''s PRIMARY posting (the first ship / receipt). 1..N = successive CORRECTIONS to that posting, written by resyncInventoryForDo when a line is edited on an already-shipped DO. It exists only to discriminate those rows inside uq_inv_mov_do_source_v2, whose key uses COALESCE(correction_seq, 0) so that every primary posting still folds into ONE slot per (source_doc_type, source_doc_id, product_code, variant_key) and the double-post backstop is unchanged. Do NOT read it as a version number or an ordering guarantee for anything else; the ledger''s order of record is created_at.';

-- 2. Replace the DO index. Same transaction, so the backstop is never absent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_do_source_v2
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key, COALESCE(correction_seq, 0))
  WHERE (source_doc_type = 'DO'::text);

DROP INDEX IF EXISTS scm.uq_inv_mov_do_source;

COMMENT ON INDEX scm.uq_inv_mov_do_source_v2 IS
  'Per-DO idempotency backstop (replaces the prod-only uq_inv_mov_do_source, 0278). One PRIMARY posting per (DO, product, variant) bucket -- correction_seq NULL folds to 0 -- plus one row per numbered correction, so an edit on an already-shipped DO can reach the ledger. A double-post of the first ship is still rejected exactly as before.';

-- 3. Record the three siblings as they already exist in production. UNCHANGED;
--    IF NOT EXISTS makes this a no-op there and real everywhere else.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_dr_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE (source_doc_type = 'DR'::text);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_cs_do_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE (source_doc_type = 'CS_DO'::text);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_cs_dr_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE (source_doc_type = 'CS_DR'::text);

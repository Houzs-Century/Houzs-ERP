-- ----------------------------------------------------------------------------
-- RE-CHECK NUMBER AT MERGE — parallel PRs; last on main was 0320 when renamed
-- (was 0321; the number was taken by the on-hold series while this PR queued).
-- (Money-path / FIFO-costing adjacent: DDL on scm.inventory_movements.)
--
-- 0321 — the purchase-consignment ledger writes get the idempotency backstop
--        every sibling already has (2026-08-21 audit, item A11).
--
-- THE DEFECT
--   0154 declared purchase consignment OFF-LEDGER ("the receive does NOT write
--   inventory_movements ... No uq_inv_mov_* index belongs here") and the code
--   moved ON-LEDGER on 2026-06-05 (purchase-consignment-receives.ts books a
--   PC_RECEIVE IN; purchase-consignment-returns books a PC_RETURN OUT). The
--   index never followed. So while DO / DR / CS_DO / CS_DR each carry a partial
--   unique index that makes a concurrent double-post physically impossible,
--   PC_RECEIVE and PC_RETURN had NOTHING below the route: two concurrent posts
--   (or a client retry behind a Worker timeout) both read "no movements yet"
--   and both booked the full IN — consigned stock double-counted, and the
--   resync's own bare catch discarded the evidence (fixed in the same PR).
--
-- THE SHAPE — copied from 0279's v2 pattern, for the same two reasons:
--   · the resync writes ONE primary posting per (doc, product, variant) bucket
--     and routes every later delta through STOCK_TRANSFER, exactly like the
--     CS_DO/CS_DR template it mirrors — so the 4-column key fits the writer;
--   · COALESCE(correction_seq, 0) is in the key so that HISTORICAL duplicate
--     rows — the very defect this closes may already have minted some — can be
--     numbered and PRESERVED instead of deleted. Deleting a movement row here
--     would silently rewrite on-hand and orphan the FIFO lots the trigger
--     minted off it (0279's header walks that minefield); numbering keeps the
--     ledger append-only and leaves the double-count VISIBLE for a read-only
--     reconciliation, while every FUTURE primary posting still folds into slot
--     0 and collides. correction_seq exists since 0279 with exactly this
--     "index discriminator, nothing else" contract.
--
--   The UPDATE below stamps seq 1..N onto all-but-the-earliest row of any
--   already-duplicated bucket (created_at, id order), so the index build cannot
--   fail against production whatever it holds. On a clean tree it stamps zero
--   rows and is a pure no-op. Idempotent: rows already stamped keep their seq
--   (correction_seq IS NULL predicate), and both CREATEs are IF NOT EXISTS.
--
-- REVERSAL: DROP INDEX IF EXISTS scm.uq_inv_mov_pc_receive_source;
--           DROP INDEX IF EXISTS scm.uq_inv_mov_pc_return_source;
--           UPDATE scm.inventory_movements SET correction_seq = NULL
--             WHERE source_doc_type IN ('PC_RECEIVE','PC_RETURN')
--               AND correction_seq IS NOT NULL;
--           Complete: the stamping UPDATE below is the only writer of
--           correction_seq on PC rows, deletes nothing and moves no
--           quantities, so that predicate re-identifies exactly what it wrote.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*), search_path pinned, no inner
-- BEGIN/COMMIT (pg-migrate owns the transaction), idempotent throughout.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. Number any pre-existing duplicate buckets so the unique index can build.
--    The earliest row per bucket stays NULL (the primary posting); later rows
--    take 1..N. Append-only: nothing is deleted, on-hand does not move.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY source_doc_type, source_doc_id, product_code, variant_key
           ORDER BY created_at, id
         ) - 1 AS seq
  FROM scm.inventory_movements
  WHERE source_doc_type IN ('PC_RECEIVE', 'PC_RETURN')
    AND correction_seq IS NULL
)
UPDATE scm.inventory_movements m
SET correction_seq = ranked.seq
FROM ranked
WHERE m.id = ranked.id
  AND ranked.seq > 0;

-- 2. The backstops. Same key shape as uq_inv_mov_do_source_v2.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_pc_receive_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key, COALESCE(correction_seq, 0))
  WHERE (source_doc_type = 'PC_RECEIVE'::text);

COMMENT ON INDEX scm.uq_inv_mov_pc_receive_source IS
  'Per-receive idempotency backstop (0321): one PRIMARY PC_RECEIVE posting per (receive, product, variant) bucket -- correction_seq NULL folds to 0 -- so a concurrent double-post or timed-out retry is rejected by the database, not merely hoped against in the route. Historical duplicates were preserved under seq 1..N at index creation; they are a finding for reconciliation, not corrections.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_pc_return_source
  ON scm.inventory_movements
  USING btree (source_doc_type, source_doc_id, product_code, variant_key, COALESCE(correction_seq, 0))
  WHERE (source_doc_type = 'PC_RETURN'::text);

COMMENT ON INDEX scm.uq_inv_mov_pc_return_source IS
  'Per-return idempotency backstop (0321) -- the PC_RETURN twin of uq_inv_mov_pc_receive_source; same key, same historical-duplicate preservation.';

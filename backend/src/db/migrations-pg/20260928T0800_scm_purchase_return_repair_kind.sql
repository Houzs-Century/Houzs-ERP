-- ----------------------------------------------------------------------------
-- 20260928T0800 -- a purchase return is either MONEY back or GOODS back.
--
-- WHY. The owner, 2026-09-28: 「purchase return - 是可以退货维修，然后supplier再送
-- 回来 - 这个要怎么做？」. Today `scm.purchase_returns` is a one-way trip that ends
-- in a credit note: it carries credit_note_ref and refund_sen, and COMPLETED
-- means the supplier's credit arrived. Used for a repair it takes the stock out
-- of the books, leaves the document forever "awaiting credit note", and says
-- nothing about goods that are coming BACK.
--
-- So the warehouse does it by hand instead. The `* SERVICE` warehouses --
-- "BALAKONG / PENANG RETURNED TO SUPPLIER FOR SERVICE" -- already exist and are
-- already used: 18 STOCK_TRANSFER movements into and out of KL SERVICE between
-- 2026-09-18 and 2026-09-24, plus 96 ADJUSTMENT/AC_CUTOVER rows carried over
-- from AutoCount. The stock lands in the right place; the supplier, the reason,
-- the date it went and whether it ever came back are recorded nowhere.
--
-- WHAT CHANGES (phase 1 of two; the receive-back leg and repeat rounds follow).
--   1. scm.purchase_returns.kind -- 'CREDIT' (every row today, and the default)
--      or 'REPAIR'. A REPAIR return asks for no credit note: the money side is
--      untouched and its refund_sen stays 0.
--   2. scm.purchase_returns.repair_warehouse_id -- WHERE the goods sit while the
--      supplier has them, as a real warehouse id rather than a naming
--      convention. The route writes the stock OUT of each line's source
--      warehouse and IN to this one, so a repair never makes stock vanish, and
--      "what is at the supplier right now" is an ordinary stock question.
--      NULL on a CREDIT return; required on a REPAIR one (the CHECK below).
--
-- The reason for the return becomes a mandatory CODE at the same time
-- (shared/purchase-return-reasons.ts, one of DAMAGED / WRONG_COLOUR /
-- WRONG_ITEM / OVER_SUPPLY / QUALITY / REPAIR / OTHER), stored in the EXISTING
-- `reason` text column beside the free-text remark in `notes`. No column is
-- added for it and no historical row is rewritten: rows created before this
-- carry free text, and the label helper shows any unrecognised value verbatim.
--
-- REVERSAL:
--   ALTER TABLE scm.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_repair_has_warehouse;
--   ALTER TABLE scm.purchase_returns DROP CONSTRAINT IF EXISTS purchase_returns_kind_chk;
--   ALTER TABLE scm.purchase_returns DROP COLUMN IF EXISTS repair_warehouse_id;
--   ALTER TABLE scm.purchase_returns DROP COLUMN IF EXISTS kind;
--   (No view is dropped or recreated, so no grant is lost. Returns already
--   raised as REPAIR would become ordinary CREDIT returns whose stock sits in a
--   SERVICE warehouse -- the state the hand-made stock transfers leave today.)
--
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-09-28. scm.purchase_returns has 17 columns and neither
--   `kind` nor `repair_warehouse_id`; it does have reason (text, null), notes
--   (text, null), credit_note_ref (text, null) and refund_sen (integer, not
--   null). scm.warehouses holds 25 rows, among them KL SERVICE + PG SERVICE for
--   company 1 (76 and 38 movements) and the same two codes for company 2 (0
--   movements each). Movements into KL/PG SERVICE by source: ADJUSTMENT/
--   AC_CUTOVER 96, STOCK_TRANSFER 18 -- no PURCHASE_RETURN row among them.
-- RE-RUN: ADD COLUMN IF NOT EXISTS throughout, each CHECK added only when
--   pg_constraint has no row for it, COMMENT ON is idempotent.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- -- 1. Money back, or goods back --------------------------------------------
ALTER TABLE scm.purchase_returns ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'CREDIT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'purchase_returns_kind_chk'
       AND conrelid = 'scm.purchase_returns'::regclass
  ) THEN
    ALTER TABLE scm.purchase_returns
      ADD CONSTRAINT purchase_returns_kind_chk
      CHECK (kind IN ('CREDIT', 'REPAIR'));
  END IF;
END
$$;

COMMENT ON COLUMN scm.purchase_returns.kind IS
  'What this return is for (owner 2026-09-28). CREDIT: goods go back for good and the supplier owes a credit note -- every row created before this migration, and the default. REPAIR: goods go to the supplier to be fixed and are expected BACK, so no credit note is chased and the stock moves into repair_warehouse_id instead of leaving the books. The receive-back leg and repeat rounds are phase 2.';

-- -- 2. Where the goods sit while the supplier has them ------------------------
ALTER TABLE scm.purchase_returns
  ADD COLUMN IF NOT EXISTS repair_warehouse_id uuid REFERENCES scm.warehouses(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'purchase_returns_repair_has_warehouse'
       AND conrelid = 'scm.purchase_returns'::regclass
  ) THEN
    /* A repair that does not say where the goods went is the hand-made stock
       transfer all over again: the stock moved and nothing records where to.
       Both directions, so a CREDIT return cannot carry a stray repair location
       either. Every existing row is CREDIT with a NULL, so this holds on day
       one without touching data. */
    ALTER TABLE scm.purchase_returns
      ADD CONSTRAINT purchase_returns_repair_has_warehouse
      CHECK ((kind = 'REPAIR') = (repair_warehouse_id IS NOT NULL));
  END IF;
END
$$;

COMMENT ON COLUMN scm.purchase_returns.repair_warehouse_id IS
  'The warehouse the goods sit in while the supplier repairs them -- in practice one of the `* SERVICE` rows ("RETURNED TO SUPPLIER FOR SERVICE"), but stored as a real id so the destination is data, not a naming convention. The return posts an OUT of each line''s source warehouse and an IN here, so repair stock stays countable and "what is at the supplier" is an ordinary stock question. NOT NULL exactly when kind = REPAIR.';

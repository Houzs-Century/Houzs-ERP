-- ----------------------------------------------------------------------------
-- 0230 — Ship-before-arrival binds its incoming PO, PER LINE.
--
-- THE FACT (owner, 2026-07-31): "Before raising the DO you already know which
-- PO this order matched. When they pick ship-anyway, that matched PO should be
-- bound and go negative against it. Because sofas have batch numbers, when that
-- PO converts to GRN it offsets; when it converts to PI, the costing offsets."
--
-- WHAT WAS WRONG. Binding hung off the drop-ship DIALOG, not off the fact that
-- the line has a resolvable PO:
--   * scm.fn_reconcile_dropship_batch (0057, hardened 0088, enum-fixed 0155)
--     claims an OUT only when the SOURCE DO carries is_dropship = TRUE. That is
--     a HEADER flag, decided all-or-nothing (`body.dropShip === true AND every
--     offending line has a bound PO`), and migration 0057 itself documents the
--     column as driving "the UI badge ONLY". A plain "Ship anyway" therefore
--     left the flag FALSE, so even a batch-stamped OUT was invisible to the
--     reconcile FOREVER.
--   * Measured on prod 2026-07-30/31 (backend/scripts/check-hard-committed-po.mjs):
--     3 short OUTs, ALL is_dropship = N, none carrying batch_no. 0 claimable.
--
-- THE CHANGE. A per-LINE commitment marker, and the two receipt-time reconciles
-- taught to read it. The header flag keeps exactly the meaning 0057 gave it.
--
--   1. scm.delivery_order_items.committed_po_batch_no — "this line shipped
--      before its goods arrived, against THIS incoming PO's batch". Written by
--      the DO ship paths (planShipCommitments in scm/lib/ship-commitment.ts).
--
--   2. fn_reconcile_dropship_batch — the OUT loop now also claims an OUT whose
--      source DO has a line committed to this batch for this product, not only
--      one whose header is flagged. 0088's anti-theft intent is preserved: the
--      point of the is_dropship filter was to keep an ACCIDENTAL uncosted
--      short-ship (the concurrent-DO TOCTOU race) from stealing the arriving
--      lot. A per-line commitment marker is the same deliberate signal, only
--      recorded where the decision is actually made.
--
--   3. fn_reconcile_uncosted_out (0154) — the mirror exclusion, and it is
--      NARROWED TO BATCH-REGIME LINES ONLY. 0154 deliberately skips drop-ship
--      OUTs so the batched path stays the sole owner of batched coverage, and a
--      committed SOFA OUT must be skipped for the SAME reason: costing it from
--      whatever lot is open means another dye lot, the exact colour-mixing the
--      batch regime exists to prevent.
--
--      ⚠ THAT ARGUMENT IS ABOUT DYE LOTS, SO IT STOPS AT THE SOFA. A mattress
--      has no dye lot. Excluding a committed MATTRESS OUT would have created a
--      new way to strand COGS at RM0 FOREVER — strictly worse than the bug this
--      migration exists to fix. The bound PO can die in ways no reconcile can
--      see: it is CANCELLED, the supplier re-ships under a re-raised number, or
--      the goods turn up by inter-warehouse transfer or a stock take. In every
--      one of those, fn_reconcile_dropship_batch never fires for that batch, and
--      an unconditional exclusion would make the batch-agnostic repair step over
--      the OUT for good. Before this migration ANY later stock-IN repaired it
--      (0154, widened to every IN path 2026-07-29).
--
--      So the exclusion keys off delivery_order_items.committed_batch_strict,
--      written at ship time from the SAME isSofa fact the binding decision used
--      (planShipCommitments -> ShipCommitmentDecision.strictBatch). NO product
--      lookup here on purpose: "is this a dye lot?" is decided once, in TypeScript,
--      where detectSofa already lives. A PL/pgSQL re-implementation of that test
--      would be a THIRD copy of it, and the two that drift would disagree about
--      money.
--
--      Net effect per category:
--        · sofa      — bound OUT is batched-path-only, exactly as an is_dropship
--                      sofa OUT has been since 0154. Unchanged.
--        · non-sofa  — bound OUT can be netted by the correct GRN (new, better)
--                      AND still repaired by any later stock-IN (as on main).
--                      Both are idempotent on ABS(qty) - SUM(consumed), and the
--                      GRN post runs the batched reconcile first, so they can
--                      neither double-cost nor race.
--
-- IDEMPOTENT + LEDGER-DRIVEN, unchanged: both functions recompute the shortfall
-- as ABS(out.qty) - SUM(qty_consumed) on every call, so a shipment reconciled
-- once is never double-costed and the app-side MRP deduction that keys off the
-- SAME subtraction falls away by itself.
--
-- !! STAGING-FIRST — same rule as 0154 / 0155. CI pg-migrates PROD on deploy and
--    this touches the money-critical scm FIFO layer. The behaviour is exercised
--    end-to-end against a real postgres:16 in backend/tests-pg/shipCommitment.pg.test.ts
--    (CI job `backend-postgres` -> npm run test:pg), which applies THIS file.
--
-- NO D1 PARITY FILE, deliberately. The D1/test tree has no scm objects at all —
-- grep finds neither delivery_order_items nor inventory_movements anywhere in
-- backend/src/db/migrations/ — so a "parity" file would be an empty stub
-- claiming a mirror that does not exist. 228 pg migrations against 139 D1 files
-- is the standing shape: a D1 twin is written only when D1 actually holds the
-- table (mig 0229 -> 141 did, because projects/project_venues live there).
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned; no
-- inner BEGIN/COMMIT (pg-migrate owns the txn); ADD COLUMN IF NOT EXISTS +
-- CREATE OR REPLACE everywhere so the file is re-runnable; dollar-quoted bodies
-- ($fn$) so scripts/lib/split-sql.mjs keeps the PL/pgSQL intact.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. The per-line commitment marker (additive, idempotent).
ALTER TABLE scm.delivery_order_items
  ADD COLUMN IF NOT EXISTS committed_po_batch_no TEXT;

-- The bucket the commitment was made in. STORED, not recomputed: the inventory
-- variant key is a non-trivial TypeScript function (computeVariantKey, with
-- fabricCode/colorCode/fabricColor and POS depth/sofaLegHeight aliasing), and
-- re-deriving it in PL/pgSQL would be a second implementation of a money-path
-- identity. The ship path already computes it for the short-stock bucket, so it
-- is written here once and only ever COMPARED afterwards.
ALTER TABLE scm.delivery_order_items
  ADD COLUMN IF NOT EXISTS committed_variant_key TEXT;

-- Does the commitment carry a BATCH REGIME (a dye lot that must never be
-- substituted)? See the header: this, and only this, excludes an OUT from the
-- batch-agnostic oversell retro-cost.
ALTER TABLE scm.delivery_order_items
  ADD COLUMN IF NOT EXISTS committed_batch_strict BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN scm.delivery_order_items.committed_po_batch_no IS
  'The incoming purchase-order number (= the batch_no the GRN will stamp) that THIS delivery line was shipped against before the goods arrived. Set at ship time by planShipCommitments (scm/lib/ship-commitment.ts) when the line resolves exactly one LIVE bound PO and has nothing on hand to consume; NULL for a normal ship, an ad-hoc line, or a plain oversell with no PO behind it. It is the per-line claim signal scm.fn_reconcile_dropship_batch reads on receipt, and the reason a mixed DO no longer denies netting to the lines that could have had it. delivery_orders.is_dropship stays what migration 0057 declared it to be: the UI badge.';

COMMENT ON COLUMN scm.delivery_order_items.committed_variant_key IS
  'The inventory variant key (computeVariantKey over the line''s item_group + variants) the commitment was made in, stored at ship time so both reconciles can scope the per-line claim to the SAME (product, variant) bucket the OUT loop is already scoped to. Without it, two lines of one DO carrying the same item_code in DIFFERENT variants could cross-claim each other''s batch. NULL/empty is the unclassified bucket (mattress, accessory), which is what the movement carries too.';

COMMENT ON COLUMN scm.delivery_order_items.committed_batch_strict IS
  'TRUE when the committed batch is a DYE LOT that must never be substituted - i.e. the line is sofa / batch-regime. Written from the same isSofa fact planShipCommitments used to make the binding, so the SQL never re-derives "is this a sofa". It is the ONLY thing that excludes an OUT from scm.fn_reconcile_uncosted_out: a bound MATTRESS has no dye lot, so any later stock-IN must still be able to repair its COGS exactly as it could before migration 0230 - otherwise a cancelled or re-raised PO would strand it at RM0 forever.';

-- Only committed lines are ever looked up, and they are a small minority.
CREATE INDEX IF NOT EXISTS idx_doi_committed_po_batch
  ON scm.delivery_order_items (committed_po_batch_no, item_code)
  WHERE committed_po_batch_no IS NOT NULL;

-- The MRP commitment read filters `movement_type + source_doc_type + batch_no
-- IN (...)`, and it is a HOT path: the MRP page, twice in the SO detail
-- (mfg-sales-orders.ts computeMrp callsites) and /po-so-coverage. batch_no had
-- no index at all - inventory_movements carried only (warehouse_id,
-- product_code), (source_doc_type, source_doc_id), (created_at) and
-- (company_id) - so every one of those reads was a seq scan over the whole
-- movement history. batch_no leads because the IN list is the selective term.
CREATE INDEX IF NOT EXISTS idx_inv_mov_batch_out
  ON scm.inventory_movements (batch_no, movement_type, source_doc_type)
  WHERE batch_no IS NOT NULL;

-- 2. Receipt-time drop-ship reconcile — claim on the HEADER flag OR the per-line
--    commitment. Body identical to 0155 apart from that one EXISTS clause.
CREATE OR REPLACE FUNCTION scm.fn_reconcile_dropship_batch(
  p_warehouse_id  UUID,
  p_product_code  TEXT,
  p_variant_key   TEXT,
  p_batch_no      TEXT,
  p_created_by    UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_out         RECORD;
  v_lot         RECORD;
  v_already     INTEGER;
  v_short       INTEGER;
  v_take        INTEGER;
  v_consumed    INTEGER := 0;
BEGIN
  IF p_batch_no IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_out IN
    SELECT m.id, m.qty, m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type = 'OUT'
       AND m.warehouse_id  = p_warehouse_id
       AND m.product_code  = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.batch_no      = p_batch_no
       AND m.source_doc_type = 'DO'
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
            AND (
              d.is_dropship = TRUE
              OR EXISTS (
                SELECT 1 FROM scm.delivery_order_items di
                 WHERE di.delivery_order_id       = d.id
                   AND di.committed_po_batch_no   = p_batch_no
                   AND di.item_code               = p_product_code
                   /* Scoped to the VARIANT too, for symmetry with the OUT loop
                      above (which is variant-keyed). Two lines of one DO can
                      carry the same item_code in different fabrics; without
                      this they cross-claim each other's batch. */
                   AND COALESCE(di.committed_variant_key, '') = COALESCE(p_variant_key, '')
              )
            )
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND product_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND batch_no     = p_batch_no
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0;
      v_take := LEAST(v_lot.qty_remaining, v_short);

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id;

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, product_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no, v_out.id, p_created_by,
        v_lot.company_id
      );

      v_short    := v_short - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;

    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id;
  END LOOP;

  RETURN v_consumed;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reconcile_dropship_batch(UUID, TEXT, TEXT, TEXT, UUID) IS
  'Receipt-time ship-before-arrival reconcile (0057, hardened 0088, enum-cast 0155, per-line claim 0230). For ONE (warehouse, product, variant, batch) bucket, consumes each COMMITTED OUT movement''s outstanding qty from the batch''s newly-received open lots (FIFO, at the lot''s real cost). An OUT is committed when its source DO is not CANCELLED and either the header carries is_dropship = TRUE (0088) or one of its lines carries committed_po_batch_no = this batch for this product AND THIS VARIANT (0230) - so a plain "Ship anyway" on a line that resolves an incoming PO nets on receipt, and one unresolvable line on a mixed DO no longer denies netting to the rest. An uncosted NORMAL short-ship (concurrent-DO race) still cannot steal the arriving lots: it carries neither signal. Idempotent + ledger-driven.';

-- 3. Oversell retro-cost (0154) — the mirror exclusion. Body identical to 0154
--    apart from the added NOT EXISTS: a line-committed OUT belongs to the
--    batched path above, and must not be costed from an arbitrary dye lot here.
CREATE OR REPLACE FUNCTION scm.fn_reconcile_uncosted_out(
  p_warehouse_id  UUID,
  p_product_code  TEXT,
  p_variant_key   TEXT,
  p_before_ts     TIMESTAMPTZ,
  p_created_by    UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_out       RECORD;
  v_lot       RECORD;
  v_already   INTEGER;
  v_short     INTEGER;
  v_take      INTEGER;
  v_consumed  INTEGER := 0;
BEGIN
  FOR v_out IN
    SELECT m.id, m.qty, m.company_id,
           m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type   = 'OUT'
       AND m.warehouse_id     = p_warehouse_id
       AND m.product_code     = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.source_doc_type  = 'DO'
       AND m.created_at       < p_before_ts
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND COALESCE(d.is_dropship, FALSE) = FALSE
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
       )
       /* The mirror exclusion — STRICT-BATCH LINES ONLY (see the header). A
          committed SOFA OUT belongs to the batched reconcile, because costing it
          from an arbitrary lot means another dye lot. A committed MATTRESS OUT
          has no dye lot to protect and MUST stay repairable here, or a cancelled
          / re-raised PO would strand its COGS at RM0 for good — which is what
          this migration exists to stop, not to cause. */
       AND NOT (
         m.batch_no IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM scm.delivery_order_items di
            WHERE di.delivery_order_id     = m.source_doc_id
              AND di.committed_po_batch_no = m.batch_no
              AND di.item_code             = m.product_code
              AND COALESCE(di.committed_variant_key, '') = COALESCE(m.variant_key, '')
              AND di.committed_batch_strict = TRUE
         )
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND product_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND company_id   = v_out.company_id
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0;
      v_take := LEAST(v_lot.qty_remaining, v_short);

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id;

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, product_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, COALESCE(p_variant_key, ''),
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no,
        v_out.id, p_created_by, v_lot.company_id
      );

      v_short    := v_short - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;

    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0
                                 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id;
  END LOOP;

  RETURN v_consumed;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reconcile_uncosted_out(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) IS
  'Receipt-time retro-cost for oversold (short-shipped) DO OUTs that are NOT bound to a DYE LOT (0154, narrowed 0230). For ONE (warehouse, product, variant) bucket it consumes each PRIOR uncosted short OUT''s outstanding qty from the newly-received open lots (plain FIFO, any batch, at the lot''s real cost). Excluded: OUTs on an is_dropship header (0154) and OUTs whose DO carries a per-line commitment for this batch + variant WITH committed_batch_strict = TRUE (0230) - those belong to fn_reconcile_dropship_batch, which is batch-scoped, because costing a sofa from an arbitrary lot is the colour-mixing batch binding exists to prevent. A NON-strict commitment (mattress / bedframe / accessory - no dye lot) is deliberately still eligible here: its bound PO can be cancelled, re-raised under another number, or superseded by a transfer or stock take, and without this fallback its COGS would sit at RM0 forever. Both reconciles recompute ABS(qty) - SUM(consumed), and the GRN post runs the batched one first, so a doubly-eligible OUT can neither double-cost nor race. Anti coverage-theft: created_at < p_before_ts, oldest first, status <> CANCELLED, company-pinned; idempotent via ledger-recomputed shortfall.';

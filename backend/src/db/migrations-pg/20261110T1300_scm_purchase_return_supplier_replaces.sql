-- ----------------------------------------------------------------------------
-- 20261110T1300 -- a CREDIT purchase return says whether the supplier sends a
-- replacement.
--
-- WHY. HC-0221 (Sim, 2026-11-09): HC-PO-2609-035 was received in full, its only
-- unit went back on HC-PRT-2611-001, and nothing was coming to replace it. The
-- PO recount nets every CREDIT return off the PO line (grns.ts recomputePoReceived),
-- so the PO fell back to SUBMITTED, sat in Purchase Outstanding, and could not
-- be cancelled because it has a GRN. The owner chose to ask on the return
-- instead of adding a PO status.
--
-- WHAT CHANGES.
--   1. scm.purchase_returns.supplier_replaces -- true (every row today, and the
--      default) keeps today's behaviour: the returned units re-open the PO line.
--      false: they do not; the PO stays received.
--   2. scm.grn_items.returned_closed_qty -- the part of returned_qty that went
--      back on a supplier_replaces = false return. Written by the same recount
--      that writes returned_qty (adjustGrnReturnedQty); always <= returned_qty.
--      returned_qty itself is unchanged, so the returnable cap and the PI
--      over-bill headroom read exactly what they read before.
--
-- REVERSAL:
--   ALTER TABLE scm.grn_items DROP COLUMN IF EXISTS returned_closed_qty;
--   ALTER TABLE scm.purchase_returns DROP COLUMN IF EXISTS supplier_replaces;
--   (No view is dropped or recreated, so no grant is lost. POs kept received by
--   a "no replacement" return would re-open on their next recount.)
-- RE-RUN: ADD COLUMN IF NOT EXISTS throughout; COMMENT ON is idempotent.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

ALTER TABLE scm.purchase_returns ADD COLUMN IF NOT EXISTS supplier_replaces boolean NOT NULL DEFAULT true;
ALTER TABLE scm.grn_items ADD COLUMN IF NOT EXISTS returned_closed_qty integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN scm.purchase_returns.supplier_replaces IS
  'CREDIT return only: true = the supplier sends a replacement, so the returned units re-open the PO line; false = they do not.';
COMMENT ON COLUMN scm.grn_items.returned_closed_qty IS
  'Part of returned_qty returned with no replacement (supplier_replaces = false). The PO recount adds it back. Written by adjustGrnReturnedQty.';

NOTIFY pgrst, 'reload schema';

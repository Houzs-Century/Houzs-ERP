-- 20261007T1100_scm_stock_adjustments.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.stock_adjustment_lines;
--           DROP TABLE IF EXISTS scm.stock_adjustments;
--   Revert the code first (routes/inventory-adjustments.ts reads and writes both).
--   The movements keep the source_doc_id / source_doc_no the backfill
--   (20261007T1110) stamped on them; that is harmless without the tables and is
--   reversed there if wanted.
--   GRANTS: none to re-apply — both tables ride the scm schema's default
--   privileges (service_role), like scm.stock_transfers.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- empty tables and their indexes; no existing row is written or altered.
--
-- WHY (BUG-66, Sim 2026-10-07: "stock adjustment no show document number /
-- cant open review item / cant edit"). A manual stock adjustment had no header
-- document: each line was one scm.inventory_movements row and nothing else, so
-- there was no number to quote, no page to open, and nothing to edit. This gives
-- it the same shape as Stock Transfer — a numbered header (`HC-SA-YYMM-NNN`)
-- holding the CURRENT line set, with every movement it wrote pointing back at it
-- through source_doc_type = 'ADJUSTMENT' + source_doc_id = header id.
--
-- The lines table is the document as it stands now; the movements are the
-- ledger. An edit replaces the lines and writes one signed ADJUSTMENT per
-- changed (item, variant, batch) bucket, so the ledger keeps every step.
--
-- qty is SIGNED (+ found / recount up, - write-off), exactly as the movement.
-- reason_code is nullable only for rows backfilled from movements written
-- before the reason became mandatory; the route still requires one.

CREATE TABLE IF NOT EXISTS scm.stock_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     bigint NOT NULL REFERENCES public.companies(id),
  adjustment_no  text NOT NULL,
  warehouse_id   uuid NOT NULL REFERENCES scm.warehouses(id),
  notes          text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_adjustments_no
  ON scm.stock_adjustments (adjustment_no);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_company_created
  ON scm.stock_adjustments (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scm.stock_adjustment_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_adjustment_id  uuid NOT NULL REFERENCES scm.stock_adjustments(id) ON DELETE CASCADE,
  company_id           bigint NOT NULL REFERENCES public.companies(id),
  line_no              integer NOT NULL,
  item_code            text NOT NULL,
  product_name         text,
  item_group           text,
  variants             jsonb,
  description2         text,
  variant_key          text NOT NULL DEFAULT '',
  batch_no             text,
  qty                  integer NOT NULL CHECK (qty <> 0),
  unit_cost_sen        integer,
  reason_code          text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustment_lines_doc
  ON scm.stock_adjustment_lines (stock_adjustment_id, line_no);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_adjustment_doc
  ON scm.inventory_movements (source_doc_id)
  WHERE source_doc_type = 'ADJUSTMENT';

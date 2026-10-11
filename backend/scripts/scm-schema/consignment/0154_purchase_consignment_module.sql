-- ============================================================================
-- 0154_purchase_consignment_module.sql
--
-- PURCHASE CONSIGNMENT MODULE — a faithful clone of the inbound procurement
-- document chain  Purchase Order → Goods Receipt → Purchase Return  into its
-- own set of tables so the purchase-consignment workflow (supplier's goods held
-- at MY warehouse on consignment) can run independently of the live owned-stock
-- procurement pipeline.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ OFF-LEDGER — READ THIS FIRST.                                             │
-- │ Purchase consignment = supplier's goods held at my warehouse; tracked    │
-- │ here only, NOT in inventory_movements / owned FIFO value, until          │
-- │ settlement converts to a real GRN.                                       │
-- │ Because the receive does NOT write inventory_movements (the goods are    │
-- │ the supplier's, not owned), there are deliberately NO inventory          │
-- │ idempotency UNIQUE indexes in this migration — there is no stock         │
-- │ movement to guard. (Contrast 0100/0102/0153, which DO add such guards    │
-- │ because those flows move owned/transferred stock.)                       │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- WHAT THIS CLONES (1:1 column fidelity, current shape — schema.ts is stale, so
-- these were copied directly from the migration ledger):
--   • purchase_consignment_orders / _items
--        ← purchase_orders / purchase_order_items
--          PO header  : 0015 base + 0041 (status flow/dates/totals/currency) +
--                       0065 (purchase_location_id) + 0078 (status default
--                       SUBMITTED, no DRAFT).
--          PO items   : 0041 base + 0056 (full sofa/bedframe variant + pricing)
--                       + 0065 (delivery_date, warehouse_id) + 0098 (so_item_id)
--                       + 0118 (from_mrp).
--   • purchase_consignment_receives / _receive_items
--        ← grns / grn_items
--          GRN header : 0042 base + 0101 (currency + money rollups).
--          GRN items  : 0042 base + 0057 (full variant set) + 0101 (line money +
--                       date + cost + supplier_sku) + 0106 (invoiced/returned
--                       qty) + 0151 (rack_id).
--   • purchase_consignment_returns / _return_items
--        ← purchase_returns / purchase_return_items
--          PR header  : 0048 base.
--          PR items   : 0048 base + 0057 (variant set) PLUS the full sofa
--                       variant/pricing columns the source PR-items table is
--                       MISSING (gap/divan/leg/special), added here for fidelity
--                       with the SO/DO/GRN item shape.
--
-- ── NOTE ON THE SOURCE TABLE NAMES ──────────────────────────────────────────
-- The brief referenced `mfg_purchase_orders` / `mfg_purchase_order_items`. In
-- THIS repo the procurement tables are named `purchase_orders` /
-- `purchase_order_items` (UUID PK, NOT a doc_no TEXT PK). There is no `mfg_`
-- PO table. We therefore clone the real `purchase_orders` shape and keep the
-- UUID `id` PK + `po_number TEXT UNIQUE` numbering, exactly as the source has.
--
-- ── NAMESPACE COLLISION WITH 0111 (handled here) ────────────────────────────
-- Migration 0111 previously created `purchase_consignment_orders`,
-- `purchase_consignment_order_items`, `purchase_consignment_notes`,
-- `purchase_consignment_note_items` as a DIFFERENT, note-based design (a mirror
-- of the OUT-consignment note quartet, NOT a PO/GRN/PR clone). That design has
-- ZERO application consumers (only referenced by two reset-test cleanup
-- scripts) and is superseded by this PO/GRN/PR clone. To reuse the contracted
-- table names this migration DROPs the four legacy 0111 tables and their two
-- bespoke enums, then rebuilds `_orders` / `_order_items` in the PO-clone shape.
-- The DROPs are IF EXISTS + CASCADE so this is safe whether or not 0111 ran.
--
-- SELF-REFERENTIAL / SOURCE-LINK FK RENAMES (the only structural change vs the
-- sources):
--   • GRN.purchase_order_id  → receives.purchase_consignment_order_id
--     GRN po_* link          → receives.pc_order_no (snapshot of po_number)
--                              → purchase_consignment_orders(id)  (NULLABLE — a
--                                receive may be standalone, vs source NOT NULL).
--   • GRN_item.purchase_order_item_id → receive_items.pc_order_item_id
--                              → purchase_consignment_order_items(id) (nullable).
--   • PR.grn_id              → returns.pc_receive_id
--                              → purchase_consignment_receives(id)   (nullable).
--   • PR.purchase_order_id   → returns.pc_order_id
--                              → purchase_consignment_orders(id)     (nullable).
--   • PR_item.grn_item_id    → return_items.pc_receive_item_id
--                              → purchase_consignment_receive_items(id)(nullable).
--   • PO_item.so_item_id (FK → mfg_sales_order_items) → DROPPED. Purchase
--     consignment lines do not originate from a sales order; the SO-link column
--     is removed (see report). `from_mrp` is likewise dropped (MRP-origin tag is
--     meaningless off the owned PO pipeline) — noted in report.
--   • receive_items.rack_id kept as a NULLABLE UUID → warehouse_racks
--     (harmless physical-placement link; off-ledger, never required).
--
-- ENUMS: reused as-is (all plain Postgres enums, shared safely):
--   • po_status              (post-0078: SUBMITTED/PARTIALLY_RECEIVED/RECEIVED/
--                             CANCELLED)            → orders.status
--   • grn_status             (post-0078: POSTED/CLOSED) → receives.status
--   • purchase_return_status (DRAFT/POSTED/COMPLETED/CANCELLED) → returns.status
--   • currency_code, material_kind                  → money / line columns
-- No new enum types are created. (The two bespoke 0111 enums
-- purchase_consignment_status / purchase_consignment_note_type are DROPPED as
-- part of the namespace cleanup above; they belonged to the abandoned design.)
--
-- ADDITIVE + idempotent for the new objects: CREATE TABLE/INDEX IF NOT EXISTS
-- throughout. Wrapped in BEGIN/COMMIT.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 0. Drop the abandoned 0111 note-based design occupying the contracted names.
--    IF EXISTS + CASCADE → safe whether or not 0111 was ever applied.
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS purchase_consignment_note_items  CASCADE;
DROP TABLE IF EXISTS purchase_consignment_notes       CASCADE;
DROP TABLE IF EXISTS purchase_consignment_order_items  CASCADE;
DROP TABLE IF EXISTS purchase_consignment_orders       CASCADE;
DROP TYPE  IF EXISTS purchase_consignment_note_type;
DROP TYPE  IF EXISTS purchase_consignment_status;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. PURCHASE CONSIGNMENT ORDER  (clone of purchase_orders + all ALTERs)
--    Header: 0015 base + 0041 + 0065 + 0078(default).  PK kept UUID.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_consignment_orders (
  -- ── 0015 base ──────────────────────────────────────────────────────────────
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- source default next_po_number() is PO-specific; PC numbering is assigned by
  -- the routes at insert time, so the column is plain UNIQUE with no DEFAULT.
  pc_number           TEXT NOT NULL UNIQUE,
  supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  -- ── 0041 status flow / dates / totals / currency ───────────────────────────
  status              po_status NOT NULL DEFAULT 'SUBMITTED',   -- 0078: no DRAFT
  po_date             DATE NOT NULL DEFAULT current_date,
  expected_at         DATE,
  currency            currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi      INTEGER NOT NULL DEFAULT 0,
  tax_centi           INTEGER NOT NULL DEFAULT 0,
  total_centi         INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  submitted_at        TIMESTAMPTZ,
  received_at         TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0065 header purchase location ──────────────────────────────────────────
  purchase_location_id UUID REFERENCES warehouses(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pco_supplier ON purchase_consignment_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pco_status   ON purchase_consignment_orders(status);
CREATE INDEX IF NOT EXISTS idx_pco_purchase_location
  ON purchase_consignment_orders(purchase_location_id);

CREATE TABLE IF NOT EXISTS purchase_consignment_order_items (
  -- ── 0041 base (purchase_order_id → purchase_consignment_order_id) ───────────
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_order_id UUID NOT NULL
                            REFERENCES purchase_consignment_orders(id) ON DELETE CASCADE,
  binding_id              UUID REFERENCES supplier_material_bindings(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           TEXT NOT NULL,
  material_name           TEXT NOT NULL,
  supplier_sku            TEXT,
  qty                     INTEGER NOT NULL,
  unit_price_centi        INTEGER NOT NULL,
  line_total_centi        INTEGER NOT NULL,
  received_qty            INTEGER NOT NULL DEFAULT 0,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0056 sofa / bedframe variant + pricing columns ─────────────────────────
  gap_inches              INTEGER,
  divan_height_inches     INTEGER,
  divan_price_sen         INTEGER NOT NULL DEFAULT 0,
  leg_height_inches       INTEGER,
  leg_price_sen           INTEGER NOT NULL DEFAULT 0,
  custom_specials         JSONB,
  line_suffix             TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  variants                JSONB,
  item_group              TEXT,
  description             TEXT,
  description2            TEXT,
  uom                     TEXT NOT NULL DEFAULT 'UNIT',
  discount_centi          INTEGER NOT NULL DEFAULT 0,
  unit_cost_centi         INTEGER NOT NULL DEFAULT 0,
  -- ── 0065 per-line delivery date + ship-to warehouse ────────────────────────
  delivery_date           DATE,
  warehouse_id            UUID REFERENCES warehouses(id) ON DELETE SET NULL
  -- ── 0098 so_item_id: DROPPED (PC lines never originate from a sales order)
  -- ── 0118 from_mrp:   DROPPED (MRP-origin tag meaningless off the owned PO)
);
CREATE INDEX IF NOT EXISTS idx_pcoi_po
  ON purchase_consignment_order_items(purchase_consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_pcoi_warehouse
  ON purchase_consignment_order_items(warehouse_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. PURCHASE CONSIGNMENT RECEIVE  (clone of grns, post-0151 shape)
--    purchase_order_id  → purchase_consignment_order_id (NULLABLE — standalone
--    receives allowed); a po_number snapshot is kept as pc_order_no.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_consignment_receives (
  -- ── 0042 base (purchase_order_id → purchase_consignment_order_id) ───────────
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receive_number      TEXT NOT NULL UNIQUE,
  purchase_consignment_order_id UUID
                        REFERENCES purchase_consignment_orders(id) ON DELETE SET NULL,
  pc_order_no         TEXT,                       -- snapshot of pc_number (nullable)
  supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  received_at         DATE NOT NULL DEFAULT current_date,
  delivery_note_ref   TEXT,
  status              grn_status NOT NULL DEFAULT 'POSTED',   -- 0078: no DRAFT
  notes               TEXT,
  posted_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0101 currency + per-document money rollups ─────────────────────────────
  currency            currency_code NOT NULL DEFAULT 'MYR',
  subtotal_centi      INTEGER NOT NULL DEFAULT 0,
  tax_centi           INTEGER NOT NULL DEFAULT 0,
  total_centi         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pcr_po       ON purchase_consignment_receives(purchase_consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_pcr_supplier ON purchase_consignment_receives(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcr_status   ON purchase_consignment_receives(status);

CREATE TABLE IF NOT EXISTS purchase_consignment_receive_items (
  -- ── 0042 base (grn_id → pc_receive_id, purchase_order_item_id → pc_order_item_id)
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_receive_id           UUID NOT NULL
                            REFERENCES purchase_consignment_receives(id) ON DELETE CASCADE,
  pc_order_item_id        UUID
                            REFERENCES purchase_consignment_order_items(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           TEXT NOT NULL,
  material_name           TEXT NOT NULL,
  qty_received            INTEGER NOT NULL,
  qty_accepted            INTEGER NOT NULL,
  qty_rejected            INTEGER NOT NULL DEFAULT 0,
  rejection_reason        TEXT,
  unit_price_centi        INTEGER NOT NULL,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0057 variant + pricing columns ─────────────────────────────────────────
  gap_inches              INTEGER,
  divan_height_inches     INTEGER,
  divan_price_sen         INTEGER NOT NULL DEFAULT 0,
  leg_height_inches       INTEGER,
  leg_price_sen           INTEGER NOT NULL DEFAULT 0,
  custom_specials         JSONB,
  line_suffix             TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  variants                JSONB,
  item_group              TEXT,
  description             TEXT,
  description2            TEXT,
  uom                     TEXT NOT NULL DEFAULT 'UNIT',
  discount_centi          INTEGER NOT NULL DEFAULT 0,
  -- ── 0101 line money + date + cost + supplier sku ───────────────────────────
  line_total_centi        INTEGER NOT NULL DEFAULT 0,
  delivery_date           DATE,
  unit_cost_centi         INTEGER NOT NULL DEFAULT 0,
  supplier_sku            TEXT,
  -- ── 0106 consumption tracking (invoiced / returned against this line) ───────
  invoiced_qty            INTEGER NOT NULL DEFAULT 0,
  returned_qty            INTEGER NOT NULL DEFAULT 0,
  -- ── 0151 rack placement (nullable physical link; off-ledger, harmless) ─────
  rack_id                 UUID REFERENCES warehouse_racks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pcri_receive ON purchase_consignment_receive_items(pc_receive_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PURCHASE CONSIGNMENT RETURN  (clone of purchase_returns)
--    grn_id           → pc_receive_id (nullable);
--    purchase_order_id → pc_order_id  (nullable, mirrors source nullable FK).
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_consignment_returns (
  -- ── 0048 base ──────────────────────────────────────────────────────────────
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number     TEXT NOT NULL UNIQUE,
  pc_order_id       UUID REFERENCES purchase_consignment_orders(id)  ON DELETE SET NULL,
  pc_receive_id     UUID REFERENCES purchase_consignment_receives(id) ON DELETE SET NULL,
  supplier_id       UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  return_date       DATE NOT NULL DEFAULT now(),
  reason            TEXT,
  status            purchase_return_status NOT NULL DEFAULT 'POSTED',  -- 0078 dropped DRAFT
  posted_at         TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  credit_note_ref   TEXT,
  refund_centi      INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcret_po       ON purchase_consignment_returns(pc_order_id);
CREATE INDEX IF NOT EXISTS idx_pcret_receive  ON purchase_consignment_returns(pc_receive_id);
CREATE INDEX IF NOT EXISTS idx_pcret_supplier ON purchase_consignment_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcret_status   ON purchase_consignment_returns(status);

CREATE TABLE IF NOT EXISTS purchase_consignment_return_items (
  -- ── 0048 base (purchase_return_id → purchase_consignment_return_id,
  --     grn_item_id → pc_receive_item_id) ──────────────────────────────────────
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_return_id UUID NOT NULL
                            REFERENCES purchase_consignment_returns(id) ON DELETE CASCADE,
  pc_receive_item_id      UUID
                            REFERENCES purchase_consignment_receive_items(id) ON DELETE SET NULL,
  material_kind           material_kind NOT NULL,
  material_code           TEXT NOT NULL,
  material_name           TEXT NOT NULL,
  qty_returned            INTEGER NOT NULL,
  unit_price_centi        INTEGER NOT NULL DEFAULT 0,
  line_refund_centi       INTEGER NOT NULL DEFAULT 0,
  reason                  TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0057 variant set carried by source purchase_return_items ───────────────
  gap_inches              INTEGER,
  divan_height_inches     INTEGER,
  divan_price_sen         INTEGER NOT NULL DEFAULT 0,
  leg_height_inches       INTEGER,
  leg_price_sen           INTEGER NOT NULL DEFAULT 0,
  custom_specials         JSONB,
  line_suffix             TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  variants                JSONB,
  item_group              TEXT,
  description             TEXT,
  description2            TEXT,
  uom                     TEXT NOT NULL DEFAULT 'UNIT'
  -- NOTE: source purchase_return_items already carries the full sofa variant
  -- set via 0057, so no extra fidelity columns are needed here (unlike the
  -- delivery_return_items case in 0153).
);
CREATE INDEX IF NOT EXISTS idx_pcreti_return
  ON purchase_consignment_return_items(purchase_consignment_return_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. RLS — enable + permissive authenticated policy on every new table
--    (mirrors the 0048 / 0100 / 0102 / 0153 pattern: read+write for any
--     authenticated staff; finer per-role gating happens at the API layer)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE purchase_consignment_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_consignment_order_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_consignment_receives      ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_consignment_receive_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_consignment_returns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_consignment_return_items  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pco_all   ON purchase_consignment_orders;
DROP POLICY IF EXISTS pcoi_all  ON purchase_consignment_order_items;
DROP POLICY IF EXISTS pcr_all   ON purchase_consignment_receives;
DROP POLICY IF EXISTS pcri_all  ON purchase_consignment_receive_items;
DROP POLICY IF EXISTS pcret_all ON purchase_consignment_returns;
DROP POLICY IF EXISTS pcreti_all ON purchase_consignment_return_items;

CREATE POLICY pco_all    ON purchase_consignment_orders        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pcoi_all   ON purchase_consignment_order_items   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pcr_all    ON purchase_consignment_receives      FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pcri_all   ON purchase_consignment_receive_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pcret_all  ON purchase_consignment_returns       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY pcreti_all ON purchase_consignment_return_items  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. INVENTORY IDEMPOTENCY GUARDS — intentionally NONE.
--    Purchase consignment is OFF-LEDGER: the receive does NOT write
--    inventory_movements (the goods are the supplier's, not owned), so there is
--    no stock movement to make idempotent. A real owned-stock GRN is created
--    only at SETTLEMENT, and THAT path (a standard grns insert) already carries
--    the existing inventory guards. No uq_inv_mov_* index belongs here.
-- ════════════════════════════════════════════════════════════════════════════

COMMIT;

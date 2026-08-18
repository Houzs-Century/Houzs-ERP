-- ============================================================================
-- 0153_consignment_module.sql
--
-- CONSIGNMENT MODULE — a faithful clone of the Sales Order → Delivery Order →
-- Delivery Return document chain, isolated into its own set of tables so the
-- consignment ("loaner" / stock-on-consignment) workflow can run independently
-- of the live B2C sales pipeline.
--
-- NAMES HERE ARE THE 2026-05 SHAPE, NOT TODAY'S. This file is a pre-migration
-- baseline replayed before the migration tree, so it still declares
-- `internal_expected_dd` AND the dead legacy `processing_date` on
-- consignment_sales_orders. migrations-pg/0284 drops the dead one and renames the
-- live one to `processing_date` — the single name the UI, the API and every human
-- already use. Leave this file alone; 0284 runs after it.
--
-- WHAT THIS CLONES (1:1 column fidelity, current shape — schema.ts is stale, so
-- these were copied directly from the migration ledger):
--   • consignment_sales_orders / _items / _payments   ← mfg_sales_orders /
--       mfg_sales_order_items / mfg_sales_order_payments
--       (0042 base + every later ALTER: 0051, 0060, 0067, 0068, 0069, 0070,
--        0074, 0077, 0079, 0082, 0086, 0091, 0111, 0112, 0113, 0118, 0121,
--        0124, 0133, 0141, 0142, 0143 + payments table 0073)
--   • consignment_delivery_orders / _items / _payments ← delivery_orders /
--       delivery_order_items / delivery_order_payments
--       (0042 base + 0050 warehouse_id + 0058 item variants + 0100 full SO-clone)
--   • consignment_delivery_returns / _items            ← delivery_returns /
--       delivery_return_items (0042 base + 0102 full DO-clone), PLUS the full
--       sofa/variant line columns the source return-items table is MISSING.
--
-- SELF-REFERENTIAL FK RENAMES (the only structural change vs the sources):
--   • SO doc_no  → consignment_sales_orders.doc_no  (PK kept TEXT; consignment
--     numbering values are assigned at insert time by the routes).
--   • DO.so_doc_no              → consignment_delivery_orders.consignment_so_doc_no
--                                 → consignment_sales_orders(doc_no)  (nullable;
--                                   a consignment DO may be standalone).
--   • DO_item.so_item_id        → consignment_delivery_order_items.consignment_so_item_id
--                                 → consignment_sales_order_items(id)  (nullable).
--   • DR.delivery_order_id      → consignment_delivery_returns.consignment_do_id
--                                 → consignment_delivery_orders(id)    (nullable).
--     DR.sales_invoice_id is DROPPED — consignment has no Sales Invoice.
--   • DR_item.do_item_id        → consignment_delivery_return_items.consignment_do_item_id
--                                 → consignment_delivery_order_items(id) (nullable).
--
-- STOCK MOVEMENT (wired in the routes, not here): a consignment delivery
-- (CS_DO — goods shipped out on loan/consignment) and a consignment return
-- (CS_DR — goods coming back) move stock via a VALUE-NEUTRAL TRANSFER, NOT a
-- COGS sale/return. Ownership does not change at ship time, so no margin / COGS
-- is realised — only the physical location of the stock moves. The two partial
-- UNIQUE indexes at the bottom are the idempotency backstop for those movements,
-- mirroring uq_inv_mov_do_source (0100) / uq_inv_mov_dr_source (0102).
--
-- ENUMS: reused as-is (all are plain Postgres enums, shared safely):
--   • mfg_so_status            (post-0078 value set) — consignment_sales_orders.status
--   • do_status                (post-0078 value set) — consignment_delivery_orders.status
--   • delivery_return_status   (0042 value set)      — consignment_delivery_returns.status
--   • currency_code, slip_state                       — money/slip columns
-- No new enum types are created.
--
-- ADDITIVE + idempotent: CREATE TABLE/INDEX IF NOT EXISTS throughout.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CONSIGNMENT SALES ORDER  (clone of mfg_sales_orders + all ALTERs)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS consignment_sales_orders (
  -- ── 0042 base ────────────────────────────────────────────────────────────
  doc_no                  TEXT PRIMARY KEY,
  transfer_to             TEXT,
  so_date                 DATE NOT NULL DEFAULT current_date,
  branding                TEXT,
  debtor_code             TEXT,
  debtor_name             TEXT NOT NULL,
  agent                   TEXT,
  sales_location          TEXT,
  ref                     TEXT,
  po_doc_no               TEXT,
  venue                   TEXT,
  address1                TEXT,
  address2                TEXT,
  address3                TEXT,
  address4                TEXT,
  phone                   TEXT,
  mattress_sofa_sen     INTEGER NOT NULL DEFAULT 0,
  bedframe_sen          INTEGER NOT NULL DEFAULT 0,
  accessories_sen       INTEGER NOT NULL DEFAULT 0,
  others_sen            INTEGER NOT NULL DEFAULT 0,
  local_total_sen       INTEGER NOT NULL DEFAULT 0,
  balance_sen           INTEGER NOT NULL DEFAULT 0,
  total_cost_sen        INTEGER NOT NULL DEFAULT 0,
  total_revenue_sen     INTEGER NOT NULL DEFAULT 0,
  total_margin_sen      INTEGER NOT NULL DEFAULT 0,
  margin_pct_basis        INTEGER NOT NULL DEFAULT 0,
  line_count              INTEGER NOT NULL DEFAULT 0,
  currency                currency_code NOT NULL DEFAULT 'MYR',
  status                  mfg_so_status NOT NULL DEFAULT 'CONFIRMED',
  remark2                 TEXT,
  remark3                 TEXT,
  remark4                 TEXT,
  note                    TEXT,
  -- RETIRED. Cloned from mfg_sales_orders and never wired to anything: zero
  -- writers, ever. The CO's Processing Date is `internal_expected_dd` below —
  -- the one name this concept has system-wide. No longer selected by the API;
  -- a follow-up migration drops it (see the HEADER note in
  -- scm/routes/consignment-orders.ts). Do not read or write this column.
  processing_date         DATE,
  sales_exemption_expiry  DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              UUID REFERENCES staff(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0051 hookka alignment ──────────────────────────────────────────────
  customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_po             TEXT,
  customer_po_id          TEXT,
  customer_po_date        DATE,
  customer_po_image_b64   TEXT,
  hub_id                  UUID,
  hub_name                TEXT,
  customer_state          TEXT,
  customer_delivery_date  DATE,
  internal_expected_dd    DATE,
  linked_do_doc_no        TEXT,
  ship_to_address         TEXT,
  bill_to_address         TEXT,
  install_to_address      TEXT,
  subtotal_sen            INTEGER,
  overdue                 TEXT,
  -- ── 0060 POS alignment ─────────────────────────────────────────────────
  email                   TEXT,
  customer_type           TEXT,
  salesperson_id          UUID REFERENCES staff(id) ON DELETE SET NULL,
  city                    TEXT,
  postcode                TEXT,
  building_type           TEXT,
  emergency_contact_name           TEXT,
  emergency_contact_phone          TEXT,
  emergency_contact_relationship   TEXT,
  target_date             DATE,
  -- ── 0067 customer_so_no ────────────────────────────────────────────────
  customer_so_no          TEXT,
  -- ── 0068 payment fields ────────────────────────────────────────────────
  payment_method          TEXT,
  installment_months      INTEGER,
  merchant_provider       TEXT,
  deposit_sen           INTEGER NOT NULL DEFAULT 0,
  paid_sen              INTEGER NOT NULL DEFAULT 0,
  -- ── 0069 approval_code ─────────────────────────────────────────────────
  approval_code           TEXT,
  -- ── 0070 payment_date ──────────────────────────────────────────────────
  payment_date            DATE,
  -- ── 0079 category cost columns ─────────────────────────────────────────
  mattress_sofa_cost_sen INTEGER NOT NULL DEFAULT 0,
  bedframe_cost_sen      INTEGER NOT NULL DEFAULT 0,
  accessories_cost_sen   INTEGER NOT NULL DEFAULT 0,
  others_cost_sen        INTEGER NOT NULL DEFAULT 0,
  -- ── 0082 customer_country ──────────────────────────────────────────────
  customer_country        TEXT,
  -- ── 0086 venue_id ──────────────────────────────────────────────────────
  venue_id                UUID REFERENCES venues(id) ON DELETE SET NULL,
  -- ── 0111 priority ──────────────────────────────────────────────────────
  priority_rank           INTEGER,
  priority_set_at         TIMESTAMPTZ,
  priority_set_by         UUID REFERENCES staff(id) ON DELETE SET NULL,
  priority_reason         TEXT,
  -- ── 0112 allocation warehouse ──────────────────────────────────────────
  allocation_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  -- ── 0113 proceeded_at ──────────────────────────────────────────────────
  -- DROPPED by mig 0284. Another mfg_sales_orders clone artifact with zero
  -- readers and zero writers on THIS table. (mfg_sales_orders.proceeded_at is
  -- alive and is a different fact — the Proceed timestamp the stock allocator
  -- gates on.) Left in this historical module script for the record only; the
  -- column does not exist after 0284.
  proceeded_at            TIMESTAMPTZ,
  -- ── 0124 fabric tier add-on ────────────────────────────────────────────
  fabric_tier_addon_sen INTEGER NOT NULL DEFAULT 0 CHECK (fabric_tier_addon_sen >= 0),
  -- ── 0133 delivery fee ──────────────────────────────────────────────────
  delivery_fee_sen      INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_sen >= 0),
  -- ── 0141 cross-category link ───────────────────────────────────────────
  cross_category_source_doc_no TEXT,
  -- ── 0142 signature ─────────────────────────────────────────────────────
  signature_b64           TEXT,
  -- ── 0143 slip ──────────────────────────────────────────────────────────
  slip_key                TEXT,
  slip_state              slip_state NOT NULL DEFAULT 'none'
);
CREATE INDEX IF NOT EXISTS idx_cso_date     ON consignment_sales_orders(so_date);
CREATE INDEX IF NOT EXISTS idx_cso_debtor   ON consignment_sales_orders(debtor_code);
CREATE INDEX IF NOT EXISTS idx_cso_status   ON consignment_sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_cso_branding ON consignment_sales_orders(branding);
CREATE INDEX IF NOT EXISTS idx_cso_salesperson ON consignment_sales_orders(salesperson_id) WHERE salesperson_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cso_venue_id ON consignment_sales_orders(venue_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cso_cross_cat_source
  ON consignment_sales_orders (cross_category_source_doc_no)
  WHERE cross_category_source_doc_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS consignment_sales_order_items (
  -- ── 0042 base ────────────────────────────────────────────────────────────
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no             TEXT NOT NULL REFERENCES consignment_sales_orders(doc_no) ON DELETE CASCADE,
  line_date          DATE NOT NULL DEFAULT current_date,
  debtor_code        TEXT,
  debtor_name        TEXT,
  agent              TEXT,
  item_group         TEXT NOT NULL,
  item_code          TEXT NOT NULL,
  description        TEXT,
  description2       TEXT,
  uom                TEXT NOT NULL DEFAULT 'UNIT',
  location           TEXT,
  qty                INTEGER NOT NULL DEFAULT 1,
  unit_price_sen   INTEGER NOT NULL DEFAULT 0,
  discount_sen     INTEGER NOT NULL DEFAULT 0,
  total_sen        INTEGER NOT NULL DEFAULT 0,
  tax_sen          INTEGER NOT NULL DEFAULT 0,
  total_inc_sen    INTEGER NOT NULL DEFAULT 0,
  balance_sen      INTEGER NOT NULL DEFAULT 0,
  payment_status     TEXT NOT NULL DEFAULT 'Unchecked',
  venue              TEXT,
  branding           TEXT,
  remark             TEXT,
  cancelled          BOOLEAN NOT NULL DEFAULT FALSE,
  variants           JSONB,
  unit_cost_sen    INTEGER NOT NULL DEFAULT 0,
  line_cost_sen    INTEGER NOT NULL DEFAULT 0,
  line_margin_sen  INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0051 sofa/bedframe variant pricing ─────────────────────────────────
  gap_inches              INTEGER,
  divan_height_inches     INTEGER,
  divan_price_sen         INTEGER NOT NULL DEFAULT 0,
  leg_height_inches       INTEGER,
  leg_price_sen           INTEGER NOT NULL DEFAULT 0,
  custom_specials         JSONB,
  line_suffix             TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0,
  -- ── 0069 po_qty_picked / 0091 stock_status (kept — harmless; these are
  --     SO-allocation/MRP workflow fields but cost nothing carried along) ──
  po_qty_picked      INTEGER NOT NULL DEFAULT 0,
  stock_status       TEXT NOT NULL DEFAULT 'PENDING',
  -- ── 0074 per-line delivery date ────────────────────────────────────────
  line_delivery_date date,
  line_delivery_date_overridden boolean NOT NULL DEFAULT false,
  -- ── 0077 per-line photos ───────────────────────────────────────────────
  photo_urls         text[] NOT NULL DEFAULT '{}',
  -- ── 0112 partial-line readiness ────────────────────────────────────────
  stock_qty_ready    INTEGER NOT NULL DEFAULT 0,
  -- ── 0118 per-line warehouse ────────────────────────────────────────────
  warehouse_id       UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  -- ── 0121 sofa batch outbound ───────────────────────────────────────────
  allocated_batch_no TEXT
);
CREATE INDEX IF NOT EXISTS idx_csoi_doc       ON consignment_sales_order_items(doc_no);
CREATE INDEX IF NOT EXISTS idx_csoi_item      ON consignment_sales_order_items(item_code);
CREATE INDEX IF NOT EXISTS idx_csoi_group     ON consignment_sales_order_items(item_group);
CREATE INDEX IF NOT EXISTS idx_csoi_warehouse ON consignment_sales_order_items(warehouse_id) WHERE warehouse_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS consignment_sales_order_payments (
  -- clone of mfg_sales_order_payments (0073)
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no           text NOT NULL REFERENCES consignment_sales_orders(doc_no) ON DELETE CASCADE,
  paid_at             date NOT NULL DEFAULT CURRENT_DATE,
  method              text NOT NULL,
  merchant_provider   text,
  installment_months  integer,
  approval_code       text,
  amount_sen        integer NOT NULL CHECK (amount_sen >= 0),
  account_sheet       text,
  collected_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES staff(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_csop_doc     ON consignment_sales_order_payments(so_doc_no);
CREATE INDEX IF NOT EXISTS idx_csop_paid_at ON consignment_sales_order_payments(paid_at);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. CONSIGNMENT DELIVERY ORDER  (clone of delivery_orders, post-0100 shape)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS consignment_delivery_orders (
  -- ── 0042 base (so_doc_no → consignment_so_doc_no) ──────────────────────────
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  do_number             TEXT NOT NULL UNIQUE,
  consignment_so_doc_no TEXT REFERENCES consignment_sales_orders(doc_no) ON DELETE SET NULL,
  debtor_code           TEXT,
  debtor_name           TEXT NOT NULL,
  do_date               DATE NOT NULL DEFAULT current_date,
  expected_delivery_at  DATE,
  signed_at             TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  dispatched_at         TIMESTAMPTZ,
  driver_id             UUID REFERENCES drivers(id) ON DELETE SET NULL,
  driver_name           TEXT,
  vehicle               TEXT,
  m3_total_milli        INTEGER NOT NULL DEFAULT 0,
  address1              TEXT,
  address2              TEXT,
  city                  TEXT,
  state                 TEXT,
  postcode              TEXT,
  phone                 TEXT,
  pod_r2_key            TEXT,
  signature_data        TEXT,
  status                do_status NOT NULL DEFAULT 'LOADED',
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0050 warehouse_id ──────────────────────────────────────────────────
  warehouse_id          UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  -- ── 0100 full SO-clone header ──────────────────────────────────────────
  salesperson_id        UUID REFERENCES staff(id) ON DELETE SET NULL,
  agent                 TEXT,
  email                 TEXT,
  customer_type         TEXT,
  building_type         TEXT,
  branding              TEXT,
  venue                 TEXT,
  venue_id              UUID REFERENCES venues(id) ON DELETE SET NULL,
  ref                   TEXT,
  customer_so_no        TEXT,
  po_doc_no             TEXT,
  sales_location        TEXT,
  customer_state        TEXT,
  customer_country      TEXT,
  customer_delivery_date DATE,
  note                  TEXT,
  emergency_contact_name         TEXT,
  emergency_contact_phone        TEXT,
  emergency_contact_relationship TEXT,
  currency              currency_code NOT NULL DEFAULT 'MYR',
  mattress_sofa_sen       INTEGER NOT NULL DEFAULT 0,
  bedframe_sen            INTEGER NOT NULL DEFAULT 0,
  accessories_sen         INTEGER NOT NULL DEFAULT 0,
  others_sen              INTEGER NOT NULL DEFAULT 0,
  mattress_sofa_cost_sen  INTEGER NOT NULL DEFAULT 0,
  bedframe_cost_sen       INTEGER NOT NULL DEFAULT 0,
  accessories_cost_sen    INTEGER NOT NULL DEFAULT 0,
  others_cost_sen         INTEGER NOT NULL DEFAULT 0,
  local_total_sen         INTEGER NOT NULL DEFAULT 0,
  total_cost_sen          INTEGER NOT NULL DEFAULT 0,
  total_margin_sen        INTEGER NOT NULL DEFAULT 0,
  margin_pct_basis          INTEGER NOT NULL DEFAULT 0,
  line_count                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cdo_so          ON consignment_delivery_orders(consignment_so_doc_no);
CREATE INDEX IF NOT EXISTS idx_cdo_status      ON consignment_delivery_orders(status);
CREATE INDEX IF NOT EXISTS idx_cdo_date        ON consignment_delivery_orders(do_date);
CREATE INDEX IF NOT EXISTS idx_cdo_salesperson ON consignment_delivery_orders(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_cdo_debtor      ON consignment_delivery_orders(debtor_code);

CREATE TABLE IF NOT EXISTS consignment_delivery_order_items (
  -- ── 0042 base (delivery_order_id → consignment_delivery_order_id,
  --     so_item_id → consignment_so_item_id) ──────────────────────────────────
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_order_id UUID NOT NULL REFERENCES consignment_delivery_orders(id) ON DELETE CASCADE,
  consignment_so_item_id      UUID REFERENCES consignment_sales_order_items(id) ON DELETE SET NULL,
  item_code                   TEXT NOT NULL,
  description                 TEXT,
  qty                         INTEGER NOT NULL,
  m3_milli                    INTEGER NOT NULL DEFAULT 0,
  unit_price_sen            INTEGER NOT NULL DEFAULT 0,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0058 variant + pricing columns ─────────────────────────────────────
  gap_inches                  INTEGER,
  divan_height_inches         INTEGER,
  divan_price_sen             INTEGER NOT NULL DEFAULT 0,
  leg_height_inches           INTEGER,
  leg_price_sen               INTEGER NOT NULL DEFAULT 0,
  custom_specials             JSONB,
  line_suffix                 TEXT,
  special_order_price_sen     INTEGER NOT NULL DEFAULT 0,
  variants                    JSONB,
  item_group                  TEXT,
  description2                TEXT,
  uom                         TEXT NOT NULL DEFAULT 'UNIT',
  discount_sen              INTEGER NOT NULL DEFAULT 0,
  line_total_sen            INTEGER NOT NULL DEFAULT 0,
  -- ── 0100 cost/margin + per-line delivery date ──────────────────────────
  unit_cost_sen             INTEGER NOT NULL DEFAULT 0,
  line_cost_sen             INTEGER NOT NULL DEFAULT 0,
  line_margin_sen           INTEGER NOT NULL DEFAULT 0,
  line_delivery_date          DATE,
  line_delivery_date_overridden BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_cdoi_do ON consignment_delivery_order_items(consignment_delivery_order_id);

CREATE TABLE IF NOT EXISTS consignment_delivery_order_payments (
  -- clone of delivery_order_payments (0100)
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_order_id uuid NOT NULL REFERENCES consignment_delivery_orders(id) ON DELETE CASCADE,
  paid_at             date NOT NULL DEFAULT CURRENT_DATE,
  method              text NOT NULL,
  merchant_provider   text,
  installment_months  integer,
  online_type         text,
  approval_code       text,
  amount_sen        integer NOT NULL CHECK (amount_sen >= 0),
  account_sheet       text,
  collected_by        uuid REFERENCES staff(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES staff(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cdop_do      ON consignment_delivery_order_payments(consignment_delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_cdop_paid_at ON consignment_delivery_order_payments(paid_at);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. CONSIGNMENT DELIVERY RETURN  (clone of delivery_returns, post-0102 shape)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS consignment_delivery_returns (
  -- ── 0042 base (delivery_order_id → consignment_do_id; sales_invoice_id
  --     DROPPED — consignment has no Sales Invoice) ────────────────────────────
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number       TEXT NOT NULL UNIQUE,
  consignment_do_id   UUID REFERENCES consignment_delivery_orders(id) ON DELETE SET NULL,
  debtor_code         TEXT,
  debtor_name         TEXT NOT NULL,
  return_date         DATE NOT NULL DEFAULT current_date,
  reason              TEXT,
  status              delivery_return_status NOT NULL DEFAULT 'PENDING',
  received_at         TIMESTAMPTZ,
  inspected_at        TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  refund_sen        INTEGER NOT NULL DEFAULT 0,
  inspection_notes    TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0102 full DO-clone header (do_doc_no kept as snapshot text) ─────────
  do_doc_no           TEXT,
  salesperson_id      UUID REFERENCES staff(id) ON DELETE SET NULL,
  agent               TEXT,
  email               TEXT,
  customer_type       TEXT,
  building_type       TEXT,
  branding            TEXT,
  venue               TEXT,
  venue_id            UUID REFERENCES venues(id) ON DELETE SET NULL,
  ref                 TEXT,
  customer_so_no      TEXT,
  sales_location      TEXT,
  customer_state      TEXT,
  customer_country    TEXT,
  note                TEXT,
  address1            TEXT,
  address2            TEXT,
  city                TEXT,
  state               TEXT,
  postcode            TEXT,
  phone               TEXT,
  emergency_contact_name         TEXT,
  emergency_contact_phone        TEXT,
  emergency_contact_relationship TEXT,
  warehouse_id        UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  currency            currency_code NOT NULL DEFAULT 'MYR',
  mattress_sofa_sen       INTEGER NOT NULL DEFAULT 0,
  bedframe_sen            INTEGER NOT NULL DEFAULT 0,
  accessories_sen         INTEGER NOT NULL DEFAULT 0,
  others_sen              INTEGER NOT NULL DEFAULT 0,
  mattress_sofa_cost_sen  INTEGER NOT NULL DEFAULT 0,
  bedframe_cost_sen       INTEGER NOT NULL DEFAULT 0,
  accessories_cost_sen    INTEGER NOT NULL DEFAULT 0,
  others_cost_sen         INTEGER NOT NULL DEFAULT 0,
  local_total_sen         INTEGER NOT NULL DEFAULT 0,
  total_cost_sen          INTEGER NOT NULL DEFAULT 0,
  total_margin_sen        INTEGER NOT NULL DEFAULT 0,
  margin_pct_basis          INTEGER NOT NULL DEFAULT 0,
  line_count                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cdr_do          ON consignment_delivery_returns(consignment_do_id);
CREATE INDEX IF NOT EXISTS idx_cdr_status      ON consignment_delivery_returns(status);
CREATE INDEX IF NOT EXISTS idx_cdr_debtor      ON consignment_delivery_returns(debtor_code);
CREATE INDEX IF NOT EXISTS idx_cdr_salesperson ON consignment_delivery_returns(salesperson_id);

CREATE TABLE IF NOT EXISTS consignment_delivery_return_items (
  -- ── 0042 base (delivery_return_id → consignment_delivery_return_id,
  --     do_item_id → consignment_do_item_id) ──────────────────────────────────
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consignment_delivery_return_id UUID NOT NULL REFERENCES consignment_delivery_returns(id) ON DELETE CASCADE,
  consignment_do_item_id UUID REFERENCES consignment_delivery_order_items(id) ON DELETE SET NULL,
  item_code           TEXT NOT NULL,
  description         TEXT,
  qty_returned        INTEGER NOT NULL,
  condition           TEXT,
  unit_price_sen    INTEGER NOT NULL DEFAULT 0,
  refund_sen        INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ── 0102 variant + pricing columns (the THIN set on the source) ────────
  item_group          TEXT,
  description2        TEXT,
  uom                 TEXT NOT NULL DEFAULT 'UNIT',
  variants            JSONB,
  discount_sen      INTEGER NOT NULL DEFAULT 0,
  line_total_sen    INTEGER NOT NULL DEFAULT 0,
  unit_cost_sen     INTEGER NOT NULL DEFAULT 0,
  line_cost_sen     INTEGER NOT NULL DEFAULT 0,
  line_margin_sen   INTEGER NOT NULL DEFAULT 0,
  -- ── FULL SOFA FIDELITY (NOT in source delivery_return_items — added here
  --     so consignment returns carry the same variant detail as DO items,
  --     copied from delivery_order_items / 0058) ─────────────────────────────
  gap_inches              INTEGER,
  divan_height_inches     INTEGER,
  divan_price_sen         INTEGER NOT NULL DEFAULT 0,
  leg_height_inches       INTEGER,
  leg_price_sen           INTEGER NOT NULL DEFAULT 0,
  custom_specials         JSONB,
  line_suffix             TEXT,
  special_order_price_sen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cdri_dr ON consignment_delivery_return_items(consignment_delivery_return_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. RLS — enable + permissive authenticated policy on every new table
--    (mirrors the 0073 / 0100 / 0102 pattern: read+write for any authenticated
--     staff; finer per-role gating happens at the API layer)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE consignment_sales_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_sales_order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_sales_order_payments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_delivery_orders          ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_delivery_order_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_delivery_order_payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_delivery_returns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE consignment_delivery_return_items    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cso_all   ON consignment_sales_orders;
DROP POLICY IF EXISTS csoi_all  ON consignment_sales_order_items;
DROP POLICY IF EXISTS csop_all  ON consignment_sales_order_payments;
DROP POLICY IF EXISTS cdo_all   ON consignment_delivery_orders;
DROP POLICY IF EXISTS cdoi_all  ON consignment_delivery_order_items;
DROP POLICY IF EXISTS cdop_all  ON consignment_delivery_order_payments;
DROP POLICY IF EXISTS cdr_all   ON consignment_delivery_returns;
DROP POLICY IF EXISTS cdri_all  ON consignment_delivery_return_items;

CREATE POLICY cso_all   ON consignment_sales_orders            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY csoi_all  ON consignment_sales_order_items       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY csop_all  ON consignment_sales_order_payments    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cdo_all   ON consignment_delivery_orders         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cdoi_all  ON consignment_delivery_order_items    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cdop_all  ON consignment_delivery_order_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cdr_all   ON consignment_delivery_returns        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY cdri_all  ON consignment_delivery_return_items   FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. INVENTORY IDEMPOTENCY GUARDS for the consignment stock movements.
--    inventory_movements.source_doc_type is a free TEXT column (confirmed: no
--    DB enum to alter — see 0050/0072). These mirror uq_inv_mov_do_source (0100)
--    and uq_inv_mov_dr_source (0102) so a consignment ship / return can only
--    ever move stock ONCE per (doc, product, variant) no matter how the status
--    path is advanced or how often the create is retried.
--
--      CS_DO — consignment delivery / loaner ship (value-neutral transfer OUT)
--      CS_DR — consignment return                  (value-neutral transfer IN)
-- ════════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_cs_do_source
  ON inventory_movements (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE source_doc_type = 'CS_DO';

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_cs_dr_source
  ON inventory_movements (source_doc_type, source_doc_id, product_code, variant_key)
  WHERE source_doc_type = 'CS_DR';

COMMIT;

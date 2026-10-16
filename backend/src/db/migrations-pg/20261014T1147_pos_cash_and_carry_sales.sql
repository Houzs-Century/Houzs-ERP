-- 20261014T1147_pos_cash_and_carry_sales.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS (the cash & carry booth app at pos.houzscentury.com) — step 1 of
-- the build: the "Cash & Carry" project type and the tables a synced POS sale
-- lands in. Every POS bill is saved on the device first (IndexedDB) and then
-- pushed into THESE tables, in the ERP's own Supabase Postgres, so a project
-- page can list them as POS Sales beside everything else the ERP keeps.
--
-- Nothing here touches an existing table except one INSERT into the shared
-- project_event_types master (no company_id by design, mig 0292:72), guarded
-- by ON CONFLICT so a re-run or a hand-made row of the same slug is a no-op.
--
-- REVERSAL: DROP TABLE pos_audit, pos_payments, pos_sale_lines, pos_sales
--   (in that order — the three children reference pos_sales); DELETE FROM
--   project_event_types WHERE slug = 'cash_carry' only if no project uses it
--   (projects.event_type_id is ON DELETE SET NULL on the D1 mirror, no FK in
--   PG). GRANTS: none — the tables are read through the service-role client.
-- Verified against: the migrations-pg tree (project_event_types columns from
--   0098 / routes/projects.ts INSERT shape: slug, name, sort_order,
--   default_template_id, active).
--
-- Money is integer SEN (the SCM convention, amount_sen), never a float. Lines
-- and payments live under the bill: deleting a bill (never done by the app —
-- a bill is VOIDed, not deleted) cascades its children.

SET search_path = public;

INSERT INTO project_event_types (slug, name, sort_order, default_template_id, active)
SELECT 'cash_carry', 'Cash & Carry',
       COALESCE((SELECT MAX(sort_order) FROM project_event_types), 0) + 1,
       NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM project_event_types WHERE slug = 'cash_carry');

-- ── pos_sales — one row per receipt (SALE or RETURN) ──────────────────────
CREATE TABLE IF NOT EXISTS pos_sales (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Minted on the device; the sync de-duplicates on it (POST /pos/sales/batch).
  uuid            UUID NOT NULL UNIQUE,
  company_id      BIGINT NOT NULL,
  project_id      BIGINT NOT NULL,
  terminal_code   TEXT NOT NULL,
  -- {TERM}-{000000}; R-{TERM}-{000000} for a return; {TERM}-T{00000} for test.
  receipt_no      TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'SALE' CHECK (type IN ('SALE', 'RETURN')),
  -- A RETURN references the bill it refunds / exchanges.
  ref_sale_uuid   UUID,
  cashier_id      BIGINT,
  cashier_name    TEXT,
  -- The part-timer the bill is credited to (P6); NULL = Booth (no one).
  salesman_id     BIGINT,
  salesman_name   TEXT,
  customer_name   TEXT,
  customer_phone  TEXT,
  -- The device clock at payment, kept as the bill's date for every report.
  sold_at         TIMESTAMPTZ NOT NULL,
  subtotal_sen        BIGINT NOT NULL DEFAULT 0,
  item_discount_sen   BIGINT NOT NULL DEFAULT 0,
  bill_discount_sen   BIGINT NOT NULL DEFAULT 0,
  sst_applied     BOOLEAN NOT NULL DEFAULT FALSE,
  sst_rate        NUMERIC(5, 2) NOT NULL DEFAULT 0,
  sst_amount_sen  BIGINT NOT NULL DEFAULT 0,
  rounding_sen    BIGINT NOT NULL DEFAULT 0,
  total_sen       BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'VOID')),
  void_reason     TEXT,
  void_by         TEXT,
  voided_at       TIMESTAMPTZ,
  is_test         BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT NOT NULL DEFAULT 'NORMAL' CHECK (source IN ('NORMAL', 'IMPORT')),
  -- The device's running sequence, echoed in the heartbeat so a gap shows.
  local_seq       INTEGER,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_sales_receipt UNIQUE (company_id, terminal_code, receipt_no)
);
CREATE INDEX IF NOT EXISTS idx_pos_sales_project_sold ON pos_sales (project_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_company ON pos_sales (company_id);

-- ── pos_sale_lines — the items on a receipt ───────────────────────────────
CREATE TABLE IF NOT EXISTS pos_sale_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id         BIGINT NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  -- The POS item (step 2 adds pos_items); the code + description are kept
  -- on the line so a receipt reprints exactly as sold even after a rename.
  item_id         BIGINT,
  item_code       TEXT NOT NULL,
  description     TEXT NOT NULL,
  uom             TEXT NOT NULL DEFAULT 'UNIT',
  qty             NUMERIC(12, 3) NOT NULL,
  unit_price_sen  BIGINT NOT NULL,
  -- Price override (P4): the list price it replaced and who allowed it.
  original_price_sen BIGINT,
  override_by     TEXT,
  override_reason TEXT,
  -- AUTO (pre-set in POS Items) or MANUAL; type PCT / RM; FOC flagged apart.
  discount_source TEXT CHECK (discount_source IN ('AUTO', 'MANUAL')),
  discount_type   TEXT CHECK (discount_type IN ('PCT', 'RM')),
  discount_value  NUMERIC(12, 2),
  discount_amount_sen BIGINT NOT NULL DEFAULT 0,
  is_foc          BOOLEAN NOT NULL DEFAULT FALSE,
  amount_sen      BIGINT NOT NULL,
  CONSTRAINT uq_pos_sale_lines_no UNIQUE (sale_id, line_no)
);

-- ── pos_payments — how a receipt was paid (negative = refund) ─────────────
CREATE TABLE IF NOT EXISTS pos_payments (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id         BIGINT NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('QR', 'CREDIT', 'DEBIT', 'EWALLET', 'CASH')),
  amount_sen      BIGINT NOT NULL,
  reference       TEXT,
  last4           TEXT,
  tendered_sen    BIGINT,
  change_sen      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_pos_payments_sale ON pos_payments (sale_id);

-- ── pos_audit — who changed what on a POS record (salesman reassign etc.) ─
CREATE TABLE IF NOT EXISTS pos_audit (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT NOT NULL,
  entity          TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  field           TEXT NOT NULL,
  from_value      TEXT,
  to_value        TEXT,
  by_user_id      BIGINT,
  by_name         TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pos_audit_entity ON pos_audit (entity, entity_id);

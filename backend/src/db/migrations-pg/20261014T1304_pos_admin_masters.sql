-- 20261014T1304_pos_admin_masters.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS build, step 2: the masters the ERP's POS Admin menu maintains
-- (layouts E1-E5) and the booth app later downloads as its bundle —
-- POS items (a furniture SKU tagged for the booth, with its barcodes, price,
-- pre-set discount and FOC rule), own EAN-13 barcodes generated for SKUs,
-- cashiers (part-timers with a PIN, separate from ERP users), terminals,
-- the project <-> POS link (which terminals, cashiers, catalog scope, stock
-- source, price overrides) and the settings groups (SST & receipt, printer &
-- scanner, general). New tables and one sequence only; nothing existing is
-- altered. SKUs are referenced by scm.mfg_products.id as text without a
-- cross-schema FK (the same choice as projects <-> scm elsewhere).
--
-- REVERSAL: DROP TABLE pos_event_items, pos_event_prices, pos_event_cashiers,
--   pos_event_links, pos_terminals, pos_cashiers, pos_item_barcodes,
--   pos_generated_barcodes, pos_items, pos_settings; DROP SEQUENCE
--   pos_ean13_seq. GRANTS: none (service-role reads).
-- Verified against: the migrations-pg tree; scm.mfg_products.id is text,
--   scm.warehouses.id is uuid (production catalog read 2026-10-14).

SET search_path = public;

-- ── settings, one JSON document per group per company ─────────────────────
CREATE TABLE IF NOT EXISTS pos_settings (
  company_id   BIGINT NOT NULL,
  "group"      TEXT NOT NULL CHECK ("group" IN ('sst_receipt', 'printer_scanner', 'general')),
  value        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT,
  PRIMARY KEY (company_id, "group")
);

-- ── POS items: a SKU tagged for the booth ─────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_items (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id            BIGINT NOT NULL,
  -- scm.mfg_products.id (text); the code and name are snapshots for the list.
  product_id            TEXT NOT NULL,
  item_code             TEXT NOT NULL,
  name                  TEXT NOT NULL,
  uom                   TEXT NOT NULL DEFAULT 'UNIT',
  price_sen             BIGINT NOT NULL DEFAULT 0,
  cost_sen              BIGINT,
  preset_discount_type  TEXT CHECK (preset_discount_type IN ('PCT', 'RM')),
  preset_discount_value NUMERIC(12, 2),
  foc_allowed           BOOLEAN NOT NULL DEFAULT FALSE,
  max_manual_disc_pct   NUMERIC(5, 2),
  -- scm.warehouses.id (uuid as text); NULL = the General setting's POS store.
  stock_source_warehouse_id TEXT,
  receipt_name          TEXT,
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_items_product UNIQUE (company_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_pos_items_company_code ON pos_items (company_id, item_code);

-- Extra barcodes on a POS item (a SKU's factory barcode stays on
-- scm.mfg_products.barcode; a generated own one is in pos_generated_barcodes).
CREATE TABLE IF NOT EXISTS pos_item_barcodes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  pos_item_id   BIGINT NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  barcode       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_item_barcodes UNIQUE (company_id, barcode)
);

-- Own EAN-13 generated for a SKU (layout E1b): 200 + running no + check digit,
-- kept for good so a label printed today still scans next year.
CREATE SEQUENCE IF NOT EXISTS pos_ean13_seq START 1;
CREATE TABLE IF NOT EXISTS pos_generated_barcodes (
  company_id    BIGINT NOT NULL,
  product_id    TEXT NOT NULL,
  barcode       TEXT NOT NULL UNIQUE,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by  BIGINT,
  PRIMARY KEY (company_id, product_id)
);

-- ── cashiers: part-timers, never ERP users ────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_cashiers (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT NOT NULL,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  phone              TEXT,
  -- PBKDF2 (services/auth.ts hashPassword): "salt$hash", verified offline on the device.
  pin_hash           TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'PARTTIME' CHECK (role IN ('PARTTIME', 'SUPERVISOR')),
  max_discount_pct   NUMERIC(5, 2) NOT NULL DEFAULT 0,
  working_hours_note TEXT,
  bank_note          TEXT,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_cashiers_code UNIQUE (company_id, code)
);

-- ── terminals: one row per device code the ERP hands out ─────────────────
CREATE TABLE IF NOT EXISTS pos_terminals (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT NOT NULL,
  code               TEXT NOT NULL,
  device_name        TEXT,
  platform           TEXT,
  -- The event this terminal is prepared for (projects.id); NULL = none.
  project_id         BIGINT,
  printer            TEXT,
  prepared_at        TIMESTAMPTZ,
  last_seen_at       TIMESTAMPTZ,
  last_sync_at       TIMESTAMPTZ,
  pending_count      INTEGER NOT NULL DEFAULT 0,
  pending_amount_sen BIGINT NOT NULL DEFAULT 0,
  receipt_counter    INTEGER NOT NULL DEFAULT 0,
  app_version        TEXT,
  status             TEXT NOT NULL DEFAULT 'NEW',
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  -- The device token minted at Prepare, hashed; NULL until a device prepares.
  token_hash         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_terminals_code UNIQUE (company_id, code)
);

-- ── the project <-> POS link (layout E3) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_event_links (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       BIGINT NOT NULL,
  project_id       BIGINT NOT NULL,
  catalog_scope    TEXT NOT NULL DEFAULT 'ALL' CHECK (catalog_scope IN ('ALL', 'PICK')),
  -- scm.warehouses.id (uuid as text); NULL = the General setting's POS store.
  stock_source_warehouse_id TEXT,
  sst_default      BOOLEAN NOT NULL DEFAULT FALSE,
  receipt_header   TEXT,
  -- Bumped by "Push catalog update"; the device compares it on heartbeat.
  catalog_version  INTEGER NOT NULL DEFAULT 1,
  pushed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pos_event_links_project UNIQUE (company_id, project_id)
);

CREATE TABLE IF NOT EXISTS pos_event_cashiers (
  link_id     BIGINT NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  cashier_id  BIGINT NOT NULL REFERENCES pos_cashiers (id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, cashier_id)
);

-- The pick list when catalog_scope = 'PICK'.
CREATE TABLE IF NOT EXISTS pos_event_items (
  link_id      BIGINT NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  pos_item_id  BIGINT NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, pos_item_id)
);

-- Event price overrides (layout E1 "event price override" / E3).
CREATE TABLE IF NOT EXISTS pos_event_prices (
  link_id      BIGINT NOT NULL REFERENCES pos_event_links (id) ON DELETE CASCADE,
  pos_item_id  BIGINT NOT NULL REFERENCES pos_items (id) ON DELETE CASCADE,
  price_sen    BIGINT NOT NULL,
  PRIMARY KEY (link_id, pos_item_id)
);

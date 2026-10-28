-- 0090_scm_purchase_consignment_tables.sql — create the PURCHASE CONSIGNMENT
-- table set on PROD. The routes are already mounted (backend/src/scm/index.ts →
-- /purchase-consignment-orders|receives|returns) and STAGING has the tables,
-- but prod's scm schema never got them, so the module 500s at runtime on prod.
--
-- DDL derived from the 2990 source migrations (0154_purchase_consignment_module
-- + 0155_pc_receive_warehouse + 0181_pc_supplier_delivery_dates), cross-checked
-- against what the vendored routes actually SELECT/INSERT
-- (backend/src/scm/routes/purchase-consignment-*.ts — code is ground truth for
-- column names). Houzs port conventions (mirrors 0080/0081):
--   * schema-qualified to scm.*; NO inner BEGIN/COMMIT (pg-migrate owns the
--     transaction); every DO $$ ... $$ block on ONE line (';\n' splitter).
--   * created_by kept uuid but NO FK to scm.staff (0081 precedent).
--   * status enums reuse the existing scm.po_status / scm.grn_status types
--     (present on prod — migrations 0042/0043 ALTER them);
--     scm.purchase_return_status is created-if-missing below.
--   * currency = text DEFAULT 'MYR' (0081 precedent; routes gate values).
--   * FKs kept where PostgREST embeds depend on them (suppliers, the
--     intra-module order->receive->return chain) and where ON DELETE behaviour
--     is load-bearing (order_items CASCADE — the routes hard-delete a CANCELLED
--     PC Order and rely on the cascade).
--   * company_id bigint NOT NULL + FK public.companies + index from day one
--     (0083 already carries guarded stamp blocks for these six tables, which
--     no-op'd on prod because the tables were absent; the drift blocks at the
--     bottom re-run that stamp for any DB — e.g. staging — where the tables
--     pre-exist without company_id).
--   * RLS stripped (Houzs guards in the route + service-role key).
--
-- Idempotent + re-run-safe: CREATE TABLE/INDEX IF NOT EXISTS throughout, ADD
-- COLUMN IF NOT EXISTS for the 0155/0181 late columns, so the file is a no-op
-- on staging where the tables already exist.

-- Enum: purchase_return_status may already exist (out-of-band scm port) -------
DO $$ BEGIN CREATE TYPE scm.purchase_return_status AS ENUM ('DRAFT', 'POSTED', 'COMPLETED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. PC ORDER (clone of purchase_orders; 2990 0154 §1 + 0181) -----------------
CREATE TABLE IF NOT EXISTS scm.purchase_consignment_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_number            text NOT NULL UNIQUE,
  supplier_id          uuid NOT NULL REFERENCES scm.suppliers(id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL,
  status               scm.po_status NOT NULL DEFAULT 'SUBMITTED',
  po_date              date NOT NULL DEFAULT current_date,
  expected_at          date,
  currency             text NOT NULL DEFAULT 'MYR',
  subtotal_centi       integer NOT NULL DEFAULT 0,
  tax_centi            integer NOT NULL DEFAULT 0,
  total_centi          integer NOT NULL DEFAULT 0,
  notes                text,
  submitted_at         timestamptz,
  received_at          timestamptz,
  cancelled_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  purchase_location_id uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  supplier_delivery_date_2 date,
  supplier_delivery_date_3 date,
  supplier_delivery_date_4 date,
  company_id           bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pco_supplier ON scm.purchase_consignment_orders (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pco_status ON scm.purchase_consignment_orders (status);
CREATE INDEX IF NOT EXISTS idx_pco_purchase_location ON scm.purchase_consignment_orders (purchase_location_id);

CREATE TABLE IF NOT EXISTS scm.purchase_consignment_order_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_order_id uuid NOT NULL REFERENCES scm.purchase_consignment_orders(id) ON DELETE CASCADE,
  binding_id              uuid REFERENCES scm.supplier_material_bindings(id) ON DELETE SET NULL,
  material_kind           scm.material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  supplier_sku            text,
  qty                     integer NOT NULL,
  unit_price_centi        integer NOT NULL,
  line_total_centi        integer NOT NULL,
  received_qty            integer NOT NULL DEFAULT 0,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  discount_centi          integer NOT NULL DEFAULT 0,
  unit_cost_centi         integer NOT NULL DEFAULT 0,
  delivery_date           date,
  warehouse_id            uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  supplier_delivery_date_2 date,
  supplier_delivery_date_3 date,
  supplier_delivery_date_4 date,
  company_id              bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pcoi_po ON scm.purchase_consignment_order_items (purchase_consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_pcoi_warehouse ON scm.purchase_consignment_order_items (warehouse_id);

-- 2. PC RECEIVE (clone of grns; 2990 0154 §2 + 0155 warehouse_id) -------------
CREATE TABLE IF NOT EXISTS scm.purchase_consignment_receives (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receive_number      text NOT NULL UNIQUE,
  purchase_consignment_order_id uuid REFERENCES scm.purchase_consignment_orders(id) ON DELETE SET NULL,
  pc_order_no         text,
  supplier_id         uuid NOT NULL REFERENCES scm.suppliers(id) ON DELETE RESTRICT,
  received_at         date NOT NULL DEFAULT current_date,
  delivery_note_ref   text,
  status              scm.grn_status NOT NULL DEFAULT 'POSTED',
  notes               text,
  posted_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  currency            text NOT NULL DEFAULT 'MYR',
  subtotal_centi      integer NOT NULL DEFAULT 0,
  tax_centi           integer NOT NULL DEFAULT 0,
  total_centi         integer NOT NULL DEFAULT 0,
  warehouse_id        uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  company_id          bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pcr_po ON scm.purchase_consignment_receives (purchase_consignment_order_id);
CREATE INDEX IF NOT EXISTS idx_pcr_supplier ON scm.purchase_consignment_receives (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcr_status ON scm.purchase_consignment_receives (status);

CREATE TABLE IF NOT EXISTS scm.purchase_consignment_receive_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_receive_id           uuid NOT NULL REFERENCES scm.purchase_consignment_receives(id) ON DELETE CASCADE,
  pc_order_item_id        uuid REFERENCES scm.purchase_consignment_order_items(id) ON DELETE SET NULL,
  material_kind           scm.material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  qty_received            integer NOT NULL,
  qty_accepted            integer NOT NULL,
  qty_rejected            integer NOT NULL DEFAULT 0,
  rejection_reason        text,
  unit_price_centi        integer NOT NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  discount_centi          integer NOT NULL DEFAULT 0,
  line_total_centi        integer NOT NULL DEFAULT 0,
  delivery_date           date,
  unit_cost_centi         integer NOT NULL DEFAULT 0,
  supplier_sku            text,
  invoiced_qty            integer NOT NULL DEFAULT 0,
  returned_qty            integer NOT NULL DEFAULT 0,
  rack_id                 uuid REFERENCES scm.warehouse_racks(id) ON DELETE SET NULL,
  company_id              bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pcri_receive ON scm.purchase_consignment_receive_items (pc_receive_id);

-- 3. PC RETURN (clone of purchase_returns; 2990 0154 §3) ----------------------
CREATE TABLE IF NOT EXISTS scm.purchase_consignment_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number     text NOT NULL UNIQUE,
  pc_order_id       uuid REFERENCES scm.purchase_consignment_orders(id) ON DELETE SET NULL,
  pc_receive_id     uuid REFERENCES scm.purchase_consignment_receives(id) ON DELETE SET NULL,
  supplier_id       uuid NOT NULL REFERENCES scm.suppliers(id) ON DELETE RESTRICT,
  return_date       date NOT NULL DEFAULT current_date,
  reason            text,
  status            scm.purchase_return_status NOT NULL DEFAULT 'POSTED',
  posted_at         timestamptz,
  completed_at      timestamptz,
  credit_note_ref   text,
  refund_centi      integer NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  company_id        bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pcret_po ON scm.purchase_consignment_returns (pc_order_id);
CREATE INDEX IF NOT EXISTS idx_pcret_receive ON scm.purchase_consignment_returns (pc_receive_id);
CREATE INDEX IF NOT EXISTS idx_pcret_supplier ON scm.purchase_consignment_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pcret_status ON scm.purchase_consignment_returns (status);

CREATE TABLE IF NOT EXISTS scm.purchase_consignment_return_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_consignment_return_id uuid NOT NULL REFERENCES scm.purchase_consignment_returns(id) ON DELETE CASCADE,
  pc_receive_item_id      uuid REFERENCES scm.purchase_consignment_receive_items(id) ON DELETE SET NULL,
  material_kind           scm.material_kind NOT NULL,
  material_code           text NOT NULL,
  material_name           text NOT NULL,
  qty_returned            integer NOT NULL,
  unit_price_centi        integer NOT NULL DEFAULT 0,
  line_refund_centi       integer NOT NULL DEFAULT 0,
  reason                  text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  gap_inches              integer,
  divan_height_inches     integer,
  divan_price_sen         integer NOT NULL DEFAULT 0,
  leg_height_inches       integer,
  leg_price_sen           integer NOT NULL DEFAULT 0,
  custom_specials         jsonb,
  line_suffix             text,
  special_order_price_sen integer NOT NULL DEFAULT 0,
  variants                jsonb,
  item_group              text,
  description             text,
  description2            text,
  uom                     text NOT NULL DEFAULT 'UNIT',
  company_id              bigint NOT NULL REFERENCES public.companies(id)
);
CREATE INDEX IF NOT EXISTS idx_pcreti_return ON scm.purchase_consignment_return_items (purchase_consignment_return_id);

-- 4. Drift repair for PRE-EXISTING tables (staging) ---------------------------
-- On a DB where the tables already existed (so the CREATEs above no-op'd),
-- add any late columns the vendored routes select (0155 / 0181) ...
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
ALTER TABLE scm.purchase_consignment_receives ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL;

-- ... and re-run the 0083-style company_id stamp (no-op where the CREATEs above
-- just built the column in; backfills + hardens it where the tables pre-existed
-- without company_id).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_orders' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_orders ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_orders SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_orders ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_orders ADD CONSTRAINT purchase_consignment_orders_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_orders_company_id ON scm.purchase_consignment_orders (company_id); END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_order_items' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_order_items SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_order_items ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_order_items ADD CONSTRAINT purchase_consignment_order_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_order_items_company_id ON scm.purchase_consignment_order_items (company_id); END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_receives' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_receives ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_receives SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_receives ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_receives ADD CONSTRAINT purchase_consignment_receives_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_receives_company_id ON scm.purchase_consignment_receives (company_id); END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_receive_items' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_receive_items ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_receive_items SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_receive_items ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_receive_items ADD CONSTRAINT purchase_consignment_receive_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_receive_items_company_id ON scm.purchase_consignment_receive_items (company_id); END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_returns' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_returns ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_returns SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_returns ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_returns ADD CONSTRAINT purchase_consignment_returns_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_returns_company_id ON scm.purchase_consignment_returns (company_id); END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='purchase_consignment_return_items' AND column_name='company_id') THEN ALTER TABLE scm.purchase_consignment_return_items ADD COLUMN company_id bigint; UPDATE scm.purchase_consignment_return_items SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.purchase_consignment_return_items ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.purchase_consignment_return_items ADD CONSTRAINT purchase_consignment_return_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; CREATE INDEX IF NOT EXISTS idx_purchase_consignment_return_items_company_id ON scm.purchase_consignment_return_items (company_id); END $$;

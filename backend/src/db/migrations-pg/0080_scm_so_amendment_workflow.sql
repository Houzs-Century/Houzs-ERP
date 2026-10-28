-- 0080_scm_so_amendment_workflow.sql — port of 2990 migration 0210 into scm.
-- A supplier-confirmed, two-gate amendment revises a PROCESSING-LOCKED SO and its
-- bound PO in place (same number + a `revision` counter), snapshotting every prior
-- version. Adds the scm.so_amendment_status enum, the so_amendments /
-- so_amendment_lines request tables, the so_revisions / po_revisions snapshot
-- tables, and a `revision` counter column on scm.mfg_sales_orders +
-- scm.purchase_orders. Keyed on so_doc_no (text -> scm.mfg_sales_orders.doc_no)
-- like every other SO child. See wenwei4046/2990s migration 0210.
--
-- Houzs conventions (mirrors 0053_scm_delivery_planning_tms.sql):
--   * schema-qualified to scm.*; SET search_path = scm, public.
--   * NO inner BEGIN/COMMIT — the pg-migrate runner owns ONE transaction.
--   * pg-migrate splits on /;\s*\n/ and does NOT respect $$; every DO $$ ... $$
--     block is therefore written ON ONE LINE (internal ';' space-separated).
--   * RLS / is_staff() stripped (Houzs guards writes in the route + service-role
--     key). Additive + run-once + IF NOT EXISTS -> re-run safe.
--
-- VIEW-TRAP NOTE (CoE 2026-06-26 P-2): the new `revision` column added to
-- scm.mfg_sales_orders is a plain ALTER TABLE ADD COLUMN on the BASE table only.
-- It is deliberately NOT added to the column-enumerated view
-- scm.mfg_sales_orders_with_payment_totals (which this migration never touches),
-- so the SO LIST view stays valid. The SO Detail route reads `revision` straight
-- off the base table (see mfg-sales-orders.ts GET /:docNo).
--
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).

SET search_path = scm, public;

-- Enum -----------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE scm.so_amendment_status AS ENUM ('REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Request tables -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.so_amendments (
  id                                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no                          text NOT NULL,
  amendment_no                       text NOT NULL,
  status                             scm.so_amendment_status NOT NULL DEFAULT 'REQUESTED',
  reason                             text,
  requested_by                       uuid,
  supplier_confirmed_by              uuid,
  supplier_confirmation_ref          text,
  supplier_confirmation_note         text,
  supplier_confirmation_attachment_key text,
  so_approved_by                     uuid,
  so_approved_at                     timestamptz,
  po_approved_by                     uuid,
  po_approved_at                     timestamptz,
  sent_at                            timestamptz,
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm.so_amendment_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_id        uuid NOT NULL,
  sales_order_item_id uuid,
  change_type         text NOT NULL,
  new_item_code       text,
  new_variants        jsonb,
  new_qty             integer,
  new_unit_price_sen  integer,
  old_snapshot        jsonb
);

-- Snapshot tables ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.so_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_doc_no    text NOT NULL,
  revision     integer NOT NULL,
  snapshot     jsonb NOT NULL,
  amendment_id uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scm.po_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id        uuid NOT NULL,
  revision     integer NOT NULL,
  snapshot     jsonb NOT NULL,
  amendment_id uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Foreign keys (one-line DO guards; ADD CONSTRAINT is not IF-NOT-EXISTS-able) --
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_so_doc_no_fk FOREIGN KEY (so_doc_no) REFERENCES scm.mfg_sales_orders(doc_no) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_requested_by_fk FOREIGN KEY (requested_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_supplier_confirmed_by_fk FOREIGN KEY (supplier_confirmed_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_so_approved_by_fk FOREIGN KEY (so_approved_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_po_approved_by_fk FOREIGN KEY (po_approved_by) REFERENCES scm.staff(id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.so_amendment_lines ADD CONSTRAINT so_amendment_lines_amendment_id_fk FOREIGN KEY (amendment_id) REFERENCES scm.so_amendments(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes --------------------------------------------------------------------
-- One OPEN amendment per SO (not SENT/REJECTED) — partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_so_amendment_open ON scm.so_amendments (so_doc_no) WHERE status NOT IN ('SENT','REJECTED');
CREATE INDEX IF NOT EXISTS idx_so_amendment_so ON scm.so_amendments (so_doc_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_so_revision ON scm.so_revisions (so_doc_no, revision);
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_revision ON scm.po_revisions (po_id, revision);

-- Revision counter on the live documents -------------------------------------
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE scm.purchase_orders  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

-- Multi-company scoping (Phase 0b) -------------------------------------------
-- Plain NULLABLE company_id, NO foreign key + NO NOT-NULL: the `companies`
-- master doesn't exist until Phase 0f, so a FK / NOT-NULL would fail applying
-- now. stampCompany / activeCompanyId(c) fills it once multi-company is active
-- (NULL for single-company Houzs today); a later 0f migration can add the FK.
-- Mirrors the company_id column mig 0061 stamped on the 118 existing
-- per-company tables. Additive + IF NOT EXISTS -> re-run safe.
ALTER TABLE scm.so_amendments      ADD COLUMN IF NOT EXISTS company_id bigint;
ALTER TABLE scm.so_amendment_lines ADD COLUMN IF NOT EXISTS company_id bigint;
ALTER TABLE scm.so_revisions       ADD COLUMN IF NOT EXISTS company_id bigint;
ALTER TABLE scm.po_revisions       ADD COLUMN IF NOT EXISTS company_id bigint;
CREATE INDEX IF NOT EXISTS idx_so_amendments_company      ON scm.so_amendments (company_id);
CREATE INDEX IF NOT EXISTS idx_so_amendment_lines_company ON scm.so_amendment_lines (company_id);
CREATE INDEX IF NOT EXISTS idx_so_revisions_company       ON scm.so_revisions (company_id);
CREATE INDEX IF NOT EXISTS idx_po_revisions_company       ON scm.po_revisions (company_id);

-- Fixture for the PostgREST contract check of the SO list line filters
-- (.github/workflows/postgrest-contract-so-list-filters.yml). Same shape and rows as
-- backend/tests-pg/soListLineFilterFields.pg.test.ts. Disposable database only.
CREATE SCHEMA IF NOT EXISTS scm;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
DROP TABLE IF EXISTS scm.so_amendments CASCADE;
DROP TABLE IF EXISTS scm.mfg_sales_order_items CASCADE;
DROP TABLE IF EXISTS scm.mfg_sales_order_payments CASCADE;
DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
DO $$ BEGIN CREATE TYPE scm.so_amendment_status AS ENUM ('REQUESTED','SUPPLIER_PENDING','SO_APPROVED','PO_APPROVED','SENT','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE scm.mfg_sales_orders (
  doc_no text PRIMARY KEY, company_id bigint NOT NULL, status text, local_total_sen bigint DEFAULT 0
);
CREATE TABLE scm.mfg_sales_order_payments (so_doc_no text, amount_sen bigint);
CREATE TABLE scm.mfg_sales_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, company_id bigint NOT NULL,
  item_group text, warehouse_id uuid, cancelled boolean NOT NULL DEFAULT false
);
CREATE TABLE scm.so_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, company_id bigint NOT NULL,
  status scm.so_amendment_status NOT NULL DEFAULT 'REQUESTED', lane text
);
CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
  SELECT so.doc_no, so.status, so.local_total_sen, so.company_id,
         COALESCE(p.paid_total, 0::bigint) AS paid_total_sen,
         so.local_total_sen - COALESCE(p.paid_total, 0::bigint) AS balance_sen_live
    FROM scm.mfg_sales_orders so
    LEFT JOIN (SELECT so_doc_no, sum(amount_sen) AS paid_total FROM scm.mfg_sales_order_payments GROUP BY so_doc_no) p
      ON p.so_doc_no = so.doc_no;

INSERT INTO scm.mfg_sales_orders (doc_no, company_id, status) VALUES
  ('SO-1', 1, 'CONFIRMED'), ('SO-2', 1, 'CONFIRMED'), ('SO-3', 1, 'CONFIRMED'),
  ('SO-4', 1, 'CONFIRMED'), ('SO-5', 1, 'CONFIRMED'), ('SO-X', 2, 'CONFIRMED');
INSERT INTO scm.mfg_sales_order_items (doc_no, company_id, item_group, warehouse_id, cancelled) VALUES
  ('SO-1', 1, 'SOFA', '11111111-1111-4111-8111-111111111111', false),
  ('SO-1', 1, 'ACCESSORY', '22222222-2222-4222-8222-222222222222', false),
  ('SO-2', 1, 'Mattress ', '22222222-2222-4222-8222-222222222222', false),
  ('SO-2', 1, 'BEDFRAME', NULL, false),
  ('SO-3', 1, 'SOFA', '11111111-1111-4111-8111-111111111111', true),
  ('SO-3', 1, 'SERVICE', NULL, false),
  ('SO-X', 2, 'SOFA', '11111111-1111-4111-8111-111111111111', false),
  ('SO-4', 2, 'SOFA', '11111111-1111-4111-8111-111111111111', false);
INSERT INTO scm.so_amendments (so_doc_no, company_id, status, lane) VALUES
  ('SO-1', 1, 'REQUESTED', 'header'),
  ('SO-2', 1, 'SO_APPROVED', 'lines'),
  ('SO-3', 1, 'PO_APPROVED', NULL),
  ('SO-4', 1, 'SENT', NULL),
  ('SO-5', 1, 'REJECTED', 'header'),
  ('SO-X', 2, 'REQUESTED', 'header');

GRANT USAGE ON SCHEMA scm TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA scm TO service_role;

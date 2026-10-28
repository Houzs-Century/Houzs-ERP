-- 20260906T1500_ap_invoices.sql
-- REVERSAL: DROP VIEW IF EXISTS scm.v_ap_aging; then recreate the pre-existing view verbatim from 0305_money_centi_to_sen.sql:397 (purchase_invoices only); DROP FUNCTION IF EXISTS scm.settle_api_paid_sen(uuid, bigint); ALTER TABLE scm.pv_allocations DROP CONSTRAINT IF EXISTS pv_allocations_one_target; ALTER TABLE scm.pv_allocations DROP CONSTRAINT IF EXISTS pv_allocations_ap_invoice_id_fk; ALTER TABLE scm.pv_allocations DROP COLUMN IF EXISTS ap_invoice_id; ALTER TABLE scm.pv_allocations ALTER COLUMN pi_id SET NOT NULL; DROP TABLE IF EXISTS scm.ap_invoice_lines; DROP TABLE IF EXISTS scm.ap_invoices;
--   GRANTS: scm.v_ap_aging carries NO explicit role grants to re-apply — like 0305's eleven recreated views, service_role reads it through the scm schema's default privileges (verified 2026-09-06 on prod AND staging: information_schema.role_table_grants is empty for v_ap_aging, v_ar_aging and v_gl_entries alike). The DROP below therefore discards no ACL, and the reverse re-grants nothing — re-check the same query before running it.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two new empty tables, one new function, one nullable column + a CHECK on
--   scm.pv_allocations that every existing row already satisfies (pi_id set,
--   ap_invoice_id null → exactly one target), and scm.v_ap_aging rebuilt as a
--   UNION with a trailing `kind` column — every existing column keeps its
--   name, order and meaning; status becomes text (it was the PI enum), which
--   the one reader (GET /accounting/ap-aging → the frontend row type, string)
--   already treats as text. No row is written.
--
-- WHY (owner, 2026-09-06, AutoCount in hand): 可以不可以像 autocount 这样
-- purchase invoice 一边,然后再多一个 AP invoice,这样我就可以把 other creditor
-- 的 invoice 放过去,也不会影响 operation 那边的 purchase invoice. The AP
-- INVOICE is the non-stock supplier bill — rent, services, an other
-- creditor's charge — raised on the Finance side, posted Dr the lines' own
-- accounts / Cr the supplier's AP control (400 or 405 by the supplier's code),
-- paid by the same AP Payment that pays purchase invoices: an allocation now
-- names a purchase invoice OR an AP invoice, and the clamp that stops two
-- vouchers over-paying one invoice has an identical twin for this table.
-- The Procurement purchase-invoice list is untouched; the Finance list shows
-- both kinds (his rule: 我想要两个都看到, 现有的 purchase invoice remain).
--
-- Verified against: staging apply via apply_migration (probe in the PR body —
-- tables present, constraint accepted by every existing pv_allocations row,
-- view returns PI rows with kind = 'PI') and backend/tests/apInvoices.test.ts
-- (the route contract on the fake harness).

CREATE TABLE IF NOT EXISTS scm.ap_invoices (
  id                   uuid           NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           bigint         NOT NULL,
  invoice_number       text           NOT NULL,
  supplier_id          uuid           NOT NULL REFERENCES scm.suppliers(id),
  supplier_invoice_ref text,
  invoice_date         date           NOT NULL,
  due_date             date,
  currency             text           NOT NULL DEFAULT 'MYR',
  exchange_rate        numeric(14,6)  NOT NULL DEFAULT 1,
  total_sen            bigint         NOT NULL DEFAULT 0,
  paid_sen             bigint         NOT NULL DEFAULT 0,
  status               text           NOT NULL DEFAULT 'DRAFT', -- DRAFT | POSTED | PARTIALLY_PAID | PAID | CANCELLED
  notes                text,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  created_by           text,
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  posted_at            timestamptz,
  posted_by            text,
  cancelled_at         timestamptz,
  cancelled_by         text,
  UNIQUE (company_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_ap_invoices_company_supplier ON scm.ap_invoices (company_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_ap_invoices_company_status   ON scm.ap_invoices (company_id, status);

CREATE TABLE IF NOT EXISTS scm.ap_invoice_lines (
  id                 uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id         bigint NOT NULL,
  invoice_id         uuid   NOT NULL REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  line_no            int    NOT NULL,
  description        text,
  debit_account_code text   NOT NULL,
  amount_sen         bigint NOT NULL CHECK (amount_sen > 0)
);
CREATE INDEX IF NOT EXISTS idx_ap_invoice_lines_invoice ON scm.ap_invoice_lines (invoice_id);

-- An allocation names a purchase invoice OR an AP invoice — exactly one.
ALTER TABLE scm.pv_allocations ALTER COLUMN pi_id DROP NOT NULL;
ALTER TABLE scm.pv_allocations ADD COLUMN IF NOT EXISTS ap_invoice_id uuid;
DO $$ BEGIN
  ALTER TABLE scm.pv_allocations ADD CONSTRAINT pv_allocations_ap_invoice_id_fk
    FOREIGN KEY (ap_invoice_id) REFERENCES scm.ap_invoices(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE scm.pv_allocations ADD CONSTRAINT pv_allocations_one_target
    CHECK (num_nonnulls(pi_id, ap_invoice_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_pv_allocations_ap_invoice ON scm.pv_allocations (ap_invoice_id);

-- The twin of scm.settle_pi_paid_sen (0305): row lock, clamp at write time,
-- returns what it applied. Same shape so lib/ap-invoice-settlement.ts reads it
-- exactly the way lib/pi-settlement.ts reads its sibling.
CREATE OR REPLACE FUNCTION scm.settle_api_paid_sen(p_id uuid, p_delta bigint)
 RETURNS TABLE(applied_sen bigint, new_paid_sen bigint, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_old_paid   bigint;
  v_total      bigint;
  v_status     text;
  v_new_paid   bigint;
  v_new_status text;
BEGIN
  IF p_id IS NULL OR p_delta IS NULL OR p_delta = 0 THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'no_delta'::text; RETURN;
  END IF;

  SELECT COALESCE(paid_sen, 0), COALESCE(total_sen, 0), status
    INTO v_old_paid, v_total, v_status
    FROM ap_invoices
   WHERE id = p_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'not_found'::text; RETURN;
  END IF;

  IF upper(COALESCE(v_status, '')) IN ('DRAFT', 'CANCELLED') THEN
    RETURN QUERY SELECT 0::bigint, v_old_paid, v_status, 'not_live'::text; RETURN;
  END IF;

  IF p_delta > 0 THEN
    v_new_paid := GREATEST(v_old_paid, LEAST(v_total, v_old_paid + p_delta));
  ELSE
    v_new_paid := GREATEST(0, v_old_paid + p_delta);
  END IF;

  UPDATE ap_invoices
     SET paid_sen   = v_new_paid,
         status     = CASE
                        WHEN v_new_paid >= v_total THEN 'PAID'
                        WHEN v_new_paid > 0        THEN 'PARTIALLY_PAID'
                        ELSE                            'POSTED'
                      END,
         updated_at = now()
   WHERE id = p_id
  RETURNING status INTO v_new_status;

  RETURN QUERY SELECT (v_new_paid - v_old_paid), v_new_paid, v_new_status, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION scm.settle_api_paid_sen(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.settle_api_paid_sen(uuid, bigint) TO service_role;

-- AP aging lists BOTH kinds; `kind` trails so every existing column keeps
-- its place. DROP + CREATE (not REPLACE): status changes type to text.
DROP VIEW IF EXISTS scm.v_ap_aging;
CREATE VIEW scm.v_ap_aging AS
 SELECT p.id AS invoice_id,
    p.invoice_number,
    p.supplier_invoice_ref,
    p.supplier_id,
    sup.code AS supplier_code,
    sup.name AS supplier_name,
    p.invoice_date,
    p.due_date,
    p.total_sen,
    p.paid_sen,
    p.total_sen - p.paid_sen AS outstanding_sen,
    CASE WHEN p.due_date IS NULL OR p.due_date >= CURRENT_DATE THEN 0 ELSE CURRENT_DATE - p.due_date END AS days_overdue,
    CASE
      WHEN p.due_date IS NULL OR p.due_date >= CURRENT_DATE THEN 'CURRENT'::text
      WHEN (CURRENT_DATE - p.due_date) >= 1 AND (CURRENT_DATE - p.due_date) <= 30 THEN '1-30'::text
      WHEN (CURRENT_DATE - p.due_date) >= 31 AND (CURRENT_DATE - p.due_date) <= 60 THEN '31-60'::text
      WHEN (CURRENT_DATE - p.due_date) >= 61 AND (CURRENT_DATE - p.due_date) <= 90 THEN '61-90'::text
      ELSE '90+'::text
    END AS aging_bucket,
    p.status::text AS status,
    p.company_id,
    'PI'::text AS kind
   FROM scm.purchase_invoices p
   LEFT JOIN scm.suppliers sup ON sup.id = p.supplier_id
  WHERE p.total_sen > p.paid_sen
    AND p.status <> ALL (ARRAY['CANCELLED'::scm.purchase_invoice_status, 'VOID'::scm.purchase_invoice_status])
 UNION ALL
 SELECT a.id,
    a.invoice_number,
    a.supplier_invoice_ref,
    a.supplier_id,
    sup.code,
    sup.name,
    a.invoice_date,
    a.due_date,
    a.total_sen,
    a.paid_sen,
    a.total_sen - a.paid_sen,
    CASE WHEN a.due_date IS NULL OR a.due_date >= CURRENT_DATE THEN 0 ELSE CURRENT_DATE - a.due_date END,
    CASE
      WHEN a.due_date IS NULL OR a.due_date >= CURRENT_DATE THEN 'CURRENT'::text
      WHEN (CURRENT_DATE - a.due_date) >= 1 AND (CURRENT_DATE - a.due_date) <= 30 THEN '1-30'::text
      WHEN (CURRENT_DATE - a.due_date) >= 31 AND (CURRENT_DATE - a.due_date) <= 60 THEN '31-60'::text
      WHEN (CURRENT_DATE - a.due_date) >= 61 AND (CURRENT_DATE - a.due_date) <= 90 THEN '61-90'::text
      ELSE '90+'::text
    END,
    a.status,
    a.company_id,
    'API'::text
   FROM scm.ap_invoices a
   LEFT JOIN scm.suppliers sup ON sup.id = a.supplier_id
  WHERE a.total_sen > a.paid_sen
    AND a.status NOT IN ('DRAFT', 'CANCELLED');

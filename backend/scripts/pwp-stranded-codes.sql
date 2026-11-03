-- PWP codes stranded on a different customer than their source SO now has (Hub 2990-0037).
-- RE-RUN: paste into the Supabase SQL editor on production (anogrigyjbduyzclzjgn). Steps 1-2 are read-only.

-- 1. Count per company.
SELECT c.company_id, count(*) AS stranded_available_codes
FROM scm.pwp_codes c
JOIN scm.mfg_sales_orders so ON so.doc_no = c.source_doc_no AND so.company_id = c.company_id
WHERE c.status = 'AVAILABLE'
  AND so.customer_id IS NOT NULL
  AND c.customer_id IS DISTINCT FROM so.customer_id
GROUP BY c.company_id ORDER BY c.company_id;

-- 2. The rows (check old and new names are the same person before step 3).
SELECT c.company_id, c.code, c.source_doc_no, c.customer_id AS code_customer_id,
       oc.name AS code_customer_name, oc.phone AS code_customer_phone,
       so.customer_id AS so_customer_id, so.debtor_name, so.phone AS so_phone
FROM scm.pwp_codes c
JOIN scm.mfg_sales_orders so ON so.doc_no = c.source_doc_no AND so.company_id = c.company_id
LEFT JOIN scm.customers oc ON oc.id = c.customer_id
WHERE c.status = 'AVAILABLE'
  AND so.customer_id IS NOT NULL
  AND c.customer_id IS DISTINCT FROM so.customer_id
ORDER BY c.company_id, c.source_doc_no, c.code;

-- 3. BACKFILL. Run with ROLLBACK first, compare the row count with step 1, then change to COMMIT.
BEGIN;
UPDATE scm.pwp_codes c
SET customer_id = so.customer_id, updated_at = now()
FROM scm.mfg_sales_orders so
WHERE so.doc_no = c.source_doc_no AND so.company_id = c.company_id
  AND c.status = 'AVAILABLE'
  AND so.customer_id IS NOT NULL
  AND c.customer_id IS DISTINCT FROM so.customer_id
RETURNING c.company_id, c.code, c.source_doc_no, c.customer_id;
ROLLBACK;
-- REVERSAL: save the step 2 output first, then per code:
-- UPDATE scm.pwp_codes SET customer_id = '<code_customer_id>' WHERE code = '<code>' AND company_id = <company_id>;

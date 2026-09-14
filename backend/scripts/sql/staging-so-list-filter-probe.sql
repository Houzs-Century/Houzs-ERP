-- Variant comparison for the SO list line-level computed fields: the shipped SQL
-- bodies vs plpgsql bodies vs SQL bodies using ARRAY(subquery). Everything is
-- created inside ONE transaction and ROLLED BACK. STAGING only (the workflow
-- refuses any other project). Count query only, company with most orders.
BEGIN;
\i backend/src/db/migrations-pg/20260914T1600_scm_so_list_line_filter_fields.sql

CREATE FUNCTION scm.pv_wh_plpgsql(so scm.mfg_sales_orders_with_payment_totals) RETURNS uuid[] LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN ARRAY(SELECT DISTINCT i.warehouse_id FROM scm.mfg_sales_order_items i
                WHERE i.doc_no = so.doc_no AND i.company_id = so.company_id AND i.cancelled = false AND i.warehouse_id IS NOT NULL);
END $f$;
CREATE FUNCTION scm.pv_wh_sqlarray(so scm.mfg_sales_orders_with_payment_totals) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT ARRAY(SELECT DISTINCT i.warehouse_id FROM scm.mfg_sales_order_items i
                WHERE i.doc_no = so.doc_no AND i.company_id = so.company_id AND i.cancelled = false AND i.warehouse_id IS NOT NULL)
$f$;
CREATE FUNCTION scm.pv_cat_plpgsql(so scm.mfg_sales_orders_with_payment_totals) RETURNS text[] LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN ARRAY(SELECT DISTINCT CASE
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%BEDFRAME%' THEN 'BEDFRAME'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%SOFA%'     THEN 'SOFA'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%MATTRESS%' THEN 'MATTRESS'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%ACCESSOR%' THEN 'ACCESSORY'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%SERVICE%'  THEN 'SERVICE'
             ELSE 'OTHERS' END
           FROM scm.mfg_sales_order_items i WHERE i.doc_no = so.doc_no AND i.company_id = so.company_id AND i.cancelled = false);
END $f$;
CREATE FUNCTION scm.pv_amend_plpgsql(so scm.mfg_sales_orders_with_payment_totals) RETURNS boolean LANGUAGE plpgsql STABLE AS $f$
BEGIN
  RETURN EXISTS (SELECT 1 FROM scm.so_amendments a WHERE a.so_doc_no = so.doc_no AND a.company_id = so.company_id
                   AND a.status NOT IN ('SENT', 'REJECTED') AND (a.lane IS NULL OR a.status = 'REQUESTED'));
END $f$;
GRANT EXECUTE ON FUNCTION scm.pv_wh_plpgsql(scm.mfg_sales_orders_with_payment_totals), scm.pv_wh_sqlarray(scm.mfg_sales_orders_with_payment_totals),
  scm.pv_cat_plpgsql(scm.mfg_sales_orders_with_payment_totals), scm.pv_amend_plpgsql(scm.mfg_sales_orders_with_payment_totals) TO service_role;

SET LOCAL ROLE service_role;
SET LOCAL transaction_read_only = on;
select company_id as cid from scm.mfg_sales_orders group by 1 order by count(*) desc limit 1 \gset
select i.warehouse_id as wid from scm.mfg_sales_order_items i join scm.mfg_sales_orders s on s.doc_no = i.doc_no
 where s.company_id = :cid and i.warehouse_id is not null and not i.cancelled group by 1 order by count(*) desc limit 1 \gset

\echo --- warm-up
select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid];
\echo --- W1 shipped sql array_agg
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid];
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid];
\echo --- W2 plpgsql
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_wh_plpgsql(v) && array[:'wid'::uuid];
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_wh_plpgsql(v) && array[:'wid'::uuid];
\echo --- W3 sql ARRAY(subquery)
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_wh_sqlarray(v) && array[:'wid'::uuid];
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_wh_sqlarray(v) && array[:'wid'::uuid];
\echo --- C1 shipped sql categories
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_categories(v) && array['SOFA'];
\echo --- C2 plpgsql categories
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_cat_plpgsql(v) && array['SOFA'];
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_cat_plpgsql(v) && array['SOFA'];
\echo --- A1 shipped sql amendment
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_has_open_amendment(v) is true;
\echo --- A2 plpgsql amendment
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_amend_plpgsql(v) is true;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.pv_amend_plpgsql(v) is true;
\echo --- status tab already chosen (CONFIRMED) then sofa, shipped sql
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and v.status = 'CONFIRMED' and scm.so_line_categories(v) && array['SOFA'];
\echo === identical answers
select
  count(*) filter (where scm.so_line_warehouse_ids(v) && array[:'wid'::uuid]) as w1,
  count(*) filter (where scm.pv_wh_plpgsql(v) && array[:'wid'::uuid]) as w2,
  count(*) filter (where scm.pv_wh_sqlarray(v) && array[:'wid'::uuid]) as w3,
  count(*) filter (where scm.so_line_categories(v) && array['SOFA']) as c1,
  count(*) filter (where scm.pv_cat_plpgsql(v) && array['SOFA']) as c2,
  count(*) filter (where scm.so_has_open_amendment(v)) as a1,
  count(*) filter (where scm.pv_amend_plpgsql(v)) as a2
  from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;
ROLLBACK;
\echo === after rollback
select count(*) as leftover_functions from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'scm' and (p.proname like 'pv\_%' or p.proname in ('so_line_warehouse_ids', 'so_line_categories', 'so_has_open_amendment'));

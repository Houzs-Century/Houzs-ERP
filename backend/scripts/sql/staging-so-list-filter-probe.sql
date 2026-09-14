-- Timings for the SO list line-level filters AS SHIPPED: the computed-field
-- functions from migrations-pg 20260914T1600 are created inside a transaction,
-- measured through the view as service_role, and ROLLED BACK — nothing is left
-- on the database. Run by .github/workflows/staging-so-list-filter-probe.yml
-- against STAGING only (the workflow refuses any other project).
\echo === PostgREST connections on this project (application_name carries its version)
select distinct application_name from pg_stat_activity where application_name ilike '%postgrest%';
BEGIN;
\i backend/src/db/migrations-pg/20260914T1600_scm_so_list_line_filter_fields.sql
SET LOCAL ROLE service_role;
SET LOCAL transaction_read_only = on;

select company_id as cid from scm.mfg_sales_orders group by 1 order by count(*) desc limit 1 \gset
select i.warehouse_id as wid from scm.mfg_sales_order_items i join scm.mfg_sales_orders s on s.doc_no = i.doc_no
 where s.company_id = :cid and i.warehouse_id is not null and not i.cancelled group by 1 order by count(*) desc limit 1 \gset
\echo === company :cid, warehouse :wid

\echo --- A baseline (no second-level filter): page / count / grouped status / money
explain (analyze) select doc_no from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid order by so_date desc, doc_no desc limit 50;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;
explain (analyze) select status, count(doc_no) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid group by status;
explain (analyze) select sum(local_total_sen), sum(balance_sen_live), sum(paid_total_sen) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;

\echo --- B warehouse via scm.so_line_warehouse_ids
explain (analyze) select doc_no from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid] order by so_date desc, doc_no desc limit 50;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid];
explain (analyze) select status, count(doc_no) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid] group by status;
explain (analyze) select sum(local_total_sen), sum(balance_sen_live), sum(paid_total_sen) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid];

\echo --- C sofa via scm.so_line_categories
explain (analyze) select doc_no from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_categories(v) && array['SOFA'] order by so_date desc, doc_no desc limit 50;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_categories(v) && array['SOFA'];
explain (analyze) select status, count(doc_no) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_categories(v) && array['SOFA'] group by status;
explain (analyze) select sum(local_total_sen), sum(balance_sen_live), sum(paid_total_sen) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_line_categories(v) && array['SOFA'];

\echo --- D open amendment via scm.so_has_open_amendment
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_has_open_amendment(v) is true;
explain (analyze) select status, count(doc_no) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid and scm.so_has_open_amendment(v) is true group by status;

\echo --- E all three together (the heaviest realistic request): count
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid
  and scm.so_line_warehouse_ids(v) && array[:'wid'::uuid] and scm.so_line_categories(v) && array['SOFA'] and scm.so_has_open_amendment(v) is false;

\echo === matches
select
  count(*) filter (where scm.so_line_warehouse_ids(v) && array[:'wid'::uuid]) as in_top_warehouse,
  count(*) filter (where scm.so_line_categories(v) && array['SOFA']) as sofa,
  count(*) filter (where scm.so_line_categories(v) && array['BEDFRAME']) as bedframe,
  count(*) filter (where scm.so_line_categories(v) && array['MATTRESS']) as mattress,
  count(*) filter (where scm.so_line_categories(v) && array['ACCESSORY']) as accessory,
  count(*) filter (where scm.so_has_open_amendment(v)) as open_amendment,
  count(*) as all_orders
  from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;

ROLLBACK;
\echo === after rollback the functions do not exist
select count(*) as leftover_functions from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'scm' and p.proname in ('so_line_warehouse_ids', 'so_line_categories', 'so_has_open_amendment');

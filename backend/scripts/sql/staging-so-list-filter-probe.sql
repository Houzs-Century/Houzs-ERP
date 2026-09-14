-- Read-only census + timings for the SO list line-level filters. Run by
-- .github/workflows/staging-so-list-filter-probe.yml against STAGING only.
-- Everything is inside a READ ONLY transaction that ends in ROLLBACK.
BEGIN READ ONLY;
SET LOCAL ROLE service_role;

\echo === companies
select id, code from public.companies order by id;

\echo === header branding per company
select company_id, count(*) as total,
       count(*) filter (where coalesce(btrim(branding), '') = '') as blank,
       count(*) filter (where upper(btrim(branding)) in ('NONE','N/A','NA','NIL','TBC','KIV','-','--','---')) as placeholder
  from scm.mfg_sales_orders group by 1 order by 1;
select company_id, upper(btrim(branding)) as branding, count(*) from scm.mfg_sales_orders group by 1, 2 order by 1, 3 desc;

\echo === columns present
select table_name, column_name from information_schema.columns
 where table_schema = 'scm'
   and ((table_name = 'mfg_sales_order_items' and column_name in ('company_id','warehouse_id','item_group','cancelled','branding'))
     or (table_name = 'so_amendments' and column_name in ('company_id','lane','status'))
     or (table_name = 'warehouses' and column_name in ('company_id','active','code','name','is_active')))
 order by 1, 2;

\echo === item_group on live lines
select upper(btrim(item_group)) as item_group, count(*) from scm.mfg_sales_order_items where not cancelled group by 1 order by 2 desc;

\echo === live lines with no warehouse / orders spanning more than one warehouse
select count(*) filter (where warehouse_id is null) as no_warehouse, count(*) as lines from scm.mfg_sales_order_items where not cancelled;
select count(*) as multi_warehouse_orders from (
  select doc_no from scm.mfg_sales_order_items where not cancelled and warehouse_id is not null
   group by doc_no having count(distinct warehouse_id) > 1) x;

\echo === amendments by status and lane
select status, (lane is null) as legacy, count(*) from scm.so_amendments group by 1, 2 order by 1, 2;

\echo === children whose company differs from their order
select count(*) as line_mismatched from scm.mfg_sales_order_items i join scm.mfg_sales_orders s on s.doc_no = i.doc_no where i.company_id is distinct from s.company_id;
select count(*) as amend_mismatched from scm.so_amendments a join scm.mfg_sales_orders s on s.doc_no = a.so_doc_no where a.company_id is distinct from s.company_id;

select company_id as cid from scm.mfg_sales_orders group by 1 order by count(*) desc limit 1 \gset
select i.warehouse_id as wid from scm.mfg_sales_order_items i join scm.mfg_sales_orders s on s.doc_no = i.doc_no
 where s.company_id = :cid and i.warehouse_id is not null and not i.cancelled group by 1 order by count(*) desc limit 1 \gset
\echo === timings: company :cid, warehouse :wid

\echo --- A baseline: page and count, no second-level filter
explain (analyze, buffers) select doc_no from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid order by so_date desc, doc_no desc limit 50;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;

\echo --- B warehouse: page and count
explain (analyze, buffers) select doc_no from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid
   and exists (select 1 from scm.mfg_sales_order_items i
                where i.doc_no = v.doc_no and i.company_id = v.company_id and not i.cancelled and i.warehouse_id = :'wid'::uuid)
 order by so_date desc, doc_no desc limit 50;
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid
   and exists (select 1 from scm.mfg_sales_order_items i
                where i.doc_no = v.doc_no and i.company_id = v.company_id and not i.cancelled and i.warehouse_id = :'wid'::uuid);

\echo --- C category SOFA: grouped status count and money sums
explain (analyze) select status, count(doc_no) from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid
   and exists (select 1 from scm.mfg_sales_order_items i
                where i.doc_no = v.doc_no and i.company_id = v.company_id and not i.cancelled
                  and upper(i.item_group) like '%SOFA%' and upper(i.item_group) not like '%BEDFRAME%')
 group by status;
explain (analyze) select sum(local_total_sen), sum(balance_sen_live), sum(paid_total_sen) from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid
   and exists (select 1 from scm.mfg_sales_order_items i
                where i.doc_no = v.doc_no and i.company_id = v.company_id and not i.cancelled
                  and upper(i.item_group) like '%SOFA%' and upper(i.item_group) not like '%BEDFRAME%');

\echo --- D open amendment: count
explain (analyze) select count(*) from scm.mfg_sales_orders_with_payment_totals v
 where v.company_id = :cid
   and exists (select 1 from scm.so_amendments a where a.so_doc_no = v.doc_no and a.company_id = v.company_id
                and a.status not in ('SENT','REJECTED') and (a.lane is null or a.status = 'REQUESTED'));

\echo === how many orders each filter matches
select
  count(*) filter (where exists (select 1 from scm.mfg_sales_order_items i where i.doc_no = v.doc_no and not i.cancelled and i.warehouse_id = :'wid'::uuid)) as in_top_warehouse,
  count(*) filter (where exists (select 1 from scm.mfg_sales_order_items i where i.doc_no = v.doc_no and not i.cancelled and upper(i.item_group) like '%SOFA%')) as with_sofa,
  count(*) filter (where exists (select 1 from scm.so_amendments a where a.so_doc_no = v.doc_no and a.status not in ('SENT','REJECTED') and (a.lane is null or a.status = 'REQUESTED'))) as open_amendment,
  count(*) as all_orders
  from scm.mfg_sales_orders_with_payment_totals v where v.company_id = :cid;

\echo === indexes on the two child tables
select tablename, indexdef from pg_indexes where schemaname = 'scm' and tablename in ('mfg_sales_order_items','so_amendments') order by 1;

\echo === PostgREST version hint (computed-field / function filter support)
select name, setting from pg_settings where name like 'pgrst.%';

ROLLBACK;

/* READ-ONLY, TEMPORARY (removed before merge). Sizes the populations the
 * hard-bound PO-link source fixes touch, on production:
 *   1. allocation splits on hard-bound PO lines (company 1)
 *   2. linked PO lines whose group disagrees with the SO line's (by bound-ness)
 *   3. open SO lines / live PO lines whose item_group differs from their SKU's category
 *   4. manual PO amendments carrying ADD lines
 * SELECT only. RE-RUN: stateless.
 */
import postgres from 'postgres';

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });
const HB = (t) => sql`(lower(coalesce(${sql(t)}.item_group,'')) in ('sofa','bedframe','fabric_accessory')
  or (lower(coalesce(${sql(t)}.item_group,'')) = 'mattress' and ${sql(t)}.item_code ~* '\\(SP\\)\\s*$'))`;
const SO_OPEN = sql`h.status::text not in ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')`;
try {
  line('=== 1. allocations on hard-bound PO lines ===');
  const [a] = await sql`
    select count(*)::int as alloc_rows_all,
           count(distinct al.purchase_order_item_id)::int as lines_all,
           count(*) filter (where it.company_id = 1 and ${HB('it')})::int as alloc_rows_c1_hb,
           count(distinct al.purchase_order_item_id) filter (where it.company_id = 1 and ${HB('it')})::int as lines_c1_hb,
           count(distinct al.purchase_order_item_id) filter (where it.company_id = 1 and ${HB('it')} and p.status::text not in ('CANCELLED','DRAFT'))::int as lines_c1_hb_live,
           count(distinct al.purchase_order_item_id) filter (where it.company_id = 1 and ${HB('it')} and p.status::text not in ('CANCELLED','DRAFT') and coalesce(it.qty,0) > coalesce(it.received_qty,0))::int as lines_c1_hb_live_open
      from scm.purchase_order_item_allocations al
      join scm.purchase_order_items it on it.id = al.purchase_order_item_id
      join scm.purchase_orders p on p.id = it.purchase_order_id`;
  line(`   ${JSON.stringify(a)}`);
  const [a2] = await sql`
    select count(distinct al.purchase_order_item_id)::int as c1_lines_alloc_to_hb_so
      from scm.purchase_order_item_allocations al
      join scm.purchase_order_items it on it.id = al.purchase_order_item_id
      join scm.mfg_sales_order_items i on i.id = al.so_item_id
     where it.company_id = 1 and ${HB('i')}`;
  line(`   company-1 PO lines with an allocation slice naming a hard-bound SO line: ${a2.c1_lines_alloc_to_hb_so}`);

  line('=== 2. linked live PO lines whose bound-ness disagrees with the SO line ===');
  const grp = await sql`
    select it.company_id,
           count(*) filter (where ${HB('it')} and not ${HB('i')})::int as po_bound_so_not,
           count(*) filter (where not ${HB('it')} and ${HB('i')})::int as so_bound_po_not,
           count(*) filter (where (${HB('it')} or ${HB('i')}) and lower(coalesce(it.item_group,'')) <> lower(coalesce(i.item_group,'')))::int as any_bound_group_differs,
           count(*) filter (where (${HB('it')} or ${HB('i')}) and lower(coalesce(it.item_group,'')) <> lower(coalesce(i.item_group,'')) and ${SO_OPEN} and i.cancelled = false)::int as any_bound_group_differs_open_so
      from scm.purchase_order_items it
      join scm.purchase_orders p on p.id = it.purchase_order_id
      join scm.mfg_sales_order_items i on i.id = it.so_item_id
      join scm.mfg_sales_orders h on h.doc_no = i.doc_no
     where p.status::text <> 'CANCELLED'
     group by it.company_id order by 1`;
  for (const r of grp) line(`   ${JSON.stringify(r)}`);
  const ex = await sql`
    select it.company_id, p.po_number, it.item_code, it.item_group as po_group, i.doc_no, i.item_group as so_group, h.status::text as so_status, it.received_qty
      from scm.purchase_order_items it
      join scm.purchase_orders p on p.id = it.purchase_order_id
      join scm.mfg_sales_order_items i on i.id = it.so_item_id
      join scm.mfg_sales_orders h on h.doc_no = i.doc_no
     where p.status::text <> 'CANCELLED' and (${HB('it')} or ${HB('i')})
       and lower(coalesce(it.item_group,'')) <> lower(coalesce(i.item_group,''))
       and ${SO_OPEN} and i.cancelled = false
     order by 1, 2 limit 40`;
  for (const r of ex) line(`   ex ${JSON.stringify(r)}`);

  line('=== 3. item_group vs SKU category drift ===');
  const soDrift = await sql`
    select i.company_id,
           count(*)::int as open_lines,
           count(*) filter (where lower(coalesce(i.item_group,'')) <> lower(pr.category::text))::int as drift,
           count(*) filter (where lower(coalesce(i.item_group,'')) <> lower(pr.category::text)
             and (${HB('i')} or lower(pr.category::text) in ('sofa','bedframe','fabric_accessory')))::int as drift_bound_either
      from scm.mfg_sales_order_items i
      join scm.mfg_sales_orders h on h.doc_no = i.doc_no
      join scm.mfg_products pr on pr.code = i.item_code and pr.company_id = i.company_id
     where i.cancelled = false and ${SO_OPEN}
     group by 1 order by 1`;
  for (const r of soDrift) line(`   SO ${JSON.stringify(r)}`);
  const soDriftEx = await sql`
    select i.company_id, i.item_group, pr.category::text as sku_category, count(*)::int as n
      from scm.mfg_sales_order_items i
      join scm.mfg_sales_orders h on h.doc_no = i.doc_no
      join scm.mfg_products pr on pr.code = i.item_code and pr.company_id = i.company_id
     where i.cancelled = false and ${SO_OPEN}
       and lower(coalesce(i.item_group,'')) <> lower(pr.category::text)
     group by 1,2,3 order by 4 desc limit 30`;
  for (const r of soDriftEx) line(`   SO pair ${JSON.stringify(r)}`);
  const poDrift = await sql`
    select it.company_id,
           count(*)::int as live_lines,
           count(*) filter (where lower(coalesce(it.item_group,'')) <> lower(pr.category::text))::int as drift,
           count(*) filter (where lower(coalesce(it.item_group,'')) <> lower(pr.category::text)
             and (${HB('it')} or lower(pr.category::text) in ('sofa','bedframe','fabric_accessory')))::int as drift_bound_either
      from scm.purchase_order_items it
      join scm.purchase_orders p on p.id = it.purchase_order_id
      join scm.mfg_products pr on pr.code = it.item_code and pr.company_id = it.company_id
     where p.status::text not in ('CANCELLED') and coalesce(it.qty,0) > coalesce(it.received_qty,0)
     group by 1 order by 1`;
  for (const r of poDrift) line(`   PO ${JSON.stringify(r)}`);

  line('=== 4. PO amendments ===');
  const [pa] = await sql`
    select count(distinct a.id)::int as amendments,
           count(distinct a.id) filter (where a.source_so_amendment_id is null)::int as manual,
           count(distinct a.id) filter (where a.source_so_amendment_id is null and upper(l.change_type) = 'ADD')::int as manual_with_add,
           count(distinct a.id) filter (where a.source_so_amendment_id is not null and upper(l.change_type) = 'ADD')::int as sourced_with_add
      from scm.po_amendments a left join scm.po_amendment_lines l on l.amendment_id = a.id`;
  line(`   ${JSON.stringify(pa)}`);

  line('=== 5. company-1 live hard-bound PO lines linked with SO line not in open demand ===');
  const [u] = await sql`
    select count(*) filter (where it.so_item_id is null)::int as unlinked_open,
           count(*) filter (where it.so_item_id is not null)::int as linked_open
      from scm.purchase_order_items it
      join scm.purchase_orders p on p.id = it.purchase_order_id
     where it.company_id = 1 and ${HB('it')} and p.status::text not in ('CANCELLED','DRAFT')
       and coalesce(it.qty,0) > coalesce(it.received_qty,0)`;
  line(`   ${JSON.stringify(u)}`);
} finally {
  await sql.end();
}

#!/usr/bin/env node
// READ-ONLY. What the DO hard-binding fix does NOT repair.
//
// Company 1 binds a bedframe / sofa / (SP) mattress line to the purchase order
// raised from it: the line reads READY off its OWN received_qty and never looks
// at the shared stock bucket. The delivery guard now honours that — but only
// when the warehouse still HOLDS the goods, because the earmark says which
// units are this line's, not that they exist.
//
// This check answers the two questions that survive the fix:
//
//   1. WHERE HAVE THE GOODS GONE? Lines whose own PO was received and whose
//      warehouse holds nothing. For these the old "stock not enough" warning
//      was RIGHT: something already shipped those units out, or they never got
//      keyed in. Each one is a physical question for the warehouse, not a code
//      question.
//   2. HOW DEEP IS THE HOLE? Negative stock buckets, which is what Ship-anyway
//      leaves behind. Service lines are counted separately: they never move
//      stock at all, so a negative service bucket is bookkeeping noise, not
//      missing furniture.
//
// Read-only by construction: SELECTs only, no transaction, no DDL, no write.
// Exit 0 for every legitimate answer — the answer IS the output; a non-zero
// exit means the database could not be read.
//
// RE-RUN: safe and expected. Nothing is written, so a second run just
// re-measures; the numbers move as stock moves.
//
// ENUM TRAP: status columns are enums — ::text before comparing.
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }
const COMPANY = Number(process.env.COMPANY ?? 1);

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

/* The SO line carries the item group the business actually assigned, so the
   negative buckets are labelled from it rather than from a category join — an
   item nobody ever sold has no group to show, and saying so is the honest
   answer. */
const neg = await sql`
  with codes as (
    select item_code, min(lower(coalesce(item_group::text,''))) as grp
    from scm.mfg_sales_order_items where company_id = ${COMPANY} group by 1
  )
  select coalesce(nullif(k.grp,''),'(never sold)') as grp,
         count(*)::int as buckets, sum(b.qty)::numeric as units,
         count(*) filter (where coalesce(b.variant_key,'') = '')::int as blank_key
  from scm.inventory_balances b
  left join codes k on k.item_code = b.item_code
  where b.company_id = ${COMPANY} and b.qty < 0
  group by 1 order by units`;

console.log(`\n=== NEGATIVE STOCK BUCKETS (company ${COMPANY}) ===`);
console.log(`${pad('GROUP', 22)}${pad('BUCKETS', 9)}${pad('UNITS', 9)}blank-variant`);
for (const r of neg) {
  console.log(`${pad(r.grp, 22)}${pad(r.buckets, 9)}${pad(r.units, 9)}${r.blank_key}`);
}
const hardBound = neg.filter((r) => r.grp === 'bedframe' || r.grp === 'sofa');
const hbBuckets = hardBound.reduce((a, r) => a + r.buckets, 0);
const hbUnits = hardBound.reduce((a, r) => a + Number(r.units), 0);
console.log(`\nBedframe + sofa: ${hbBuckets} bucket(s), ${hbUnits} unit(s) — this is the Ship-anyway hole.`);
console.log('Service lines never move stock, so their negatives are noise, not missing goods.');

const gap = await sql`
  with live as (
    select i.id, i.doc_no, i.item_code, i.qty, i.warehouse_id, i.stock_status::text as st,
           lower(coalesce(i.item_group::text,'')) as grp, s.debtor_name
    from scm.mfg_sales_order_items i
    join scm.mfg_sales_orders s on s.doc_no = i.doc_no
    where i.company_id = ${COMPANY} and i.cancelled = false and i.qty > 0
      and s.status::text not in ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
      and (lower(coalesce(i.item_group::text,'')) in ('bedframe','sofa')
        or (lower(coalesce(i.item_group::text,'')) = 'mattress' and i.item_code like '%(SP)%'))
  ),
  recv as (
    select poi.so_item_id, sum(coalesce(poi.received_qty,0))::numeric as got,
           string_agg(distinct po.po_number, ' ') as pos
    from scm.purchase_order_items poi
    join scm.purchase_orders po on po.id = poi.purchase_order_id
    where po.status::text <> 'CANCELLED' and poi.so_item_id is not null
    group by 1
  ),
  onhand as (
    select warehouse_id, item_code, sum(qty)::numeric as qty
    from scm.inventory_balances where company_id = ${COMPANY} group by 1,2
  )
  select l.doc_no, l.debtor_name, l.item_code, l.qty::int as need, l.st, r.pos,
         coalesce(w.name, w.code, '(no warehouse)') as wh,
         coalesce(o.qty,0)::numeric as on_hand
  from live l
  join recv r on r.so_item_id = l.id and r.got >= l.qty
  left join onhand o on o.warehouse_id = l.warehouse_id and o.item_code = l.item_code
  left join scm.warehouses w on w.id = l.warehouse_id
  where coalesce(o.qty,0) < l.qty
  order by l.doc_no`;

console.log(`\n=== RECEIVED ON ITS OWN PO, BUT THE WAREHOUSE HOLDS NOTHING (${gap.length}) ===`);
console.log('The delivery screen is RIGHT to warn on these. Somebody has to find the goods.');
console.log(`${pad('SALES ORDER', 16)}${pad('CUSTOMER', 20)}${pad('ITEM', 26)}${pad('NEED', 5)}${pad('WAREHOUSE', 22)}${pad('ON HAND', 8)}PO`);
for (const r of gap) {
  console.log(`${pad(r.doc_no, 16)}${pad(r.debtor_name, 20)}${pad(r.item_code, 26)}${pad(r.need, 5)}${pad(r.wh, 22)}${pad(r.on_hand, 8)}${r.pos ?? ''}`);
}
console.log(`::notice::${hbBuckets} negative bedframe/sofa bucket(s) totalling ${hbUnits} unit(s); ${gap.length} received line(s) whose warehouse holds nothing`);

await sql.end();

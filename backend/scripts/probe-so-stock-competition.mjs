#!/usr/bin/env node
/* Who else is claiming the units behind one SO's stored-PENDING lines?
   Read-only. SELECT only, no DDL, no writes, no transaction.

   The auto-allocation sweep (scm/lib/so-stock-allocation.ts) walks live SO
   lines in ONE global priority order — customer_delivery_date ASC NULLS LAST,
   then created_at ASC (:112-128) — and for a non-bound, non-sofa line grants
   READY only when its EXACT bucket (warehouse::item_code::variant_key) still
   holds enough (:490-499). Mattress lines key to variant '' (shared/variant-key
   .ts:76), so their bucket is the blank-variant bucket.

   So a line can sit stored-PENDING with stock physically on hand for exactly
   two reasons, and they have OPPOSITE fixes:
     (A) an EARLIER-priority live line already consumed the bucket  -> the
         stored PENDING is CORRECT and the drill's live-MRP READY pill is the
         misleading one;
     (B) nothing else claims it -> the stored PENDING is STALE and a recompute
         would flip it READY.
   This probe distinguishes them by listing every competing live claim in the
   sweep's own priority order and comparing the total need to the on-hand qty.

   DOCNO=2990-SO-2608-004 node scripts/probe-so-stock-competition.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOCNO = (process.env.DOCNO || '').trim();
if (!DOCNO) { console.error('need DOCNO'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pad = (s, n) => String(s ?? '').padEnd(n);

/* The sweep's live-SO lens — shared/so-terminal-states.ts:42-44. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];

async function main() {
  note(`doc_no=${DOCNO}`);

  /* The target order's own stored-not-READY, non-service lines. */
  const mine = await sql`
    SELECT i.id::text AS id, i.item_code, i.item_group, i.qty,
           i.stock_status, i.warehouse_id::text AS warehouse_id,
           i.stock_qty_ready
      FROM scm.mfg_sales_order_items i
     WHERE i.doc_no = ${DOCNO}::text
       AND i.cancelled = false
       AND COALESCE(i.stock_status,'') <> 'READY'
       AND COALESCE(UPPER(i.item_group),'') NOT LIKE '%SERVICE%'
     ORDER BY i.item_code`;
  note(`stored-not-READY non-service lines on ${DOCNO}: ${mine.length}`);

  for (const l of mine) {
    console.log('');
    console.log('='.repeat(78));
    note(`LINE ${l.item_code}  group=${l.item_group}  qty=${l.qty}  stored=${l.stock_status}  wh=${String(l.warehouse_id).slice(0, 8)}`);

    /* On-hand for this code, every warehouse + variant bucket. */
    const bal = await sql`
      SELECT b.warehouse_id::text AS warehouse_id, COALESCE(w.name,'?') AS wh_name,
             COALESCE(b.variant_key,'') AS variant_key, b.qty
        FROM scm.inventory_balances b
        LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
       WHERE b.product_code = ${l.item_code}::text
       ORDER BY b.qty DESC`;
    note(`  on-hand rows for ${l.item_code}: ${bal.length}`);
    let onHandSameBucket = 0;
    for (const b of bal) {
      const same = b.warehouse_id === l.warehouse_id && b.variant_key === '';
      if (same) onHandSameBucket += Number(b.qty || 0);
      note(`    ${pad(b.wh_name, 26)} qty=${String(b.qty).padStart(4)} key="${b.variant_key}"${same ? '  <-- THIS LINE\'S BUCKET' : ''}`);
    }
    note(`  units in THIS LINE'S bucket (wh::code::''): ${onHandSameBucket}`);

    /* Every LIVE claim on the same code, in the sweep's priority order. */
    const claims = await sql`
      SELECT i.id::text AS id, i.doc_no, o.company_id, o.status::text AS status,
             i.qty, i.stock_status, i.warehouse_id::text AS warehouse_id,
             o.customer_delivery_date::text AS cdd,
             o.created_at::text AS created_at,
             o.proceeded_at IS NULL AS alloc_gated,
             COALESCE((SELECT SUM(d.qty) FROM scm.delivery_order_items d
                        JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
                       WHERE d.so_item_id = i.id
                         AND COALESCE(dh.status::text,'') <> ALL (ARRAY['CANCELLED','DRAFT'])), 0) AS delivered
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
       WHERE i.item_code = ${l.item_code}::text
         AND i.cancelled = false
         AND o.status::text <> ALL (${TERMINAL}::text[])
       ORDER BY o.customer_delivery_date ASC NULLS LAST, o.created_at ASC`;
    note(`  LIVE competing claims on ${l.item_code} (sweep priority order): ${claims.length}`);
    let rank = 0, cumNeedSameBucket = 0;
    for (const cl of claims) {
      rank += 1;
      const sameBucket = cl.warehouse_id === l.warehouse_id;
      const need = Math.max(0, Number(cl.qty || 0) - Number(cl.delivered || 0));
      if (sameBucket && !cl.alloc_gated) cumNeedSameBucket += need;
      const isMe = cl.id === l.id;
      note(`    #${String(rank).padStart(2)} ${pad(cl.doc_no, 20)} co=${cl.company_id} ${pad(cl.status, 14)} qty=${cl.qty} delivered=${cl.delivered} need=${need} stored=${pad(cl.stock_status, 8)} cdd=${pad(cl.cdd, 12)} gated=${cl.alloc_gated}${sameBucket ? ' SAME-WH' : ' other-wh'}${isMe ? '  <== THIS LINE' : ''}`);
      if (isMe) note(`         cumulative un-gated same-warehouse need UP TO AND INCLUDING this line: ${cumNeedSameBucket}  (on hand ${onHandSameBucket})`);
    }
    note(`  VERDICT: ${cumNeedSameBucket > onHandSameBucket
      ? `(A) OVERSUBSCRIBED — earlier claims consume the bucket; stored PENDING is CORRECT`
      : `(B) NOT oversubscribed — bucket covers every claim up to this line; stored PENDING looks STALE`}`);
  }

  console.log('');
  console.log('='.repeat(78));
  note('=== when did the stock arrive vs when was the line last touched ===');
  const lots = await sql`
    SELECT l.product_code, l.batch_no, l.qty_remaining,
           l.received_at::text AS received_at, l.source_doc_type,
           w.name AS wh_name
      FROM scm.inventory_lots l
      LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
     WHERE l.product_code = ANY (${mine.map((m) => m.item_code)}::text[])
       AND l.qty_remaining > 0
     ORDER BY l.received_at ASC`;
  for (const lo of lots) {
    note(`  ${pad(lo.product_code, 26)} lot batch=${pad(lo.batch_no, 18)} rem=${lo.qty_remaining} recv=${lo.received_at} src=${lo.source_doc_type} wh=${lo.wh_name}`);
  }

  const upd = await sql`
    SELECT doc_no, updated_at::text AS updated_at, status
      FROM scm.mfg_sales_orders WHERE doc_no = ${DOCNO}::text`;
  for (const u of upd) note(`  header ${u.doc_no} status=${u.status} updated_at=${u.updated_at}`);

  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });

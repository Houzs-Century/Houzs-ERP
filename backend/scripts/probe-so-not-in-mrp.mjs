#!/usr/bin/env node
/* Why is this sales order absent from MRP? Read-only.

   MRP's demand read (routes/mrp.ts) keeps a line only when ALL of these hold,
   and the page then HIDES what is left over one more rule. This asks the
   database for each one, for a named SO, and prints which one it fails —
   rather than reasoning about it from the screen.

     1. so.status NOT IN the done list
     2. line.cancelled = false
     3. line.item_code IS NOT NULL
     4. line.qty > 0
     5. qty - (delivered - returned) > 0
     6. DATED: line_delivery_date OR so.customer_delivery_date is present.
        An undated line stays in the allocation and, since 2026-08-18, is shown
        on the page by default too (untick SHOW NO-DATE to hide it).

   Writes nothing. DOC=HC-SO-2608-003 node scripts/probe-so-not-in-mrp.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOCS = (process.env.DOC || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOC="HC-SO-2608-003"'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The done list, copied from routes/mrp.ts. If these drift the probe lies, so
   it prints them and the header status side by side for a human to compare. */
const SO_DONE = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];

async function main() {
  for (const doc of DOCS) {
    note(`\n${'='.repeat(72)}\n=== ${doc} ===`);

    const [h] = await sql`
      SELECT doc_no, status, company_id, so_date::text AS so_date,
             customer_delivery_date::text AS customer_delivery_date,
             processing_date::text AS processing_date,
             proceeded_at::text AS proceeded_at,
             sales_location, customer_state, debtor_name
        FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
    if (!h) { note(`  NO SUCH SALES ORDER (in scm.mfg_sales_orders)`); continue; }

    note(`  status            ${h.status}${SO_DONE.includes(h.status) ? '   <-- IN THE DONE LIST: every line is dropped from demand' : ''}`);
    note(`  company_id        ${h.company_id}`);
    note(`  so_date           ${h.so_date ?? '(null)'}`);
    note(`  processing_date   ${h.processing_date ?? '(null)'}`);
    note(`  customer_delivery ${h.customer_delivery_date ?? '(null)'}${h.customer_delivery_date ? '' : '   <-- HEADER HAS NO DELIVERY DATE'}`);
    note(`  proceeded_at      ${h.proceeded_at ?? '(null)'}`);
    note(`  sales_location    ${h.sales_location ?? '(null)'}    customer_state ${h.customer_state ?? '(null)'}`);

    const lines = await sql`
      SELECT id::text AS id, line_no, item_code, item_group, qty, cancelled,
             line_delivery_date::text AS line_delivery_date,
             warehouse_id::text AS warehouse_id,
             stock_status, variants::text AS variants
        FROM scm.mfg_sales_order_items
       WHERE doc_no = ${doc} ORDER BY line_no`;
    note(`\n  ${lines.length} line(s):`);
    for (const l of lines) {
      const dated = Boolean(l.line_delivery_date ?? h.customer_delivery_date);
      const fails = [];
      if (SO_DONE.includes(h.status)) fails.push('header status is done');
      if (l.cancelled) fails.push('cancelled');
      if (!l.item_code) fails.push('no item_code');
      if (!(l.qty > 0)) fails.push('qty <= 0');
      note(`\n   line ${l.line_no}  ${l.item_code ?? '(no item_code)'}  [${l.item_group ?? '-'}]  qty=${l.qty}  cancelled=${l.cancelled}`);
      note(`      stock_status        ${l.stock_status ?? '(null)'}`);
      note(`      line_delivery_date  ${l.line_delivery_date ?? '(null)'}`);
      note(`      warehouse_id        ${l.warehouse_id ?? '(null)'}${l.warehouse_id ? '' : '   <-- no warehouse on the line'}`);
      note(`      DATED for MRP?      ${dated ? 'yes' : 'NO — shown by default, marked "No date", sorted last'}`);
      note(`      variants            ${(l.variants ?? '').slice(0, 160)}`);
      if (fails.length) note(`      DROPPED FROM DEMAND: ${fails.join('; ')}`);
      else if (!dated) note(`      IN the allocation, and ON the page since 2026-08-18 (marked "No date")`);
      else note(`      passes every demand filter — it should be on the MRP page`);
    }

    /* Does the product master know this code? MRP needs a category for every
       demanded SKU, and a code the master does not hold is its own failure. */
    const codes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
    if (codes.length) {
      const known = await sql`SELECT code, category, company_id FROM scm.mfg_products WHERE code = ANY(${codes})`;
      const seen = new Map(known.map((k) => [k.code, k]));
      note(`\n  product master:`);
      for (const c of codes) {
        const k = seen.get(c);
        note(`    ${String(c).padEnd(26)} ${k ? `category=${k.category ?? '(null)'} company=${k.company_id}` : 'NOT IN scm.mfg_products'}`);
      }
    }
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });

#!/usr/bin/env node
/* The supply side of one SO line, as RAW ROWS. Read-only.

   The demand side already checks out: probe-so-not-in-mrp says HC-SO-2608-003
   passes every MRP demand filter. So either supply covers it (no shortage, and
   ONLY SHORTAGES hides it) or something after the allocation drops it.

   This does NOT re-implement MRP's bucket key. Re-deriving a shared rule in a
   second place is the bug class this repo keeps paying for, and a probe that
   computes its own answer can agree with itself while disagreeing with the
   page. It prints the rows MRP reads — every inventory_balances row for the
   code, and every open purchase_order_items row for it — with their warehouse
   and variant_key, and lets a human compare.

   CODE="JAGER-(K)" WH=24f982eb-... node scripts/probe-mrp-supply.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CODES = (process.env.CODE || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!CODES.length) { console.error('need CODE="JAGER-(K)"'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* PO statuses MRP treats as dead supply — routes/mrp.ts. Printed beside each
   row so a status outside this list is visible rather than assumed. */
const PO_DEAD = ['CANCELLED', 'CLOSED', 'DRAFT'];

async function main() {
  for (const code of CODES) {
    note(`\n${'='.repeat(72)}\n=== ${code} (company ${CO}) ===`);

    const bal = await sql`
      SELECT b.item_code, b.warehouse_id::text AS warehouse_id, w.name AS warehouse,
             coalesce(b.variant_key,'') AS variant_key, b.qty
        FROM scm.inventory_balances b
        LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
       WHERE b.company_id = ${CO} AND b.item_code = ${code}
       ORDER BY w.name, b.variant_key`;
    note(`\n  inventory_balances: ${bal.length} row(s)`);
    for (const b of bal) note(`    ${String(b.warehouse ?? b.warehouse_id).padEnd(18)} qty=${String(b.qty).padStart(5)}  variant_key=${JSON.stringify(b.variant_key)}`);
    if (!bal.length) note(`    (none — MRP sees ZERO stock for this code anywhere)`);

    const po = await sql`
      SELECT p.po_number, p.status, i.qty, coalesce(i.received_qty,0) AS received_qty,
             i.warehouse_id::text AS warehouse_id, i.variants::text AS variants,
             i.delivery_date::text AS delivery_date, p.expected_at::text AS expected_at
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE i.company_id = ${CO} AND i.item_code = ${code}
       ORDER BY p.po_number`;
    note(`\n  purchase_order_items: ${po.length} row(s)`);
    for (const r of po) {
      const dead = PO_DEAD.includes(String(r.status).toUpperCase());
      const left = Number(r.qty) - Number(r.received_qty);
      note(`    ${r.po_number}  ${String(r.status).padEnd(10)} qty=${r.qty} recv=${r.received_qty} left=${left}${dead ? '   DEAD STATUS - not supply' : ''}`);
      note(`        wh=${r.warehouse_id ?? '(null)'}  eta=${r.delivery_date ?? r.expected_at ?? '(none)'}  variants=${(r.variants ?? '').slice(0, 100)}`);
    }
    if (!po.length) note(`    (none — no purchase order has ever named this code)`);

    /* Every SO line demanding it, so the page's expected row count is visible. */
    const dem = await sql`
      SELECT i.doc_no, i.qty, i.cancelled, s.status, i.warehouse_id::text AS warehouse_id,
             coalesce(i.line_delivery_date::text, s.customer_delivery_date::text) AS eff_date,
             i.variants::text AS variants
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${CO} AND i.item_code = ${code}
         AND i.cancelled = false
         AND s.status NOT IN ('SHIPPED','DELIVERED','INVOICED','CLOSED','CANCELLED')
       ORDER BY eff_date NULLS LAST, i.doc_no`;
    note(`\n  live SO demand for this code: ${dem.length} line(s)`);
    for (const d of dem) note(`    ${d.doc_no}  ${String(d.status).padEnd(10)} qty=${d.qty} date=${d.eff_date ?? '(none)'} wh=${(d.warehouse_id ?? '').slice(0, 8)}  variants=${(d.variants ?? '').slice(0, 70)}`);
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });

#!/usr/bin/env node
/* The variant SHAPES behind one MRP bucket, untruncated. Read-only.

   MRP buckets demand by composite(warehouse, code, variantKeyOf(group,
   variants)). Two SO lines that look identical on screen land in different
   buckets if their variants OBJECTS differ, and a bucket of its own with no
   stock and no PO is a shortage — so a line that vanishes from the page is
   either in a bucket that IS covered, or not where it looks.

   This prints, without truncating and without re-deriving MRP's key:
     · every live SO line for the code, full variants JSON, sorted keys
     · every inventory_balances variant_key for the code, with qty
     · every purchase_order_items variant_key for the code, with status
     · which PO lines, if any, are bound to those SO lines (so_item_id)

   CODE="JAGER-(K)" node scripts/probe-variant-shapes.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CODES = (process.env.CODE || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!CODES.length) { console.error('need CODE="JAGER-(K)"'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const ONLY_WH = (process.env.WH || '').trim();

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const shape = (v) => { try { return Object.keys(JSON.parse(v ?? '{}')).sort().join(','); } catch { return '(unparseable)'; } };

async function main() {
  for (const code of CODES) {
    note(`\n${'='.repeat(72)}\n=== ${code} (company ${CO})${ONLY_WH ? ` warehouse ${ONLY_WH}` : ''} ===`);

    const dem = await sql`
      SELECT i.id::text AS id, i.doc_no, i.qty, s.status,
             i.warehouse_id::text AS warehouse_id,
             coalesce(i.line_delivery_date::text, s.customer_delivery_date::text) AS eff_date,
             i.variants::text AS variants
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
       WHERE i.company_id = ${CO} AND i.item_code = ${code} AND i.cancelled = false
         AND s.status NOT IN ('SHIPPED','DELIVERED','INVOICED','CLOSED','CANCELLED')
       ORDER BY eff_date NULLS LAST, i.doc_no`;

    note(`\n--- live SO demand: ${dem.length} line(s) ---`);
    const shapes = new Map();
    for (const d of dem) {
      const sh = shape(d.variants);
      shapes.set(sh, (shapes.get(sh) ?? 0) + 1);
      if (ONLY_WH && d.warehouse_id !== ONLY_WH) continue;
      note(`\n  ${d.doc_no}  qty=${d.qty}  ${d.eff_date ?? '(no date)'}  wh=${(d.warehouse_id ?? '').slice(0, 8)}`);
      note(`    keys: ${sh}`);
      note(`    ${d.variants}`);
    }
    note(`\n--- distinct variants SHAPES across all ${dem.length} demand line(s) ---`);
    for (const [sh, n] of [...shapes].sort((a, b) => b[1] - a[1])) note(`  x${String(n).padStart(3)}  ${sh}`);

    const bal = await sql`
      SELECT coalesce(b.variant_key,'') AS variant_key, w.name AS warehouse, b.qty
        FROM scm.inventory_balances b LEFT JOIN scm.warehouses w ON w.id = b.warehouse_id
       WHERE b.company_id = ${CO} AND b.item_code = ${code} AND b.qty <> 0
       ORDER BY w.name, b.variant_key`;
    note(`\n--- inventory_balances variant_keys: ${bal.length} ---`);
    for (const b of bal) note(`  ${String(b.warehouse ?? '?').padEnd(30)} qty=${String(b.qty).padStart(4)}  key=${JSON.stringify(b.variant_key)}`);

    const po = await sql`
      SELECT p.po_number, p.status, i.qty - coalesce(i.received_qty,0) AS qty_left,
             i.warehouse_id::text AS warehouse_id, i.so_item_id::text AS so_item_id,
             i.variants::text AS variants
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE i.company_id = ${CO} AND i.item_code = ${code}
         AND upper(p.status) NOT IN ('CANCELLED','CLOSED','DRAFT')
       ORDER BY p.po_number`;
    note(`\n--- OPEN purchase order lines (statuses MRP counts as supply): ${po.length} ---`);
    for (const r of po) {
      note(`  ${r.po_number}  ${String(r.status).padEnd(12)} left=${r.qty_left}  wh=${(r.warehouse_id ?? '').slice(0, 8)}  so_item=${r.so_item_id ? r.so_item_id.slice(0, 8) : '(unbound)'}`);
      note(`      keys: ${shape(r.variants)}`);
    }
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });

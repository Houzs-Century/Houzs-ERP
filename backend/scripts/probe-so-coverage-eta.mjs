#!/usr/bin/env node
/* Why does the Incoming PO chip carry no date? Read-only.

   The chip is `coverage_po · ETA coverage_eta` (SoSourceChips.tsx). The ETA
   is whatever MRP's supply pass attached to the PO line, and routes/mrp.ts
   builds it as:

     lineEta   = MAX over non-null of [delivery_date, supplier_delivery_date_2..4]
     headerEta = MAX over non-null of [expected_at,   supplier_delivery_date_2..4]
     eta       = lineEta ?? headerEta ?? null

   So the chip renders bare when BOTH sides are empty. That is a claim about
   this order's rows, not about the code, so this asks the database for the
   eight dates behind every PO line that could cover the order and prints the
   effective ETA beside them.

   Writes nothing. DOC=SO2607-005 node scripts/probe-so-coverage-eta.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOCS = (process.env.DOC || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DOCS.length) { console.error('need DOC="SO2607-005"'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Copied from routes/mrp.ts. Printed rather than trusted: if the list drifts,
   the header status shows beside it and a human can see the disagreement. */
const PO_DEAD = new Set(['CANCELLED', 'CLOSED', 'DRAFT']);

/* effectiveDelivery: the LATEST of the non-null dates, or null if all empty. */
const eff = (...ds) => {
  const live = ds.filter((d) => d != null && d !== '');
  return live.length ? live.slice().sort().at(-1) : null;
};
const show = (d) => (d == null || d === '' ? '·' : String(d).slice(0, 10));

async function main() {
  for (const doc of DOCS) {
    note(`\n${'='.repeat(72)}\n=== ${doc} ===`);

    /* Exact first; the owner types the number as it shows on screen and the
       stored doc_no may carry a company prefix. A LIKE fallback finds it
       either way, and prints what it actually matched. */
    let heads = await sql`
      SELECT doc_no, company_id, status,
             customer_delivery_date::text AS customer_delivery_date,
             processing_date::text AS processing_date
        FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
    if (!heads.length) {
      heads = await sql`
        SELECT doc_no, company_id, status,
               customer_delivery_date::text AS customer_delivery_date,
               processing_date::text AS processing_date
          FROM scm.mfg_sales_orders WHERE doc_no LIKE ${'%' + doc + '%'}
         ORDER BY doc_no LIMIT 10`;
      if (heads.length) note(`  (no exact doc_no; matched ${heads.length} by suffix)`);
    }
    if (!heads.length) { note(`  NO SUCH SALES ORDER`); continue; }

    for (const h of heads) {
      note(`\n  ${h.doc_no}  company=${h.company_id}  status=${h.status}`);
      note(`    processing_date ${h.processing_date ?? '(null)'}   customer_delivery ${h.customer_delivery_date ?? '(null)'}`);

      const lines = await sql`
        SELECT id::text AS id, line_no, item_code, item_group, qty, cancelled,
               warehouse_id::text AS warehouse_id, stock_status,
               variants::text AS variants
          FROM scm.mfg_sales_order_items
         WHERE doc_no = ${h.doc_no} AND company_id = ${h.company_id}
         ORDER BY line_no`;
      note(`    ${lines.length} line(s)`);

      for (const l of lines) {
        note(`\n    line ${l.line_no}  ${l.item_code ?? '(no code)'}  [${l.item_group ?? '-'}]  qty=${l.qty}${l.cancelled ? '  CANCELLED' : ''}`);
        note(`        stock_status=${l.stock_status ?? '(null)'}  wh=${(l.warehouse_id ?? '(null)').slice(0, 8)}`);
        note(`        variants ${(l.variants ?? '').slice(0, 140)}`);
        if (!l.item_code) continue;

        /* Every PO line that names this code, dead ones included, so a chip
           pointing at a PO this probe would otherwise hide is still visible. */
        const po = await sql`
          SELECT p.po_number, p.status,
                 i.qty, coalesce(i.received_qty,0) AS received_qty,
                 i.warehouse_id::text AS warehouse_id,
                 i.so_item_id::text AS so_item_id,
                 i.variants::text AS variants,
                 i.delivery_date::text AS d1,
                 i.supplier_delivery_date_2::text AS d2,
                 i.supplier_delivery_date_3::text AS d3,
                 i.supplier_delivery_date_4::text AS d4,
                 p.expected_at::text AS h1,
                 p.supplier_delivery_date_2::text AS h2,
                 p.supplier_delivery_date_3::text AS h3,
                 p.supplier_delivery_date_4::text AS h4,
                 p.purchase_location_id::text AS purchase_location_id
            FROM scm.purchase_order_items i
            JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
           WHERE i.company_id = ${h.company_id} AND i.item_code = ${l.item_code}
           ORDER BY p.po_number`;
        note(`        purchase_order_items naming this code: ${po.length}`);
        for (const r of po) {
          const dead = PO_DEAD.has(String(r.status).toUpperCase());
          const left = Number(r.qty) - Number(r.received_qty);
          const lineEta = eff(r.d1, r.d2, r.d3, r.d4);
          const headEta = eff(r.h1, r.h2, r.h3, r.h4);
          const etaVal = lineEta ?? headEta ?? null;
          const why = etaVal == null
            ? '   <-- NO ETA: chip renders the PO number with no date'
            : (lineEta ? ' (from the line)' : ' (fallback: PO header)');
          note(`          ${r.po_number}  ${String(r.status).padEnd(10)} qty=${r.qty} recv=${r.received_qty} left=${left}${dead ? '  DEAD STATUS — not supply' : ''}${left <= 0 && !dead ? '  left<=0 — not supply' : ''}`);
          note(`              line dates   ${show(r.d1)} ${show(r.d2)} ${show(r.d3)} ${show(r.d4)}   -> ${show(lineEta)}`);
          note(`              header dates ${show(r.h1)} ${show(r.h2)} ${show(r.h3)} ${show(r.h4)}   -> ${show(headEta)}`);
          note(`              EFFECTIVE ETA ${show(etaVal)}${why}`);
          note(`              wh=${(r.warehouse_id ?? '(null,falls back to purchase_location ' + (r.purchase_location_id ?? 'null') + ')').slice(0, 40)}  so_item=${r.so_item_id ? r.so_item_id.slice(0, 8) : '(unbound)'}`);
          note(`              variants ${(r.variants ?? '').slice(0, 120)}`);
        }
      }
    }
  }
  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });

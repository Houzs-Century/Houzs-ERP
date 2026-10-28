#!/usr/bin/env node
/* Sales Order lines bound to ANOTHER company's warehouse. Find them, show them,
   re-bind each to its own company's warehouse of the same code.

   THE SHAPE. Every company has its own "KL WAREHOUSE". lib/so-warehouse.ts
   resolved a new line's warehouse (amendment ADD line, auto free-gift line) by
   matching the SO header's sales_location against EVERY company's warehouses
   and taking the first hit. HC-SO-013495 (2026-09-24, BUG-24): two sofa
   modules added by an amendment landed on the other company's KL WAREHOUSE.
   The Houzs MRP only knows Houzs warehouses, so those lines showed "—", sat in
   a separate stock bucket, and the order split into two POs.

   THE TARGET. The warehouse in the LINE's company whose code equals the wrong
   warehouse's code (case-insensitive), else whose name equals its name. No
   match, or more than one, is REFUSED and printed: a guessed warehouse moves
   stock allocation to the wrong building.

   ONLY OPEN ORDERS ARE WRITTEN. A line on a CANCELLED / CLOSED / SHIPPED /
   DELIVERED / INVOICED order already has DO lines and stock movements that
   carry its warehouse; changing the SO line alone would make them disagree.
   Those are counted and listed, never touched. Open PO lines pointing at
   another company's warehouse are also reported, read-only.

   DOC_NOS (optional, comma-separated) limits the WRITE to those orders; every
   other cross-company line is still listed, marked "not in DOC_NOS".

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="REBIND CROSS-COMPANY WAREHOUSES", writes one row at a time (guarded
   on the old warehouse_id), and re-reads on a fresh connection that every
   written line's warehouse now belongs to the line's own company.

   RE-RUN: inert. Keyed on warehouse.company_id <> line.company_id, which the
   re-bind makes equal. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REBIND CROSS-COMPANY WAREHOUSES';
const DOC_NOS = (process.env.DOC_NOS ?? '').split(',').map((d) => d.trim()).filter(Boolean);
const CLOSED = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED'];

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

const crossCompanyLines = (client) => client`
  SELECT i.id::text AS id, i.doc_no, i.item_code, i.company_id AS line_co,
         i.warehouse_id::text AS wh_id, w.code AS wh_code, w.name AS wh_name, w.company_id AS wh_co,
         s.status::text AS so_status, i.cancelled
    FROM scm.mfg_sales_order_items i
    JOIN scm.warehouses w ON w.id = i.warehouse_id
    JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = i.company_id
   WHERE w.company_id IS NOT NULL AND w.company_id <> i.company_id
   ORDER BY i.doc_no, i.line_no NULLS LAST, i.id`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}  DOC_NOS=${DOC_NOS.length ? DOC_NOS.join(',') : '(all)'}`);

  const warehouses = await sql`SELECT id::text AS id, code, name, company_id FROM scm.warehouses`;
  const rows = await crossCompanyLines(sql);
  note(`\n=== SO LINES ON ANOTHER COMPANY'S WAREHOUSE: ${rows.length} ===`);

  const fix = [], refuse = [], history = [], outOfScope = [];
  for (const r of rows) {
    const where = `${r.doc_no} ${String(r.item_code ?? '-').padEnd(20)} line co ${r.line_co} -> ${r.wh_code ?? r.wh_name} (co ${r.wh_co})`;
    if (r.cancelled || CLOSED.includes(r.so_status)) { history.push({ ...r, where }); continue; }
    if (DOC_NOS.length && !DOC_NOS.includes(r.doc_no)) { outOfScope.push({ ...r, where }); continue; }
    const own = warehouses.filter((w) => Number(w.company_id) === Number(r.line_co));
    let hits = own.filter((w) => r.wh_code && norm(w.code) === norm(r.wh_code));
    if (!hits.length) hits = own.filter((w) => r.wh_name && norm(w.name) === norm(r.wh_name));
    if (hits.length === 1) fix.push({ ...r, where, target: hits[0] });
    else refuse.push({ ...r, where, why: hits.length ? `${hits.length} same-code warehouses in company ${r.line_co}` : `no warehouse with that code or name in company ${r.line_co}` });
  }

  for (const r of fix) note(`  FIX     ${r.where}  =>  ${r.target.code ?? r.target.name} (${r.target.id})  [${r.so_status}]`);
  for (const r of refuse) bad(`  REFUSED ${r.where} — ${r.why}`);
  for (const r of history) note(`  CLOSED  ${r.where}  [${r.cancelled ? 'line cancelled' : r.so_status}] — left as is`);
  note(`\n  to fix: ${fix.length}   refused: ${refuse.length}   closed/cancelled (untouched): ${history.length}`);

  const poRows = await sql`
    SELECT p.po_number, pi.item_code, w.code AS wh_code, w.company_id AS wh_co, pi.company_id AS line_co, p.status::text AS status
      FROM scm.purchase_order_items pi
      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
      JOIN scm.warehouses w ON w.id = pi.warehouse_id
     WHERE w.company_id IS NOT NULL AND w.company_id <> pi.company_id
     ORDER BY p.po_number`;
  note(`\n=== PO LINES ON ANOTHER COMPANY'S WAREHOUSE (report only): ${poRows.length} ===`);
  for (const r of poRows) note(`  ${r.po_number} ${r.item_code} line co ${r.line_co} -> ${r.wh_code} (co ${r.wh_co}) [${r.status}]`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== RE-BINDING ${fix.length} LINE(S) ===`);
  let wrote = 0;
  for (const r of fix) {
    const back = await sql`
      UPDATE scm.mfg_sales_order_items SET warehouse_id = ${r.target.id}::uuid
       WHERE id = ${r.id}::uuid AND warehouse_id = ${r.wh_id}::uuid
      RETURNING id::text AS id`;
    wrote += back.length;
    note(`  ${back.length ? 'OK  ' : 'SKIP'} ${r.where}`);
  }
  note(`  written: ${wrote} of ${fix.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const ids = fix.map((r) => r.id);
    const after = ids.length ? await check`
      SELECT i.id::text AS id, i.doc_no, i.company_id AS line_co, w.company_id AS wh_co, w.code
        FROM scm.mfg_sales_order_items i
        LEFT JOIN scm.warehouses w ON w.id = i.warehouse_id
       WHERE i.id = ANY(${ids}::uuid[])` : [];
    let wrong = 0;
    for (const a of after) {
      if (Number(a.wh_co) !== Number(a.line_co)) { wrong++; bad(`  ${a.doc_no} ${a.id}: warehouse ${a.code ?? '(none)'} is company ${a.wh_co}, line is ${a.line_co}`); }
    }
    const left = await crossCompanyLines(check);
    const openLeft = left.filter((r) => !r.cancelled && !CLOSED.includes(r.so_status)).length;
    note(`  written lines now on their own company's warehouse: ${after.length - wrong} of ${after.length}`);
    note(`  open-order lines still cross-company: ${openLeft} (${refuse.length} refused, ${outOfScope.length} not in DOC_NOS)`);
    if (wrong) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});

#!/usr/bin/env node
// Delete specific imported company-1 orders so a fresh import can mirror their
// AutoCount edits exactly (owner 2026-08-10: staff updated SOs before the
// freeze — "帮我查看 latest update … 我现在已经 stop 掉他们"). Same guards as
// delete-ac-iv-orders: only linked imports, skip anything with an ERP delivery
// order or stock allocation. DOCS = comma-separated AutoCount doc numbers.
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
const DOCS = (process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!DOCS.length) { console.error("need DOCS"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; docs requested: ${DOCS.length}`);
  const rows = await sql`SELECT doc_no, linked_ac_docno, status FROM scm.mfg_sales_orders
    WHERE company_id = 1 AND linked_ac_docno = ANY(${DOCS})`;
  log(`present in ERP: ${rows.length}`);
  const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'scm'`).map((r) => r.table_name);
  const docNos = rows.map((r) => r.doc_no);
  const blocked = new Set();
  if (tables.includes("mfg_delivery_order_items") && docNos.length) {
    const hit = await sql`SELECT DISTINCT s.doc_no FROM scm.mfg_delivery_order_items d
      JOIN scm.mfg_sales_order_items s ON s.id = d.so_item_id WHERE s.doc_no = ANY(${docNos})`;
    for (const h of hit) blocked.add(h.doc_no);
  }
  if (tables.includes("stock_allocations") && docNos.length) {
    const hit = await sql`SELECT DISTINCT s.doc_no FROM scm.stock_allocations a
      JOIN scm.mfg_sales_order_items s ON s.id = a.so_item_id WHERE s.doc_no = ANY(${docNos})`;
    for (const h of hit) blocked.add(h.doc_no);
  }
  const todo = rows.filter((r) => !blocked.has(r.doc_no));
  log(`to delete: ${todo.length}; SKIPPED (has DO/allocation): ${blocked.size}${blocked.size ? ` -> ${[...blocked].join(", ")}` : ""}`);
  for (const r of todo) log(`   delete ${r.doc_no} (${r.linked_ac_docno}, ${r.status})`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  let n = 0;
  for (const r of todo) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${r.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = ${r.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${r.doc_no} AND company_id = 1`;
    });
    n++;
  }
  log(`DONE. deleted ${n} orders for re-import`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

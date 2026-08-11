#!/usr/bin/env node
// Remove the SO→IV direct-invoiced AutoCount orders from the ERP (owner
// 2026-08-09: "这个不算outstanding" — an SO that was invoiced without a DO is a
// completed cash-and-carry sale, not an outstanding order). The DO-rule import
// had brought them in; data/ac-so-iv-excluded.json.gz is the authoritative list
// and the regenerated ac-outstanding-so.json.gz no longer contains them, so
// they can never come back on a re-import.
//
// SAFETY: company-1 + linked_ac_docno membership only; any order that has an
// ERP delivery order or stock allocation against it is SKIPPED and reported
// (none should — they were imported tonight). Deletes payments + items + header
// in one transaction per order. DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const iv = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-so-iv-excluded.json.gz"))).toString("utf8"));
  log(`AC SO->IV excluded docs: ${iv.length}`);
  const rows = await sql`SELECT doc_no, linked_ac_docno, status, proceeded_at FROM scm.mfg_sales_orders
    WHERE company_id = 1 AND linked_ac_docno = ANY(${iv})`;
  log(`present in ERP: ${rows.length}`);
  if (!rows.length) { log("nothing to delete."); await sql.end(); return; }

  // downstream guards — resolved dynamically so a rename never silently no-ops
  const tables = (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'scm'`).map((r) => r.table_name);
  const docNos = rows.map((r) => r.doc_no);
  const blocked = new Set();
  if (tables.includes("mfg_delivery_order_items")) {
    const hit = await sql`SELECT DISTINCT s.doc_no FROM scm.mfg_delivery_order_items d
      JOIN scm.mfg_sales_order_items s ON s.id = d.so_item_id WHERE s.doc_no = ANY(${docNos})`;
    for (const h of hit) blocked.add(h.doc_no);
  }
  if (tables.includes("stock_allocations")) {
    const hit = await sql`SELECT DISTINCT s.doc_no FROM scm.stock_allocations a
      JOIN scm.mfg_sales_order_items s ON s.id = a.so_item_id WHERE s.doc_no = ANY(${docNos})`;
    for (const h of hit) blocked.add(h.doc_no);
  }
  const todo = rows.filter((r) => !blocked.has(r.doc_no));
  log(`to delete: ${todo.length}; SKIPPED (has DO/allocation): ${blocked.size}${blocked.size ? ` -> ${[...blocked].join(", ")}` : ""}`);
  for (const r of todo.slice(0, 15)) log(`   delete ${r.doc_no} (${r.linked_ac_docno}, ${r.status})`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  let n = 0;
  for (const r of todo) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${r.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_order_items WHERE doc_no = ${r.doc_no}`;
      await tx`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${r.doc_no} AND company_id = 1`;
    });
    n++;
    if (n % 25 === 0) log(`  ..${n}/${todo.length}`);
  }
  log(`DONE. deleted ${n} SO->IV orders`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

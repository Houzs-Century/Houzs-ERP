#!/usr/bin/env node
/* READ-ONLY: of the round-1 R2 keys we hold, how many are attached to a line
 * today (SO + PO)? And how many lines carry photos at all? */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const readKeys = (f) => fs.readFileSync(path.join(here, "data", f), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
for (const [label, file, table, join] of [
  ["SO", "r2-so-photo-keys-2026-08-10.txt", "scm.mfg_sales_order_items i", "JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no WHERE h.company_id=1"],
  ["PO", "r2-po-photo-keys-2026-08-10.txt", "scm.purchase_order_items i", "JOIN scm.purchase_orders h ON h.id=i.purchase_order_id WHERE h.company_id=1"],
]) {
  const keys = readKeys(file);
  const rows = await sql.unsafe(`SELECT COUNT(*)::int AS attached FROM (
      SELECT DISTINCT unnest(i.photo_urls) AS k FROM ${table} ${join}) t
    WHERE t.k = ANY($1::text[])`, [keys]);
  const lines = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${table} ${join}
      AND COALESCE(array_length(i.photo_urls,1),0) > 0`);
  console.log(`${label}: round-1 keys held ${keys.length}; attached to a line today ${rows[0].attached}; lines carrying any photo ${lines[0].n}`);
  const doubt = readKeys(file.replace("-2026-08-10", "-doubtful"));
  const d = await sql.unsafe(`SELECT COUNT(*)::int AS attached FROM (
      SELECT DISTINCT unnest(i.photo_urls) AS k FROM ${table} ${join}) t
    WHERE t.k = ANY($1::text[])`, [doubt]);
  console.log(`    doubtful keys ${doubt.length}; of those attached ${d[0].attached}`);
}
await sql.end();

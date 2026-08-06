#!/usr/bin/env node
// Backfill size_code (+ size_label) for MATTRESS/BEDFRAME SKUs whose code carries
// a (K)/(Q)/(S)/(SS)/(SK)/(SP) suffix but has an empty size_code (legacy rows).
// Read-only for anything with a size_code already set. MODE=dry-run (default)
// reports; MODE=apply writes.
import postgres from "postgres";
const mode = (process.env.MODE || "dry-run").toLowerCase();
const apply = mode === "apply";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const LABEL = { K: "6FT", Q: "5FT", S: "3FT", SS: "3.5FT", SK: "200X200CM", SP: "CUSTOM" };

async function main() {
  console.log(`MODE=${mode} company_id=${cid}`);
  const rows = await sql`
    SELECT id, code FROM scm.mfg_products
    WHERE company_id=${cid} AND category IN ('MATTRESS','BEDFRAME')
      AND (size_code IS NULL OR size_code='')
      AND code ~ '\\((K|Q|S|SS|SK|SP)\\)\\s*$'`;
  console.log(`candidates (empty size_code, sized code): ${rows.length}`);
  const byCode = {};
  let updated = 0;
  for (const r of rows) {
    const m = String(r.code).match(/\(([KQSP]{1,2})\)\s*$/);
    if (!m) continue;
    const sc = m[1];
    byCode[sc] = (byCode[sc] || 0) + 1;
    if (apply) {
      const res = await sql`UPDATE scm.mfg_products SET size_code=${sc}, size_label=${LABEL[sc]}, updated_at=now() WHERE id=${r.id}`;
      updated += res.count;
    } else updated++;
  }
  console.log(`by size: ${JSON.stringify(byCode)}`);
  console.log(`${apply ? "APPLIED" : "would update"}: ${updated}`);
  console.log(apply ? "APPLIED." : "DRY-RUN: nothing written.");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });

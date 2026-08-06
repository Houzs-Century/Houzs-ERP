#!/usr/bin/env node
// Owner map: KD = King (K), QD = Queen (Q). Fill size_code for MATTRESS/BEDFRAME
// SKUs whose code ends in (KD)/(QD) but has an empty size_code. Idempotent.
import postgres from "postgres";
const apply = (process.env.MODE || "dry-run").toLowerCase() === "apply";
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const MAP = { KD: ["K", "6FT"], QD: ["Q", "5FT"] };
async function main() {
  const rows = await sql`SELECT id, code FROM scm.mfg_products
    WHERE company_id=${cid} AND category IN ('MATTRESS','BEDFRAME')
      AND (size_code IS NULL OR size_code='') AND code ~ '\((KD|QD)\)?\s*$'`;
  console.log(`candidates: ${rows.length}`);
  let n = 0;
  for (const r of rows) {
    const m = String(r.code).match(/\((KD|QD)\)?\s*$/); if (!m) continue;
    const [sc, lbl] = MAP[m[1]];
    if (apply) n += (await sql`UPDATE scm.mfg_products SET size_code=${sc}, size_label=${lbl}, updated_at=now() WHERE id=${r.id}`).count;
    else n++;
  }
  console.log(`${apply ? "APPLIED" : "would update"}: ${n}`);
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });

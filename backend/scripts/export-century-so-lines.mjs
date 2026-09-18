#!/usr/bin/env node
// READ-ONLY export: every SOFA + BEDFRAME sales-order LINE for one company,
// ALL statuses (done or not) — so the owner gets the whole corpus in one file
// instead of the ERP's one-page-at-a-time export.
//
// Company 1 = code HOUZS = "Houzs Century" (see align-export-company.mjs).
// SELECT only. Dumps the FULL item row + FULL order-header row as jsonb per
// line, so the local xlsx builder can map the AutoCount detail-listing columns
// without this script having to know every column name.
//
// Env: DATABASE_URL (required), COMPANY_ID (default "1").
// Output: out/century-so-lines.json  (array of { item, header })
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";

const cid = Number(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

async function main() {
  mkdirSync("out", { recursive: true });
  console.log(`COMPANY_ID=${cid}`);

  // Prove the SOFA/BEDFRAME filter catches the right groups.
  const groups = await sql`
    SELECT item_group, count(*)::int AS n
    FROM scm.mfg_sales_order_items
    WHERE company_id = ${cid}
    GROUP BY item_group ORDER BY n DESC`;
  console.log("item_group values for this company:");
  for (const g of groups) console.log(`  ${JSON.stringify(g.item_group)}: ${g.n}`);

  // Every sofa/bedframe line + its full header. ILIKE so 'SOFA'/'Sofa' and
  // 'BEDFRAME'/'Bed Frame' match regardless of casing/spacing. NO status filter
  // (owner: done or not, everything). NO cancelled filter (the Cancelled flag
  // rides along in the row).
  const rows = await sql`
    SELECT to_jsonb(oi.*) AS item, to_jsonb(so.*) AS header
    FROM scm.mfg_sales_order_items oi
    LEFT JOIN scm.mfg_sales_orders so
      ON so.doc_no = oi.doc_no AND so.company_id = oi.company_id
    WHERE oi.company_id = ${cid}
      AND (oi.item_group ILIKE 'sofa%' OR oi.item_group ILIKE 'bed%')
    ORDER BY oi.doc_no, oi.id`;

  writeFileSync("out/century-so-lines.json", JSON.stringify(rows, null, 0));

  const orders = new Set(rows.map((r) => r.item?.doc_no));
  const byCat = rows.reduce((m, r) => {
    const g = r.item?.item_group ?? "?";
    m[g] = (m[g] || 0) + 1;
    return m;
  }, {});
  console.log(`\nMATCHED sofa+bedframe lines: ${rows.length}`);
  console.log(`distinct orders: ${orders.size}`);
  console.log(`lines by category: ${JSON.stringify(byCat)}`);
  console.log("wrote out/century-so-lines.json");
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("FAILED:", e.message);
    await sql.end();
    process.exit(1);
  });

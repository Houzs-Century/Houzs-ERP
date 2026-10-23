// Read-only: which ACTIVE SKUs look like the same product under two codes?
//
// HC-0147 (Sim, 2026-10-22) asked for every pair like ROY / ROYAL EXECUTIVE
// LUXE 2.0. The rules are in lib/similar-sku-groups.mjs. Per code this prints what
// a merge would have to weigh: sales-order and purchase-order lines, stock in the
// movement ledger, and whether it holds the main-supplier binding. A pair someone
// rules on goes into data/duplicate-sku-merges.json for merge-duplicate-skus.mjs.
//
// Writes nothing. Exits 0 for every answer, non-zero only when the database
// cannot be read. Output is product codes and counts only: this repository's
// Actions logs are public.
//
//   DATABASE_URL  required
//   COMPANY_ID    default 1

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { groupSimilarSkus } from "./lib/similar-sku-groups.mjs";

const BOOK = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "duplicate-sku-merges.json"), "utf8"));
const RULED = new Map(Object.entries(BOOK).flatMap(([ticket, e]) => e.pairs.map((p) => [p.drop, `${ticket}: merges into "${p.keep}"`])));

const DSN = process.env.DATABASE_URL;
const CO = Number(process.env.COMPANY_ID || 1);
if (!DSN) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const products = await sql`
    SELECT code, category::text AS category, status::text AS status
      FROM scm.mfg_products WHERE company_id = ${CO}`;
  const bindings = await sql`
    SELECT item_code, COALESCE(NULLIF(trim(ac_item_code), ''), supplier_sku) AS ac_code
      FROM scm.supplier_material_bindings
     WHERE company_id = ${CO} AND material_kind::text = 'mfg_product'`;

  const groups = groupSimilarSkus({
    products,
    bindings: bindings.map((b) => ({ itemCode: b.item_code, acCode: b.ac_code })),
  });
  const codes = groups.flatMap((g) => g.codes);

  const count = async (table) => {
    const rows = await sql`
      SELECT item_code, COUNT(*)::int AS n FROM ${sql(`scm.${table}`)}
       WHERE company_id = ${CO} AND item_code = ANY(${codes}) GROUP BY item_code`;
    return new Map(rows.map((r) => [r.item_code, r.n]));
  };
  const soLines = await count("mfg_sales_order_items");
  const poLines = await count("purchase_order_items");
  const stock = new Map((await sql`
    SELECT item_code, SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                             WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ANY(${codes})
     GROUP BY item_code`).map((r) => [r.item_code, r.qty]));
  const main = new Set((await sql`
    SELECT DISTINCT item_code FROM scm.supplier_material_bindings
     WHERE company_id = ${CO} AND material_kind::text = 'mfg_product'
       AND is_main_supplier = true AND item_code = ANY(${codes})`).map((r) => r.item_code));

  const ruled = (g) => g.codes.some((c) => RULED.has(c));
  log(`company ${CO}: ${products.filter((p) => p.status === "ACTIVE").length} active SKU(s), ${groups.length} group(s) that look alike, ${groups.filter(ruled).length} of them already ruled in data/duplicate-sku-merges.json`);
  /* A code bound to several AutoCount items (sofa models sold under each other's
     codes) is a binding to check before it is a duplicate, so those go last. */
  const several = (g) => g.acCodes.length > 1;
  const order = [
    ...groups.filter((x) => !ruled(x) && !several(x)),
    ...groups.filter((x) => !ruled(x) && several(x)),
    ...groups.filter(ruled),
  ];
  for (const g of order) {
    log("");
    log(`GROUP  ${g.reasons.join("; ")}${g.acCodes.length ? `  [AutoCount ${g.acCodes.join(" / ")}]` : ""}`);
    for (const c of g.codes) {
      const note = RULED.has(c) ? `  (${RULED.get(c)})` : "";
      log(`   "${c}"  SO lines ${soLines.get(c) ?? 0}, PO lines ${poLines.get(c) ?? 0}, stock ${stock.get(c) ?? 0}, main supplier ${main.has(c) ? "yes" : "no"}${note}`);
    }
  }
  log("");
  log("READ ONLY - nothing was written.");
  await sql.end();
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});

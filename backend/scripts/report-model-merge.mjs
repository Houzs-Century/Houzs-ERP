// Read-only report for a Product Model merge ruling: what each Model in a
// data/duplicate-model-merges.json entry holds, before anything is moved.
// WRITES NOTHING, in any mode.
//
// Per group (one Model kept, the others folded into it) it prints every Model's
// SKUs with size, status, stock, open sales-order and purchase-order lines and
// main supplier, then sorts each folded SKU into:
//   - SAME SIZE AS A KEPT SKU: two codes for one product, a duplicate-SKU merge
//     (merge-duplicate-skus.mjs) rather than a move;
//   - NEW SIZE: moves under the kept Model as it is (model_id + base_model).
// Rows on other tables that point at a folded Model's id are counted too.
// The deactivateIfIdle list gets stock + open SO lines per Model.
//
// OUTPUT: counts and product codes only, because this repository's Actions logs
// are public: no document numbers, no money.
//
//   DATABASE_URL  required
//   TICKET        required, a key of data/duplicate-model-merges.json
//   COMPANY_ID    default 1

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
const TICKET = (process.env.TICKET || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, "data", "duplicate-model-merges.json"), "utf8"));
if (!BOOK[TICKET]) { console.error(`REFUSED: TICKET must be one of ${Object.keys(BOOK).join(", ")}, got "${TICKET}".`); process.exit(2); }
const ENTRY = BOOK[TICKET];

const log = (m = "") => console.log(m);
const arr = (xs) => JSON.stringify([...new Set(xs)]);
const inList = (sql, xs) => sql`ARRAY(SELECT jsonb_array_elements_text(${arr(xs)}::text::jsonb))`;

/** The size a SKU stands for: its size_code, else the "(X)" / "(X" its code ends with. */
export function sizeOf(sku) {
  const sc = String(sku.size_code ?? "").trim().toUpperCase();
  if (sc) return sc;
  const m = String(sku.code).match(/\(([A-Z0-9+]{1,4})\)?\s*$/i);
  return m ? m[1].toUpperCase() : "";
}

async function main() {
  log(`report (read-only) ticket=${TICKET} company=${CO}`);
  log(`ruling: ${ENTRY.ruling}`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const groups = ENTRY.groups;
  const idle = ENTRY.deactivateIfIdle ?? [];
  const modelCodes = [...groups.flatMap((g) => [g.keep, ...g.drops].filter(Boolean)), ...idle.map((x) => x.model)];

  const models = await sql`
    SELECT id::text AS id, model_code, category::text AS category, active, allowed_options
      FROM scm.product_models WHERE company_id = ${CO} AND model_code = ANY(${inList(sql, modelCodes)})`;
  const modelIds = models.map((m) => m.id);
  const skus = await sql`
    SELECT id::text AS id, code, status::text AS status, category::text AS category, size_code,
           pos_active, base_model, model_id::text AS model_id
      FROM scm.mfg_products
     WHERE company_id = ${CO}
       AND (model_id::text = ANY(${inList(sql, modelIds)}) OR base_model = ANY(${inList(sql, modelCodes)})
            OR (model_id IS NULL AND code = ANY(${inList(sql, modelCodes)})))`;
  const codes = skus.map((s) => s.code);

  const stock = await sql`
    SELECT m.item_code, w.code AS wh,
           SUM(CASE m.movement_type WHEN 'IN' THEN m.qty WHEN 'OUT' THEN -m.qty
                                    WHEN 'ADJUSTMENT' THEN m.qty WHEN 'TRANSFER' THEN m.qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements m LEFT JOIN scm.warehouses w ON w.id = m.warehouse_id
     WHERE m.company_id = ${CO} AND m.item_code = ANY(${inList(sql, codes)})
     GROUP BY m.item_code, w.code`;
  const soLines = await sql`
    SELECT i.item_code,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE i.cancelled IS NOT TRUE
                              AND h.status::text NOT IN ('DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'))::int AS open
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
     WHERE i.company_id = ${CO} AND i.item_code = ANY(${inList(sql, codes)})
     GROUP BY i.item_code`;
  const poLines = await sql`
    SELECT i.item_code,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE p.status::text NOT IN ('RECEIVED', 'CANCELLED', 'CLOSED'))::int AS open
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO} AND i.item_code = ANY(${inList(sql, codes)})
     GROUP BY i.item_code`;
  const mains = await sql`
    SELECT b.item_code, s.code AS supplier
      FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${CO} AND b.item_code = ANY(${inList(sql, codes)})
       AND b.material_kind::text = 'mfg_product' AND b.is_main_supplier = true`;
  const anyBind = await sql`
    SELECT b.item_code, COUNT(*)::int AS n
      FROM scm.supplier_material_bindings b
     WHERE b.company_id = ${CO} AND b.item_code = ANY(${inList(sql, codes)}) AND b.material_kind::text = 'mfg_product'
     GROUP BY b.item_code`;

  const refCols = await sql`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND column_name = 'model_id' AND table_name <> 'mfg_products'`;
  const modelRefs = [];
  for (const { table_name } of refCols) {
    const rows = await sql`
      SELECT model_id::text AS model_id, COUNT(*)::int AS n FROM ${sql(`scm.${table_name}`)}
       WHERE model_id::text = ANY(${inList(sql, modelIds)}) GROUP BY model_id`;
    for (const r of rows) modelRefs.push({ table: table_name, ...r });
  }

  const stockOf = (code) => stock.filter((s) => s.item_code === code && s.qty !== 0);
  const stockTxt = (code) => stockOf(code).map((s) => `${s.wh ?? "?"} ${s.qty}`).join(", ") || "0";
  const so = (code) => soLines.find((r) => r.item_code === code) ?? { total: 0, open: 0 };
  const po = (code) => poLines.find((r) => r.item_code === code) ?? { total: 0, open: 0 };
  const main = (code) => mains.filter((b) => b.item_code === code).map((b) => b.supplier ?? "?").sort().join("/") || "none";
  const binds = (code) => anyBind.find((b) => b.item_code === code)?.n ?? 0;
  const modelOf = (code, category) => models.filter((m) => m.model_code === code && (!category || m.category === category));
  const skusOf = (m) => skus.filter((s) => s.model_id === m.id || (!s.model_id && (s.base_model === m.model_code || s.code === m.model_code)));
  const sizesOf = (m) => (Array.isArray(m.allowed_options?.sizes) ? m.allowed_options.sizes.map(String) : []);
  const skuLine = (s) => `${s.code}  [size ${sizeOf(s) || "-"}; ${s.status}${s.pos_active === false ? ", POS off" : ""}${s.model_id ? "" : ", NO model_id"}] stock ${stockTxt(s.code)}; SO ${so(s.code).open} open/${so(s.code).total}; PO ${po(s.code).open} open/${po(s.code).total}; main supplier ${main(s.code)} (${binds(s.code)} binding(s))`;
  const modelLine = (m) => `${m.model_code} [${m.category}, ${m.active ? "ACTIVE" : "INACTIVE"}; sizes ${sizesOf(m).join("/") || "-"}]`;
  const refsTxt = (m) => modelRefs.filter((r) => r.model_id === m.id).map((r) => `${r.table} ${r.n}`).join(", ");

  const t = { groups: 0, missingModels: 0, skuDup: 0, skuMove: 0, foldedModels: 0 };
  log("");
  groups.forEach((g, i) => {
    t.groups++;
    log(`G${String(i + 1).padStart(2, "0")} ${g.category}${g.source ? ` (from ${g.source})` : ""}  KEEP ${g.keep ? `"${g.keep}"` : `NEW MODEL "${g.newModel}"`}`);
    const keepModels = g.keep ? modelOf(g.keep, g.category) : [];
    if (g.keep && keepModels.length === 0) { t.missingModels++; log(`    KEEP MODEL NOT FOUND in ${g.category} (any category: ${modelOf(g.keep).map((m) => m.category).join("/") || "none"})`); }
    const keepSkus = keepModels.flatMap(skusOf);
    for (const m of keepModels) {
      log(`    keep ${modelLine(m)}${refsTxt(m) ? `; model refs ${refsTxt(m)}` : ""}`);
      for (const s of skusOf(m)) log(`         ${skuLine(s)}`);
    }
    const seen = new Map(keepSkus.filter((s) => s.status === "ACTIVE").map((s) => [sizeOf(s), s]));
    for (const d of g.drops) {
      const dm = modelOf(d, g.category);
      if (dm.length === 0) { t.missingModels++; log(`    fold "${d}": MODEL NOT FOUND in ${g.category} (any category: ${modelOf(d).map((m) => m.category).join("/") || "none"})`); continue; }
      for (const m of dm) {
        t.foldedModels++;
        log(`    fold ${modelLine(m)}${refsTxt(m) ? `; model refs ${refsTxt(m)}` : ""}`);
        const mine = skusOf(m);
        if (mine.length === 0) log("         (no SKUs)");
        for (const s of mine) {
          const twin = seen.get(sizeOf(s));
          if (twin && sizeOf(s)) { t.skuDup++; log(`         ${skuLine(s)}\n           -> SAME SIZE as "${twin.code}": duplicate SKU`); }
          else { t.skuMove++; log(`         ${skuLine(s)}\n           -> NEW SIZE: moves under the kept Model`); if (sizeOf(s) && s.status === "ACTIVE") seen.set(sizeOf(s), s); }
        }
      }
    }
  });

  log("");
  log("DEACTIVATE IF IDLE (no stock and no open SO line on any of its SKUs)");
  let idleYes = 0;
  for (const x of idle) {
    const ms = modelOf(x.model, x.category);
    if (ms.length === 0) { log(`   "${x.model}" ${x.category}: MODEL NOT FOUND`); continue; }
    for (const m of ms) {
      const mine = skusOf(m);
      const units = mine.reduce((a, s) => a + stockOf(s.code).reduce((b, r) => b + Math.max(0, r.qty), 0), 0);
      const open = mine.reduce((a, s) => a + so(s.code).open, 0);
      const ok = units === 0 && open === 0;
      if (ok) idleYes++;
      log(`   ${modelLine(m)}: ${mine.length} SKU(s), ${mine.filter((s) => s.status === "ACTIVE").length} active; stock ${units}; open SO lines ${open}; open PO lines ${mine.reduce((a, s) => a + po(s.code).open, 0)} -> ${ok ? "IDLE, can switch off" : "KEEP ACTIVE"}`);
      for (const s of mine.filter((s) => stockOf(s.code).length || so(s.code).open)) log(`         ${skuLine(s)}`);
    }
  }

  log("");
  log(`TOTALS groups ${t.groups}; models folded ${t.foldedModels}; models not found ${t.missingModels}; folded SKUs same size (duplicate SKU) ${t.skuDup}; folded SKUs new size (move) ${t.skuMove}; idle models ${idleYes} of ${idle.length}`);
  log(`model_id is also on: ${refCols.map((r) => r.table_name).join(", ") || "none"}`);
  log("READ ONLY - nothing was written.");
  await sql.end();
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});

// Remove the 32 arithmetic-derived recliner price cells (owner 2026-08-09:
// "不需要 2RR/2 — 不确定的就不需要,确定的才做").
//
// The 2026-08 load derived per-unit recliner prices from pair rows
// (1A(R) = 2RR/2, middle 1NA = 3RR-2RR) on TD 5071/5083/BS22/BS30 and RDS
// R819 (incl. /P power rows). Those are estimates, not supplier-quoted
// numbers — this removes exactly those cells from the SKUs' seat grids and
// the matching supplier binding price_matrix cells. A cell is removed ONLY
// when its value still equals the derived number (a later manual edit is
// left alone). Explicit quoted prices (1S(R)/1S(P) rows) are untouched.
//
// DRY-RUN default; APPLY=1 writes; audited (old→null).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const cells = JSON.parse(readFileSync(new URL("./data/derived-recliner-cells-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const SUP_OF = { TD: "400-T005", RDS: "400-R001" };

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const bySku = new Map();
  for (const c of cells) {
    if (!bySku.has(c.sku)) bySku.set(c.sku, []);
    bySku.get(c.sku).push(c);
  }
  let gridRemoved = 0, gridKept = 0, matrixRemoved = 0;
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    for (const [sku, list] of bySku) {
      const [p] = await tx`SELECT id, seat_height_prices FROM scm.mfg_products
                           WHERE company_id = ${cid} AND code = ${sku}`;
      if (p && Array.isArray(p.seat_height_prices)) {
        const next = [];
        for (const e of p.seat_height_prices) {
          const hit = list.find((c) => c.height === e.height && c.tier === (e.tier ?? "PRICE_2") && c.sen === e.priceSen);
          if (hit && e.sellingPriceSen == null) {
            gridRemoved++;
            if (APPLY) await tx`INSERT INTO scm.master_price_history
              (product_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
              VALUES (${sku}, ${"seat_height:" + e.height + "|" + (e.tier ?? "PRICE_2")}, ${e.priceSen}, ${null},
                      ${"remove derived 2RR/2 estimate (owner 2026-08-09)"}, ${now}, ${cid})`;
            continue;
          }
          if (hit) gridKept++;   // carries a selling price — keep entry, drop cost only
          next.push(hit ? { ...e, priceSen: undefined } : e);
        }
        if (APPLY) await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(next.map((e) => {
          const o = { ...e };
          if (o.priceSen === undefined) delete o.priceSen;
          return o;
        }))}, updated_at = ${now} WHERE id = ${p.id}`;
      }
      // binding matrices for the deriving supplier
      const supCode = SUP_OF[list[0].sup];
      const [b] = await tx`SELECT b.id, b.price_matrix FROM scm.supplier_material_bindings b
        JOIN scm.suppliers s ON s.id = b.supplier_id
        WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product'
          AND b.material_code = ${sku} AND s.code = ${supCode}`;
      if (b && b.price_matrix && typeof b.price_matrix === "object") {
        const m = JSON.parse(JSON.stringify(b.price_matrix));
        let touched = false;
        for (const c of list) {
          const pn = { PRICE_1: "P1", PRICE_2: "P2", PRICE_3: "P3" }[c.tier];
          if (m[c.height] && m[c.height][pn] === c.sen) {
            delete m[c.height][pn];
            if (!Object.keys(m[c.height]).length) delete m[c.height];
            touched = true; matrixRemoved++;
          }
        }
        if (touched && APPLY)
          await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${Object.keys(m).length ? tx.json(m) : null}, updated_at = ${now} WHERE id = ${b.id}`;
      }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: grid cells removed ${gridRemoved} (kept-selling ${gridKept}), matrix cells removed ${matrixRemoved}, planned ${cells.length}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

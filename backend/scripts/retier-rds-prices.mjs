// Re-tier every Red Sofa price (owner 2026-08-09: "normal = price 2, we
// start from price 2; price 3 dont need record").
//
// The load mapped RDS fabric bands Normal->P1, EasyClean->P2, Acacia->P3.
// Correct mapping: Normal->PRICE_2, EasyClean->PRICE_3, Acacia->dropped
// (same start-at-P2 logic as the Hookka quotation's sofa grids).
//
// Moves, value-guarded (only cells still holding the loaded value):
//   grids + 400-R001 binding matrices: delete Acacia@P3, then move
//   EasyClean P2->P3; combos from the RDS batch: PRICE_3(Acacia) rows
//   soft-deleted, PRICE_2->PRICE_3, PRICE_1->PRICE_2.
// DRY-RUN default; APPLY=1 writes; grid changes audited.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const cells = JSON.parse(readFileSync(new URL("./data/rds-retier-cells-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const REASON = "rds-retier (owner 2026-08-09: start from P2, drop Acacia)";

const bySku = new Map();
for (const c of cells) {
  if (!bySku.has(c.sku)) bySku.set(c.sku, []);
  bySku.get(c.sku).push(c);
}

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  let del = 0, moved = 0, keptForeign = 0, mDel = 0, mMoved = 0, cDel = 0, cMoved = 0;
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    for (const [sku, list] of bySku) {
      const [p] = await tx`SELECT id, seat_height_prices FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${sku}`;
      if (p && Array.isArray(p.seat_height_prices)) {
        let entries = p.seat_height_prices.map((e) => ({ ...e }));
        let touched = false;
        // pass 1: drop Acacia cells (loaded at PRICE_3)
        for (const c of list.filter((x) => x.fabric === "Acacia")) {
          const i = entries.findIndex((e) => e.height === c.height && (e.tier ?? "PRICE_2") === "PRICE_3" && e.priceSen === c.sen);
          if (i >= 0) {
            if (entries[i].sellingPriceSen != null) { delete entries[i].priceSen; }
            else entries.splice(i, 1);
            del++; touched = true;
            await (APPLY ? tx`INSERT INTO scm.master_price_history (product_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
                     VALUES (${sku}, ${"seat_height:" + c.height + "|PRICE_3"}, ${c.sen}, ${null}, ${REASON}, ${now}, ${cid})` : Promise.resolve());
          }
        }
        // pass 2: EasyClean P2 -> P3
        for (const c of list.filter((x) => x.fabric === "EasyClean")) {
          const i = entries.findIndex((e) => e.height === c.height && (e.tier ?? "PRICE_2") === "PRICE_2" && e.priceSen === c.sen);
          if (i < 0) continue;
          const occupied = entries.some((e) => e.height === c.height && (e.tier ?? "PRICE_2") === "PRICE_3" && e.priceSen != null);
          if (occupied) { keptForeign++; continue; }
          if (entries[i].sellingPriceSen != null) delete entries[i].priceSen; else entries.splice(i, 1);
          entries.push({ height: c.height, tier: "PRICE_3", priceSen: c.sen });
          moved++; touched = true;
          await (APPLY ? tx`INSERT INTO scm.master_price_history (product_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
                   VALUES (${sku}, ${"seat_height:" + c.height + "|PRICE_2->PRICE_3"}, ${c.sen}, ${c.sen}, ${REASON}, ${now}, ${cid})` : Promise.resolve());
        }
        if (touched && APPLY)
          await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(entries)}, updated_at = ${now} WHERE id = ${p.id}`;
      }
      // 400-R001 binding matrix
      const [b] = await tx`SELECT b.id, b.price_matrix FROM scm.supplier_material_bindings b
        JOIN scm.suppliers s ON s.id = b.supplier_id
        WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product' AND b.material_code = ${sku} AND s.code = '400-R001'`;
      if (b && b.price_matrix && typeof b.price_matrix === "object") {
        const m = JSON.parse(JSON.stringify(b.price_matrix));
        let touched = false;
        for (const c of list.filter((x) => x.fabric === "Acacia")) {
          const hk = c.height ?? "STD";
          if (m[hk]?.P3 === c.sen) { delete m[hk].P3; if (!Object.keys(m[hk]).length) delete m[hk]; mDel++; touched = true; }
        }
        for (const c of list.filter((x) => x.fabric === "EasyClean")) {
          const hk = c.height ?? "STD";
          if (m[hk]?.P2 === c.sen && m[hk]?.P3 == null) { m[hk].P3 = c.sen; delete m[hk].P2; if (!Object.keys(m[hk]).length) delete m[hk]; mMoved++; touched = true; }
        }
        if (touched && APPLY)
          await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${Object.keys(m).length ? tx.json(m) : null}, updated_at = ${now} WHERE id = ${b.id}`;
      }
    }
    // combos from the RDS batch
    const combos = await tx`SELECT id, tier FROM scm.sofa_combo_pricing
      WHERE deleted_at IS NULL AND notes = 'supplier-price-list-2026-08 set rows (RDS)'`;
    for (const cb of combos) {
      if (cb.tier === "PRICE_3") { cDel++; if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET deleted_at = ${now}, updated_at = ${now} WHERE id = ${cb.id}`; }
      else if (cb.tier === "PRICE_2") { cMoved++; if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET tier = 'PRICE_3', updated_at = ${now} WHERE id = ${cb.id}`; }
      else if (cb.tier === "PRICE_1") { cMoved++; if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET tier = 'PRICE_2', updated_at = ${now} WHERE id = ${cb.id}`; }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: grid del ${del} moved ${moved} (blocked ${keptForeign}); matrix del ${mDel} moved ${mMoved}; combos del ${cDel} retier ${cMoved}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

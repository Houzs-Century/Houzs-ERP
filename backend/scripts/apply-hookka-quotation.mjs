// Apply the HOOKKA INDUSTRIES quotation (Customer 300-H, effective
// 2026-08-09) that the owner supplied as THE current Hookka price.
//
// Unlike the 2026-08 workbook load, this is a REFRESH: quoted cells
// OVERWRITE existing prices — explicitly owner-authorized ("这是 hookka
// ohana 的价格"). Every overwrite is audited to master_price_history with
// old→new and reason "hookka-quotation-2026-08-09".
//
// Does, in one transaction (HOUZS company):
//   1. mint 9058-Console if missing (legacy compartment without a SKU)
//   2. bedframe base/price1 updates (25 diffs from the committed plan)
//   3. sofa seat-grid refresh: the quoted (size × P2/P3) cells on models
//      9028 / 9058 / 8030 / 5535 — other cells and sellingPriceSen untouched
//   4. Hookka trio bindings (400-H003, 400-H004, 400-O002 — 三家一样) for
//      every quoted SKU: bedframe matrix {P1,P2} + flat P2; sofa matrix per
//      quoted heights {P2,P3}; trio matrices overwritten with the quotation
//   5. main supplier → 400-H004 on every quoted material (priority rule:
//      Hookka first)
//
// MODE=dry-run (default) | apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error("apply needs the confirm phrase"); process.exit(1); }
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const plan = JSON.parse(readFileSync(new URL("./data/hookka-quotation-refresh-2026-08-09.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const REASON = "hookka-quotation-2026-08-09";
const TRIO = ["400-H003", "400-H004", "400-O002"];
const MAIN_TO = "400-H004";

const counts = {};
const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const sups = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${cid} AND code IN ${sql(TRIO)}`;
  const supBy = Object.fromEntries(sups.map((s) => [s.code, s.id]));
  for (const c of TRIO) if (!supBy[c]) throw new Error(`supplier ${c} missing`);

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    const prods = await tx`SELECT id, code, name, base_price_sen, price1_sen, seat_height_prices, model_id, base_model
                           FROM scm.mfg_products WHERE company_id = ${cid}`;
    const prodBy = new Map(prods.map((p) => [p.code, p]));
    const bindRows = await tx`SELECT b.id, b.supplier_id, b.item_code, s.code AS sup_code, b.is_main_supplier
                              FROM scm.supplier_material_bindings b JOIN scm.suppliers s ON s.id = b.supplier_id
                              WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product'`;
    const bindBy = new Map(bindRows.map((b) => [`${b.sup_code}||${b.item_code}`, b]));

    const audit = async (code, field, oldV, newV) => {
      if (!APPLY) return;
      await tx`INSERT INTO scm.master_price_history (item_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
               VALUES (${code}, ${field}, ${oldV ?? null}, ${newV}, ${REASON}, ${now}, ${cid})`;
    };

    // 1. mint 9058-Console
    if (!prodBy.has("9058-Console")) {
      const [m] = await tx`SELECT id, model_code, name FROM scm.product_models
                           WHERE company_id = ${cid} AND category = 'SOFA' AND model_code = '9058'`;
      const id = "mfg-" + randomBytes(6).toString("hex");
      const name = `SOFA ${m?.name ?? "9058"} CONSOLE`.toUpperCase();
      if (APPLY) await tx`INSERT INTO scm.mfg_products
        (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
        VALUES (${id}, ${"9058-Console"}, ${name}, 'SOFA', 'ACTIVE', 'ZANOTTI', '9058', ${m?.id ?? null}, ${cid}, ${now}, ${now})`;
      prodBy.set("9058-Console", { id, code: "9058-Console", name, base_price_sen: 0, price1_sen: 0, seat_height_prices: null });
      bump("mint");
    }

    // 2. bedframe price updates
    for (const u of plan.bf_updates) {
      const p = prodBy.get(u.erp);
      if (!p) { bump("bf_skip_no_product"); continue; }
      const sets = {};
      if (u.base_price_sen) { sets.base_price_sen = u.base_price_sen[1]; await audit(u.erp, "base_price_sen", u.base_price_sen[0], u.base_price_sen[1]); }
      if (u.price1_sen) { sets.price1_sen = u.price1_sen[1]; await audit(u.erp, "price1_sen", u.price1_sen[0], u.price1_sen[1]); }
      if (APPLY && Object.keys(sets).length)
        await tx`UPDATE scm.mfg_products SET ${tx(sets)}, updated_at = ${now} WHERE id = ${p.id}`;
      bump("bf_update");
    }

    // 3. sofa grid refresh
    for (const [sku, cells] of Object.entries(plan.sofa_grid)) {
      const p = prodBy.get(sku);
      if (!p) { bump("grid_skip_no_product"); console.log("  no product:", sku); continue; }
      const existing = Array.isArray(p.seat_height_prices) ? p.seat_height_prices.map((e) => ({ ...e })) : [];
      const byKey = new Map(existing.map((e) => [`${e.height}|${e.tier ?? "PRICE_2"}`, e]));
      let changed = 0;
      for (const [key, sen] of Object.entries(cells)) {
        const [h, t] = key.split("|");
        const cur = byKey.get(key);
        if (!cur) { byKey.set(key, { height: h, tier: t, priceSen: sen }); changed++; await audit(sku, `seat_height:${key}`, null, sen); }
        else if (cur.priceSen !== sen) { await audit(sku, `seat_height:${key}`, cur.priceSen ?? null, sen); cur.priceSen = sen; changed++; }
      }
      if (!changed) { bump("grid_noop"); continue; }
      if (APPLY) await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(Array.from(byKey.values()))}, updated_at = ${now} WHERE id = ${p.id}`;
      bump("grid_refresh");
    }

    // 4+5. trio bindings + main flip
    const materials = [];
    for (const b of plan.bedframe_bindings) {
      const matrix = b.p1 ? { P1: b.p1, P2: b.p2 } : { P2: b.p2 };
      materials.push({ erp: b.erp, sku: b.supplier_sku, flat: b.p2, matrix });
    }
    for (const [sku, cells] of Object.entries(plan.sofa_grid)) {
      const matrix = {};
      for (const [key, sen] of Object.entries(cells)) {
        const [h, t] = key.split("|");
        (matrix[h] ??= {})[{ PRICE_1: "P1", PRICE_2: "P2", PRICE_3: "P3" }[t]] = sen;
      }
      materials.push({ erp: sku, sku, flat: 0, matrix });
    }
    for (const m of materials) {
      if (!prodBy.has(m.erp)) { bump("bind_skip_no_product"); continue; }
      for (const supCode of TRIO) {
        const key = `${supCode}||${m.erp}`;
        const b = bindBy.get(key);
        if (!b) {
          if (APPLY) await tx`INSERT INTO scm.supplier_material_bindings
            (supplier_id, material_kind, item_code, material_name, supplier_sku,
             unit_price_sen, price_matrix, is_main_supplier, notes, company_id, created_at, updated_at)
            VALUES (${supBy[supCode]}, 'mfg_product', ${m.erp}, ${prodBy.get(m.erp).name}, ${m.sku},
                    ${m.flat}, ${tx.json(m.matrix)}, false, ${REASON}, ${cid}, ${now}, ${now})`;
          bindBy.set(key, { placeholder: true });
          bump("bind_insert");
        } else {
          if (APPLY) await tx`UPDATE scm.supplier_material_bindings
            SET unit_price_sen = ${m.flat}, price_matrix = ${tx.json(m.matrix)}, updated_at = ${now}
            WHERE company_id = ${cid} AND material_kind = 'mfg_product' AND item_code = ${m.erp}
              AND supplier_id = ${supBy[supCode]}`;
          bump("bind_refresh");
        }
      }
      if (APPLY) {
        await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = false, updated_at = ${now}
                 WHERE company_id = ${cid} AND material_kind = 'mfg_product' AND item_code = ${m.erp} AND is_main_supplier = true`;
        await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true, updated_at = ${now}
                 WHERE company_id = ${cid} AND material_kind = 'mfg_product' AND item_code = ${m.erp}
                   AND supplier_id = ${supBy[MAIN_TO]}`;
      }
      bump("main_to_h004");
    }

    note(`RESULT (${APPLY ? "APPLY" : "DRY-RUN"}): ${JSON.stringify(counts)}`);
    note(`not stocked by Houzs (report only): ${plan.not_stocked.length}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back, nothing written."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

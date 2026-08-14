// Make every loaded price visible + every combo composable (owner 2026-08-09:
// "全部都是空的" / chips not lighting).
//
//   1. THL heights were stored in cm; the UI's height columns are the
//      standard inches. Exact conversions: 60cm->24, 66cm->26, 75cm->30,
//      80cm->32 (120cm left as-is, reported). Renames keys in THL models'
//      seat grids, 400-T002 binding matrices, THL combo prices, and the
//      models' allowed_options.sizes.
//   2. Sizeless combos stored a "STD" key the UI can't render — the price
//      applies regardless of seat depth, so it is replicated across the six
//      standard height keys.
//   3. Combos referencing (R)/(P) mechanism pieces on models that never
//      opened them: open the compartments (+ mint the SKUs, unpriced) so
//      the picker chips light and the combo can actually match a build.
//      2372/2376/2379/2391: 1S(R)+1A(R) pair (+ P twins per "有R必有P");
//      5133/5150: 1A(P) pair; 5152: 1A(P) pair + 1S(P).
//
// DRY-RUN default; APPLY=1 writes.
//
// RE-RUN: inert. Every write is gated on `changed`, computed against the row as it reads now.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const CM = { "60cm": "24", "66cm": "26", "75cm": "30", "80cm": "32", "60CM": "24", "66CM": "26", "75CM": "30", "80CM": "32" };
const THL_MODELS = ["2372", "2376", "2379", "2391", "5133", "5135", "5142", "5150", "5152", "7202", "7212", "7218", "7219", "7221", "7223", "7226", "7233", "7238", "7251"];
const STD = ["24", "26", "28", "30", "32", "35"];
const MECH = {
  "2372": ["1S(R)", "1A(R)(LHF)", "1A(R)(RHF)", "1S(P)", "1A(P)(LHF)", "1A(P)(RHF)"],
  "2376": ["1S(R)", "1A(R)(LHF)", "1A(R)(RHF)", "1S(P)", "1A(P)(LHF)", "1A(P)(RHF)"],
  "2379": ["1S(R)", "1A(R)(LHF)", "1A(R)(RHF)", "1S(P)", "1A(P)(LHF)", "1A(P)(RHF)"],
  "2391": ["1S(R)", "1A(R)(LHF)", "1A(R)(RHF)", "1S(P)", "1A(P)(LHF)", "1A(P)(RHF)"],
  "5133": ["1A(P)(LHF)", "1A(P)(RHF)"],
  "5150": ["1A(P)(LHF)", "1A(P)(RHF)"],
  "5152": ["1A(P)(LHF)", "1A(P)(RHF)", "1S(P)"],
};

const renameKeys = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { changed: false, next: obj };
  let changed = false;
  const next = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = CM[k] ?? k;
    if (nk !== k) changed = true;
    if (next[nk] === undefined) next[nk] = v; else changed = true; // collision keeps first
  }
  return { changed, next };
};

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const stats = {}; const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();

    // 1a. THL SKU grids
    const grids = await tx`SELECT id, code, seat_height_prices FROM scm.mfg_products
      WHERE company_id = ${cid} AND category = 'SOFA' AND base_model = ANY(${THL_MODELS})
        AND seat_height_prices IS NOT NULL`;
    for (const p of grids) {
      if (!Array.isArray(p.seat_height_prices)) continue;
      let changed = false;
      const next = p.seat_height_prices.map((e) => {
        const nk = CM[e.height];
        if (nk) { changed = true; return { ...e, height: nk }; }
        return e;
      });
      if (changed) { bump("grid_rows"); if (APPLY) await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(next)}, updated_at = ${now} WHERE id = ${p.id}`; }
    }
    // 1b. THL binding matrices
    const mats = await tx`SELECT b.id, b.price_matrix FROM scm.supplier_material_bindings b
      JOIN scm.suppliers s ON s.id = b.supplier_id
      WHERE b.company_id = ${cid} AND s.code = '400-T002' AND b.price_matrix IS NOT NULL`;
    for (const b of mats) {
      const { changed, next } = renameKeys(b.price_matrix);
      if (changed) { bump("matrix_rows"); if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${tx.json(next)}, updated_at = ${now} WHERE id = ${b.id}`; }
    }
    // 1c. model sizes
    const models = await tx`SELECT id, model_code, allowed_options FROM scm.product_models
      WHERE company_id = ${cid} AND category = 'SOFA' AND model_code = ANY(${THL_MODELS})`;
    for (const m of models) {
      const opts = { ...(m.allowed_options || {}) };
      const sizes = (opts.sizes || []).map((s) => CM[s] ?? s);
      const uniq = [...new Set(sizes)];
      const changed = JSON.stringify(uniq) !== JSON.stringify(opts.sizes || []);
      // 3. mechanism compartments
      const add = (MECH[m.model_code] || []).filter((c) => !(opts.compartments || []).includes(c));
      if (changed || add.length) {
        opts.sizes = uniq;
        opts.compartments = [...(opts.compartments || []), ...add];
        bump("model_updates"); bump("mech_opened", add.length);
        if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(opts)}, updated_at = ${now} WHERE id = ${m.id}`;
        for (const c of add) {
          const code = `${m.model_code}-${c}`;
          const [ex] = await tx`SELECT 1 FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${code}`;
          if (ex) continue;
          bump("sku_minted");
          if (APPLY) await tx`INSERT INTO scm.mfg_products (id, code, name, category, status, branding, base_model, model_id, company_id, created_at, updated_at)
            VALUES (${"mfg-" + randomBytes(6).toString("hex")}, ${code}, ${("SOFA " + m.model_code + " " + c).toUpperCase()}, 'SOFA', 'ACTIVE', 'ZANOTTI', ${m.model_code}, ${m.id}, ${cid}, ${now}, ${now})`;
        }
      }
    }
    // 1d + 2. combos: cm keys + STD replication
    const combos = await tx`SELECT id, prices_by_height FROM scm.sofa_combo_pricing
      WHERE deleted_at IS NULL AND notes LIKE 'supplier-price-list-2026-08%'`;
    for (const cb of combos) {
      let obj = cb.prices_by_height || {};
      let { changed, next } = renameKeys(obj);
      if (next.STD !== undefined) {
        const v = next.STD; delete next.STD;
        for (const h of STD) if (next[h] === undefined) next[h] = v;
        changed = true; bump("combo_std_expanded");
      }
      if (changed) { bump("combo_rows"); if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET prices_by_height = ${tx.json(next)}, updated_at = ${now} WHERE id = ${cb.id}`; }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: ${JSON.stringify(stats)}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

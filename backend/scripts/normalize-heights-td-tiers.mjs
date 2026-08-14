// Two corrections (owner 2026-08-09: "还是很多空的价格"):
//
// 1. Non-standard height keys made prices invisible. Todern quoted 27"
//    (maps to the 28 column) and literally "?" for 5030/5066 (their only
//    depth — price is depth-independent). Normalization, across sofa seat
//    grids, binding matrices, combo prices and model size lists:
//      "27" -> "28"; "?" / "STD" / "120cm" / "2m" -> replicate across the
//      six standard heights (24/26/28/30/32/35) without clobbering.
// 2. The global tier shift wrongly bumped Todern's combos: TD's normal
//    band (B) already sat at PRICE_2 — live TD combos at PRICE_3 return
//    to PRICE_2. (TD grids/matrices were shifted correctly; combos only.)
//
// DRY-RUN default; APPLY=1 writes.
//
// RE-RUN: inert. Every write is gated on `changed` against the row as read, and a normalised row produces no change.
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const STD = ["24", "26", "28", "30", "32", "35"];
const SPREAD = new Set(["?", "STD", "120cm", "120CM", "2m", "2M"]);
const MAP27 = { "27": "28" };

function normObj(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { changed: false, next: obj };
  let changed = false;
  const next = {};
  const spreadVals = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SPREAD.has(k)) { spreadVals.push(v); changed = true; continue; }
    const nk = MAP27[k] ?? k;
    if (nk !== k) changed = true;
    if (next[nk] === undefined) next[nk] = v;
  }
  for (const v of spreadVals)
    for (const h of STD) if (next[h] === undefined) next[h] = v;
  return { changed, next };
}

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const stats = {}; const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    // grids
    const grids = await tx`SELECT id, code, seat_height_prices FROM scm.mfg_products
      WHERE company_id = ${cid} AND category = 'SOFA' AND seat_height_prices IS NOT NULL`;
    for (const p of grids) {
      if (!Array.isArray(p.seat_height_prices)) continue;
      let changed = false;
      let entries = [];
      for (const e of p.seat_height_prices) {
        if (SPREAD.has(e.height)) {
          changed = true;
          for (const h of STD)
            if (!p.seat_height_prices.some((x) => x.height === h && (x.tier ?? "PRICE_2") === (e.tier ?? "PRICE_2")))
              entries.push({ ...e, height: h });
          continue;
        }
        const nk = MAP27[e.height];
        if (nk) { changed = true; entries.push({ ...e, height: nk }); continue; }
        entries.push(e);
      }
      if (changed) { bump("grids"); if (APPLY) await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(entries)}, updated_at = ${now} WHERE id = ${p.id}`; }
    }
    // matrices
    const mats = await tx`SELECT b.id, b.price_matrix FROM scm.supplier_material_bindings b
      WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product' AND b.price_matrix IS NOT NULL`;
    for (const b of mats) {
      const { changed, next } = normObj(b.price_matrix);
      if (changed) { bump("matrices"); if (APPLY) await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${tx.json(next)}, updated_at = ${now} WHERE id = ${b.id}`; }
    }
    // combos: heights + TD tier revert
    const combos = await tx`SELECT id, notes, tier, prices_by_height FROM scm.sofa_combo_pricing
      WHERE deleted_at IS NULL AND notes LIKE 'supplier-price-list-2026-08%'`;
    for (const cb of combos) {
      const { changed, next } = normObj(cb.prices_by_height || {});
      const tdFix = cb.notes.endsWith("(TD)") && cb.tier === "PRICE_3";
      if (changed || tdFix) {
        bump(changed ? "combo_heights" : "x", changed ? 1 : 0);
        if (tdFix) bump("td_tier_reverted");
        if (APPLY) await tx`UPDATE scm.sofa_combo_pricing
          SET prices_by_height = ${tx.json(next)}, tier = ${tdFix ? "PRICE_2" : cb.tier}, updated_at = ${now}
          WHERE id = ${cb.id}`;
      }
    }
    // model sizes
    const models = await tx`SELECT id, model_code, allowed_options FROM scm.product_models
      WHERE company_id = ${cid} AND category = 'SOFA'`;
    for (const m of models) {
      const sizes = ((m.allowed_options || {}).sizes || []);
      const mapped = sizes.map((s) => MAP27[s] ?? s).filter((s) => STD.includes(s));
      const uniq = [...new Set(mapped)];
      if (JSON.stringify(uniq) !== JSON.stringify(sizes)) {
        bump("model_sizes");
        const opts = { ...(m.allowed_options || {}), sizes: uniq };
        if (APPLY) await tx`UPDATE scm.product_models SET allowed_options = ${tx.json(opts)}, updated_at = ${now} WHERE id = ${m.id}`;
      }
    }
    delete stats.x;
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: ${JSON.stringify(stats)}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

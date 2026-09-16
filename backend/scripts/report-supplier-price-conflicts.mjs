// Read-only report: SKUs and sofa combos whose SUPPLIER prices DISAGREE, per
// company.
//
// WHY THIS EXISTS. The auto-derive rule (owner 2026-09-16) takes the MOST
// EXPENSIVE supplier's price when a SKU/combo has several. That is safe when the
// several prices are genuinely different suppliers quoting the same thing — but
// when two prices disagree because one is WRONG or a stale duplicate, "take the
// max" would silently pick the wrong (dearer) one. The owner's instruction
// ("sofa combo 有两个怎么办 … remove 错的 或 edit"): surface the disagreements so
// he can remove the wrong row or edit it. This lists them; it changes nothing.
//
// It complements report-product-binding-gaps.mjs: that one finds SKUs with NO
// supplier price (empty derivation); this one finds SKUs/combos with MORE THAN
// ONE that disagree.
//
// A "conflict" here = a SKU (or a combo scope) with >1 supplier price whose
// comparable values are not all equal. The comparable value mirrors the
// derivation's "dearness": flat unit_price_sen, or for a matrix the dearest
// cell (bedframe P2/P1, sofa any cell). Equal prices from several suppliers are
// NOT a conflict and are not listed.
//
// SELECT only. No writes, no transaction. Reads COMPANY_ID (blank = both) and
// LIST_LIMIT (blank = 60 per section per company). Exit 0 for every real answer.
// Run it: Actions -> "Run a backend script on production (plan / apply)" ->
// script = report-supplier-price-conflicts.mjs, mode = plan, env = COMPANY_ID=1.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const companyFilter = (() => {
  const raw = String(process.env.COMPANY_ID ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`COMPANY_ID must be a positive integer or blank; got '${raw}'.`);
    process.exit(1);
  }
  return n;
})();
const listLimit = (() => {
  const raw = String(process.env.LIST_LIMIT ?? "").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 60;
})();

const rm = (sen) => (sen == null ? "-" : (Number(sen) / 100).toFixed(2));

/** Coerce a JSONB cell to a non-negative integer or null. */
function asCent(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** The comparable "dearness" of one supplier price, mirroring the derivation
 *  (report-only — it decides which rows to flag, never which one wins). */
function dearness(category, unit_price_sen, price_matrix) {
  const cat = String(category ?? "").toUpperCase();
  const flat = asCent(unit_price_sen) ?? 0;
  const m = obj(price_matrix);
  if (cat === "BEDFRAME") return asCent(m.P2) ?? asCent(m.P1) ?? flat;
  if (cat === "SOFA") {
    let max = 0;
    let saw = false;
    for (const cell of Object.values(m)) {
      for (const v of Object.values(obj(cell))) {
        const c = asCent(v);
        if (c !== null) {
          saw = true;
          if (c > max) max = c;
        }
      }
    }
    return saw ? max : flat;
  }
  return flat;
}

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // ── Section A: per-SKU supplier price conflicts ──────────────────────────
  const skuRows = await pg`
    WITH multi AS (
      SELECT company_id, item_code
      FROM scm.supplier_material_bindings
      WHERE material_kind = 'mfg_product'
        AND (${companyFilter}::int IS NULL OR company_id = ${companyFilter})
      GROUP BY company_id, item_code
      HAVING count(DISTINCT supplier_id) > 1
    )
    SELECT b.company_id, b.item_code, b.supplier_id, sup.name AS supplier_name,
           b.is_main_supplier, b.unit_price_sen, b.price_matrix, p.category
    FROM scm.supplier_material_bindings b
    JOIN multi m ON m.company_id = b.company_id AND m.item_code = b.item_code
    LEFT JOIN scm.suppliers sup ON sup.id = b.supplier_id
    LEFT JOIN scm.mfg_products p ON p.company_id = b.company_id AND p.code = b.item_code
    WHERE b.material_kind = 'mfg_product'
    ORDER BY b.company_id, b.item_code, b.supplier_id`;

  // group by (company, item_code)
  const bySku = new Map();
  for (const r of skuRows) {
    const key = JSON.stringify([r.company_id, r.item_code]);
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(r);
  }
  const conflictsByCompany = new Map(); // company -> [{item_code, category, suppliers[]}]
  for (const [, rows] of bySku) {
    const values = rows.map((r) => dearness(r.category, r.unit_price_sen, r.price_matrix));
    const distinct = new Set(values);
    if (distinct.size <= 1) continue; // agree -> not a conflict
    const co = rows[0].company_id;
    if (!conflictsByCompany.has(co)) conflictsByCompany.set(co, []);
    conflictsByCompany.get(co).push({
      item_code: rows[0].item_code,
      category: rows[0].category,
      suppliers: rows.map((r) => ({
        name: r.supplier_name ?? r.supplier_id,
        main: Boolean(r.is_main_supplier),
        dear: dearness(r.category, r.unit_price_sen, r.price_matrix),
      })),
    });
  }

  notice("===== Section A: SKUs where supplier prices DISAGREE =====");
  const skuCompanies = [...conflictsByCompany.keys()].sort((a, b) => a - b);
  if (skuCompanies.length === 0) {
    notice("No SKU-level supplier price conflicts (every multi-supplier SKU agrees).");
  }
  for (const co of skuCompanies) {
    const list = conflictsByCompany.get(co);
    notice("");
    notice(`--- Company ${co}: ${list.length} SKU(s) with disagreeing supplier prices ---`);
    notice("(the derivation would take the MAX; a wrong/stale row should be removed or edited)");
    for (const c of list.slice(0, listLimit)) {
      const parts = c.suppliers
        .sort((a, b) => b.dear - a.dear)
        .map((s) => `${s.name}=RM${rm(s.dear)}${s.main ? "*" : ""}`)
        .join("  |  ");
      notice(`  ${c.item_code} [${c.category ?? "-"}]: ${parts}`);
    }
    if (list.length > listLimit) notice(`  ... ${list.length - listLimit} more (raise LIST_LIMIT).`);
  }

  // ── Section B: sofa combo supplier price conflicts ───────────────────────
  const comboRows = await pg`
    WITH live AS (
      SELECT company_id, base_model, modules::text AS modules_key, tier::text AS tier,
             supplier_id, prices_by_height, label,
             row_number() OVER (
               PARTITION BY company_id, base_model, modules::text, tier, supplier_id
               ORDER BY effective_from DESC, created_at DESC
             ) AS rn
      FROM scm.sofa_combo_pricing
      WHERE deleted_at IS NULL AND supplier_id IS NOT NULL
        AND (${companyFilter}::int IS NULL OR company_id = ${companyFilter})
    )
    SELECT company_id, base_model, modules_key, tier, supplier_id, prices_by_height, label
    FROM live WHERE rn = 1
    ORDER BY company_id, base_model, modules_key, tier`;

  const byCombo = new Map();
  for (const r of comboRows) {
    const key = JSON.stringify([r.company_id, r.base_model, r.modules_key, r.tier]);
    if (!byCombo.has(key)) byCombo.set(key, []);
    byCombo.get(key).push(r);
  }
  const comboConflicts = new Map(); // company -> [{base_model, tier, label, suppliers[]}]
  for (const [, rows] of byCombo) {
    if (rows.length <= 1) continue; // one supplier -> nothing to conflict
    // dearest cell of a combo's prices_by_height {height:{P1,P2,P3}} (cost side)
    const dearOf = (pbh) => {
      let max = 0;
      for (const cell of Object.values(obj(pbh))) {
        for (const v of Object.values(obj(cell))) {
          const c = asCent(v);
          if (c !== null && c > max) max = c;
        }
      }
      return max;
    };
    const values = rows.map((r) => dearOf(r.prices_by_height));
    if (new Set(values).size <= 1) continue; // agree
    const co = rows[0].company_id;
    if (!comboConflicts.has(co)) comboConflicts.set(co, []);
    comboConflicts.get(co).push({
      base_model: rows[0].base_model,
      tier: rows[0].tier,
      label: rows[0].label,
      suppliers: rows.map((r) => ({ id: r.supplier_id, dear: dearOf(r.prices_by_height) })),
    });
  }

  notice("");
  notice("===== Section B: sofa COMBOS where supplier prices DISAGREE =====");
  const comboCompanies = [...comboConflicts.keys()].sort((a, b) => a - b);
  if (comboCompanies.length === 0) {
    notice("No sofa-combo supplier price conflicts.");
  }
  for (const co of comboCompanies) {
    const list = comboConflicts.get(co);
    notice("");
    notice(`--- Company ${co}: ${list.length} combo(s) with disagreeing supplier prices ---`);
    for (const c of list.slice(0, listLimit)) {
      const parts = c.suppliers
        .sort((a, b) => b.dear - a.dear)
        .map((s) => `${s.id.slice(0, 8)}=RM${rm(s.dear)}`)
        .join("  |  ");
      notice(`  ${c.base_model} [${c.tier}] ${c.label ?? ""}: ${parts}`);
    }
    if (list.length > listLimit) notice(`  ... ${list.length - listLimit} more (raise LIST_LIMIT).`);
  }
} finally {
  await pg.end({ timeout: 5 });
}

// Load every decodable supplier combo from the 2026-08 price-list workbook
// into scm.sofa_combo_pricing (owner 2026-08-09: "所有的 Sofa Combo 该绑定的
// 都绑定掉 — 结构跟 Hookka 一样").
//
// 159 combos across Armani / Dorsettloft / Red Sofa / Todern / THL, decoded
// with the Hookka grammar + owner templates (p1L = 1A(P)+1NA+L; E = raised
// arm = 1A; recliners split per mechanism). Package prices only — no
// arithmetic derivation. Each row inserts SUPPLIER-scoped (PO cost path);
// rows whose supplier is that model's MAIN also insert a MASTER row (the
// Products page + SO costing). Hookka's own combos came from the quotation
// loader and are untouched.
//
// DRY-RUN default; APPLY=1 writes. Dedupe per scope on
// (base_model, tier, modules-key).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const rows = JSON.parse(readFileSync(new URL("./data/supplier-combos-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const EFFECTIVE = "2026-08-09";
const key = (mods) => mods.map((s) => [...s].sort().join("|")).sort().join("||");

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const sups = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${co.id}`;
  const supBy = Object.fromEntries(sups.map((s) => [s.code, s.id]));
  const existing = await sql`SELECT base_model, modules, tier, supplier_id
    FROM scm.sofa_combo_pricing WHERE deleted_at IS NULL`;
  const have = new Set(existing.map((e) => `${e.supplier_id ?? "master"}||${e.base_model}||${e.tier}||${key(e.modules)}`));

  let ins = 0, skip = 0, noSup = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      const sid = supBy[r.supplier_code];
      if (!sid) { noSup++; continue; }
      const scopes = r.master ? [sid, null] : [sid];
      for (const scope of scopes) {
        const k = `${scope ?? "master"}||${r.base_model}||${r.tier}||${key(r.modules)}`;
        if (have.has(k)) { skip++; continue; }
        have.add(k);
        ins++;
        if (APPLY) await tx`INSERT INTO scm.sofa_combo_pricing
          (base_model, modules, tier, supplier_id, prices_by_height, label, effective_from, notes)
          VALUES (${r.base_model}, ${tx.json(r.modules)}, ${r.tier}, ${scope},
                  ${tx.json(r.prices_by_height)}, ${r.label}, ${EFFECTIVE}, ${r.notes})`;
      }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: insert ${ins}, skip-existing ${skip}, no-supplier ${noSup} (${rows.length} source combos)`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

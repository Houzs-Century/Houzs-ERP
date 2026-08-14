// Load the 14 supplier-cost combos from the HOOKKA INDUSTRIES quotation
// (Customer 300-H, effective 2026-08-09) into scm.sofa_combo_pricing.
//
// These are Hookka's package prices for module combinations (owner: combo =
// 几个 compartment 的组合打包价). Stored as SUPPLIER-scoped rows
// (supplier_id = 400-H004 HOOKKA INDUSTRIES) so the PO cost path picks them
// up; the sales-side (customer-scoped) combos stay owner-curated in the UI.
//
// Append-only table: a row is only inserted when no live row exists for the
// same (base_model, modules-key, tier, supplier) with effective_from >= the
// quotation date. DRY-RUN default; APPLY=1 writes.
//
// RE-RUN: inert while the tiers are unshifted - it dedupes on (scope, base_model, tier, modules). retier-sofa-tiers.mjs MOVES those tiers, so a run after the shift would not recognise its own rows and would insert them all again.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const rows = JSON.parse(readFileSync(new URL("./data/hookka-combos-2026-08-09.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const EFFECTIVE = "2026-08-09";

// canonical slots key: sort codes inside each slot, sort slots, join — mirrors
// comboSlotsKey's intent well enough for our own dedupe
const key = (mods) => mods.map((s) => [...s].sort().join("|")).sort().join("||");

try {
  const [sup] = await sql`SELECT s.id FROM scm.suppliers s
    JOIN public.companies c ON c.id = s.company_id
    WHERE c.code = 'HOUZS' AND s.code = '400-H004'`;
  if (!sup) throw new Error("supplier 400-H004 missing");

  // two scopes: supplier rows feed the PO cost path; MASTER rows are what the
  // Products page shows (its list filters supplier_id IS NULL) and what SO
  // costing reads — owner 2026-08-09: "hookka sofa combo dont have?"
  const existing = await sql`SELECT base_model, modules, tier, supplier_id
    FROM scm.sofa_combo_pricing
    WHERE (supplier_id = ${sup.id} OR (supplier_id IS NULL AND customer_id IS NULL)) AND deleted_at IS NULL`;
  const have = new Set(existing.map((e) => `${e.supplier_id ?? "master"}||${e.base_model}||${e.tier}||${key(e.modules)}`));

  let ins = 0, skip = 0;
  await sql.begin(async (tx) => {
    for (const r of rows) {
      for (const scope of [sup.id, null]) {
        const k = `${scope ?? "master"}||${r.base_model}||${r.tier}||${key(r.modules)}`;
        if (have.has(k)) { skip++; continue; }
        ins++;
        if (APPLY) {
          await tx`INSERT INTO scm.sofa_combo_pricing
            (base_model, modules, tier, supplier_id, prices_by_height, label, effective_from, notes)
            VALUES (${r.base_model}, ${tx.json(r.modules)}, ${r.tier}, ${scope},
                    ${tx.json(r.prices_by_height)}, ${r.label}, ${EFFECTIVE}, ${r.notes})`;
        }
      }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: insert ${ins}, skip-existing ${skip} of ${rows.length} x2 scopes`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

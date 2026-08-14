// Align the 407 SKUs minted by the 2026-08 supplier price-list load to the
// house display-name convention: "SOFA {NAME} {COMP}" — the auto-create
// template prepends branding ("ZANOTTI SOFA …"), but every pre-existing sofa
// SKU is named without the prefix (owner 2026-08-09: "跟我现在的格式 same").
//
// Renames NAME ONLY (codes untouched) on scm.mfg_products and mirrors the
// same fix onto supplier_material_bindings.material_name for those codes.
// Scope: HOUZS company + exactly the minted code list + names that actually
// start with 'ZANOTTI SOFA '. DRY-RUN default; APPLY=1 to write.
//
// RE-RUN: inert. regexp_replace on a '^ZANOTTI SOFA ' prefix the first run removes; a renamed row no longer matches.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
const codes = JSON.parse(readFileSync(new URL("./data/minted-sofa-skus-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const rows = await sql`
    SELECT id, code, name FROM scm.mfg_products
    WHERE company_id = ${co.id} AND code = ANY(${codes}) AND name LIKE 'ZANOTTI SOFA %'`;
  note(`${rows.length} of ${codes.length} minted SKUs carry the ZANOTTI prefix`);
  for (const r of rows.slice(0, 8)) console.log(`  ${r.code}: "${r.name}" -> "${r.name.replace(/^ZANOTTI /, "")}"`);
  if (APPLY && rows.length) {
    await sql.begin(async (tx) => {
      const p = await tx`UPDATE scm.mfg_products
        SET name = regexp_replace(name, '^ZANOTTI SOFA ', 'SOFA '), updated_at = now()
        WHERE company_id = ${co.id} AND code = ANY(${codes}) AND name LIKE 'ZANOTTI SOFA %'`;
      const b = await tx`UPDATE scm.supplier_material_bindings
        SET material_name = regexp_replace(material_name, '^ZANOTTI SOFA ', 'SOFA '), updated_at = now()
        WHERE company_id = ${co.id} AND material_kind = 'mfg_product'
          AND material_code = ANY(${codes}) AND material_name LIKE 'ZANOTTI SOFA %'`;
      if (p.count !== rows.length) throw new Error(`expected ${rows.length} product renames, got ${p.count} — rolled back`);
      note(`APPLIED: ${p.count} product names + ${b.count} binding names aligned`);
    });
  } else {
    note(APPLY ? "nothing to rename" : "DRY-RUN: nothing written");
  }
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });

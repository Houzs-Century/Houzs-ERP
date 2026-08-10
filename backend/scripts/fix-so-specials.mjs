#!/usr/bin/env node
// Repair imported bedframe SPECIAL ORDERS: map the free-text I lifted out of the
// AutoCount Desc2 onto the REAL option codes in scm.special_addons, so the
// "Special Orders" checkboxes tick actual options instead of showing a
// "retired — untick to remove" custom string.
//
// Owner 2026-08-09 saw `HB&divanfullcover` written as a custom (retired) special
// while the genuine options `HB Fully Cover` + `Divan Full Cover` sat unticked.
// One AutoCount phrase can map to SEVERAL options (HB & divan fully cover = both).
// Anything that still cannot be mapped is REPORTED, not written as a custom value.
//
// DRY-RUN by default; APPLY=1 to write.
import postgres from "postgres";
import { mapSpecial } from "./lib/bedframe-special-map.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const valid = new Set((await sql`SELECT code FROM scm.special_addons WHERE company_id = 1 AND 'BEDFRAME' = ANY(categories)`).map((r) => r.code));
  log(`valid BEDFRAME option codes: ${valid.size}`);

  const rows = await sql`SELECT id, doc_no, item_code, custom_specials, variants
    FROM scm.mfg_sales_order_items
    WHERE company_id = 1 AND item_group = 'bedframe' AND custom_specials IS NOT NULL`;
  log(`bedframe lines carrying specials: ${rows.length}`);

  const updates = []; const unmapped = new Map();
  for (const r of rows) {
    const raws = Array.isArray(r.custom_specials) ? r.custom_specials : [r.custom_specials];
    const codes = new Set();
    for (const raw of raws) {
      const m = mapSpecial(raw).filter((c) => valid.has(c));
      if (!m.length) unmapped.set(String(raw), (unmapped.get(String(raw)) || 0) + 1);
      for (const c of m) codes.add(c);
    }
    if (codes.size) updates.push({ id: r.id, doc: r.doc_no, codes: [...codes], from: raws });
  }
  log(`lines that map to real options: ${updates.length}`);
  for (const u of updates.slice(0, 8)) log(`   ${u.doc} ${JSON.stringify(u.from)} -> ${JSON.stringify(u.codes)}`);
  log(`phrases that map to NOTHING: ${unmapped.size}`);
  for (const [k, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) log(`   ${n}x "${k}"`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        await tx`UPDATE scm.mfg_sales_order_items
                    SET custom_specials = ${sql.json(u.codes)},
                        variants = COALESCE(variants, '{}'::jsonb) || ${sql.json({ specials: u.codes })}
                  WHERE id = ${u.id}`;
      }
    });
  }
  log(`DONE. lines fixed: ${updates.length}; unmapped phrases left as-is: ${unmapped.size}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

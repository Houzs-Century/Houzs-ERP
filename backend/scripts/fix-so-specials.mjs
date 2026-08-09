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
import fs from "node:fs";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/* Map one AutoCount special phrase -> the set of real option codes it means.
   Order matters: the HB+divan combos must be tested before plain "HB fully cover",
   and "straight" is independent of the cover options. */
function mapSpecial(raw) {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return [];
  const out = new Set();
  const hasHB = /\bhb\b|headboard/.test(s);
  const hasDivan = /\bdivan\b|\bdiv\b/.test(s);
  const cover = /cover/.test(s);
  const straight = /straight|staright|\bhb s\b|\bhb s$/.test(s); // incl. common typos/abbrev
  const topOnly = /\btop\b/.test(s);
  if (cover) {
    if (hasHB) out.add("HB Fully Cover");
    if (hasDivan) out.add(topOnly ? "Divan Top Fully Cover" : "Divan Full Cover");
    if (!hasHB && !hasDivan) out.add("HB Fully Cover"); // bare "fully cover" on a bedframe = HB
  }
  if (straight) out.add("HB Straight");
  if (/no side panel|without panel/.test(s)) out.add("No Side Panel");
  // "HB and Divan" / "HB flip on wall" with no other keyword = the HB treatment
  if (!out.size && hasHB && (hasDivan || /flip|wall|fabric|behind/.test(s))) out.add("HB Fully Cover");
  if (!out.size && hasHB && hasDivan) out.add("Divan Full Cover");
  if (/headboard only/.test(s)) out.add("Headboard Only");
  if (/nylon/.test(s)) out.add("Nylon Fabric");
  if (/left drawer/.test(s)) out.add("Left Drawer");
  if (/right drawer/.test(s)) out.add("Right Drawer");
  if (/front drawer/.test(s)) out.add("Front Drawer");
  if (/1 piece divan|one piece divan/.test(s)) out.add("1 Piece Divan");
  if (/divan curve/.test(s)) out.add("Divan Curve");
  if (/divan a11/.test(s)) out.add("Divan A11");
  return [...out];
}

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

#!/usr/bin/env node
// Unify the 2990 showroom venue name to a single label everywhere the owner
// sees it. Owner 2026-07-24 chose "2990s PJ". The showroom SOs were imported
// carrying "PJ Showroom" etc.; the warehouse venue_name / picker read different
// casings. This overwrites:
//   1. the 2990 showroom warehouse.venue_name  -> TARGET
//   2. every company_2 SO whose venue is a SHOWROOM-name variant -> TARGET
// It only touches showroom-name variants (never a real exhibition venue like an
// AEON mall), so a project/exhibition SO keeps its own venue.
// DRY-RUN unless APPLY=1. TARGET overridable via env.
//
// RE-RUN: convergent. Writes one fixed venue name; a second run rewrites the same string.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const TARGET = (process.env.TARGET || "2990s PJ").trim();
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
// Every casing/spacing the showroom venue has appeared as (lowercased match).
const VARIANTS = ["pj showroom", "pj-showroom", "pjshowroom", "2990s pj", "2990spj", "2990 pj"];

async function main() {
  const [c] = await dst`SELECT id FROM companies WHERE code='2990'`;
  const cid = Number(c.id);
  log(`2990 company_id=${cid}  mode=${APPLY ? "APPLY" : "DRY-RUN"}  TARGET="${TARGET}"`);

  // 1. warehouse venue_name -> TARGET (showroom rows only).
  const wh = await dst`SELECT id, code, name, venue_name FROM scm.warehouses WHERE company_id=${cid} AND is_showroom=true`;
  for (const w of wh) log(`  showroom [${w.code}] ${w.name}: venue_name="${w.venue_name ?? ""}" -> "${TARGET}"`);

  // 2. SO venues that are a showroom-name variant (case-insensitive).
  const soRows = await dst`
    SELECT venue, count(*)::int AS n FROM scm.mfg_sales_orders
     WHERE company_id=${cid} AND venue IS NOT NULL AND btrim(venue)<>''
     GROUP BY venue ORDER BY n DESC`;
  let willChange = 0; const keep = [];
  for (const r of soRows) {
    const isVariant = VARIANTS.includes(String(r.venue).trim().toLowerCase());
    if (isVariant && String(r.venue).trim() !== TARGET) { willChange += r.n; log(`  SO venue "${r.venue}" (${r.n}) -> "${TARGET}"`); }
    else keep.push(`"${r.venue}" (${r.n})${String(r.venue).trim() === TARGET ? " [already]" : " [NOT a showroom variant — left]"}`);
  }
  log("");
  log(`SO venues that would change to "${TARGET}": ${willChange}`);
  if (keep.length) { log("left untouched:"); for (const k of keep) log(`  ${k}`); }

  if (!APPLY) { log(""); log("DRY-RUN — no writes. APPLY=1 to unify."); return; }

  for (const w of wh) await dst`UPDATE scm.warehouses SET venue_name=${TARGET} WHERE id=${w.id}`;
  const vlist = VARIANTS;
  const res = await dst`
    UPDATE scm.mfg_sales_orders SET venue=${TARGET}
     WHERE company_id=${cid} AND lower(btrim(venue)) = ANY(${vlist}) AND btrim(venue) <> ${TARGET}`;
  log("");
  log(`APPLIED — warehouse venue_name set to "${TARGET}"; ${res.count} SO venues unified to "${TARGET}".`);
}
main().then(() => dst.end()).catch(async (e) => { console.error("VENUE_UNIFY_FAIL", e.message); try { await dst.end(); } catch {} process.exit(1); });

// STEP 3 EMPTY-DELETE (owner spec, read-only by default). A project that is COMPLETELY empty --
// ZERO non-archived finance lines, ZERO phase photos, ZERO checklist attachments -- and that
// matches NO in-scope Excel event with real sales is "not a real project" (owner) and can be
// deleted. Scope 2024-01-01..2026-06-30 ONLY; projects on/after 2026-07-01 (legit future
// placeholders) are never considered, and anything with ANY finance line / photo / document is
// never a candidate. Matching reuses reconcile-audit's canonVenue + brand + venue + 10-day window.
//
// Conservative delete policy (money-data safety + owner's "events 一定 match 得上"): a completely
// empty project is auto-deletable ONLY when it either (a) matches a BLANK Excel row (sales=0) at
// the same brand+venue -- a stray booth, or (b) has NO same-brand Excel event anywhere near its
// date -- genuinely absent. Empty projects where a same-brand Excel event exists but the VENUE or
// DATE is off (a likely matcher/data mismatch, not a phantom project) are listed for OWNER REVIEW,
// never auto-deleted. Dry-run (default) reports all buckets; --commit deletes only bucket (a)+(b).
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const STATE_TAIL = /\b(KL|PG|PNG|JB|JHB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
const ABBR = [[/\bTMN\b/gi, "TAMAN"], [/\bBKT\b/gi, "BUKIT"], [/\bBUKTI\b/gi, "BUKIT"], [/\bMILLENIUM\b/gi, "MILLENNIUM"]];
const expandAbbr = (s) => { let v = String(s ?? ""); for (const [re, to] of ABBR) v = v.replace(re, to); return v; };
const venueNorm = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
function canonOld(raw) {
  const u = norm(raw);
  if (u.includes("SOUTHKEY")) return "MVEC SOUTHKEY";
  if (u.includes("MVEC") || u.includes("MIDVALLEY")) return "MID VALLEY";
  if (u.includes("PAVILION") || u.includes("PAVILLION")) return "PAVILION BUKIT JALIL";
  if (u.includes("STADIUM") && u.includes("JALIL")) return "STADIUM BUKIT JALIL";
  if (u.includes("STARLING")) return "THE STARLING MALL";
  if (u.includes("SPCC") || u.includes("SUNWAYPYRAMID")) return "SPCC";
  if (u.includes("SSCC") || u.includes("SETIASPICE")) return "SETIA SPICE CONVENTION CENTRE";
  if (u.includes("SPICEARENA") || u.includes("PISA")) return "PISA SPICE ARENA CONVENTION CENTRE";
  if (u.includes("IOICITYMALL")) return "IOI MALL PUTRAJAYA";
  if (u.includes("IOIDAMANSARA")) return "IOI MALL DAMANSARA";
  if (u.includes("TERBAU") || u.includes("TEBRAU")) return "AEON TEBRAU CITY";
  if (u.includes("PERSADA")) return "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE";
  if (u.includes("VIVACITY")) return "VIVACITY MEGAMALL";
  if (u.includes("ALMA") && u.includes("MERTAJAM")) return "AEON BUKIT MERTAJAM";
  if (u.includes("AEONCHERAS") && !u.includes("SELATAN")) return "AEON TAMAN MALURI";
  if (u.includes("BCCK")) return "BCCK KUCHING";
  if (u.includes("SCCC") || u.includes("SETIACITY")) return "SCCC SHAH ALAM";
  if (u.includes("METROCITY") || (u.includes("MCC") && u.includes("KUCHING"))) return "KUCHING METROCITY CONVENTION CENTRE";
  if ((u.includes("INDERAMULIA") || u.includes("ENDERAMULIA")) || (u.includes("STADIUM") && u.includes("IPOH"))) return "STADIUM INDERA MULIA IPOH";
  return raw;
}
const RENAME = {
  MITC: "MELAKA INTERNATIONAL TRADE CENTRE", MITEC: "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE",
  "BCCK KUCHING": "BORNEO CONVENTION CENTRE KUCHING", "SCCC SHAH ALAM": "SETIA CITY CONVENTION CENTRE",
  "KLCC CONVENTION CENTRE": "KUALA LUMPUR CONVENTION CENTRE", PWCC: "PENANG WATERFRONT CONVENTION CENTRE",
  SPCC: "SUNWAY PYRAMID CONVENTION CENTRE", SICC: "SABAH INTERNATIONAL CONVENTION CENTRE",
  ITCC: "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE", "AICC AUSTIN": "AUSTIN INTERNATIONAL CONVENTION CENTRE",
  "PICCA BUTTERWORTH ARENA": "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE",
  "DATARAN PAHLAWAN": "DATARAN PAHLAWAN MELAKA MEGAMALL",
  "DATARAN CENTRIO SEREMBAN": "DATARAN CENTRIO", "EAST COAST MALL KUANTAN": "EAST COAST MALL",
  "IOI DAMANSARA": "IOI MALL DAMANSARA", "MCCC KUCHING": "KUCHING METROCITY CONVENTION CENTRE",
};
const KWRENAME = [
  [/\bMITEC\b/, "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE"], [/\bMITC\b/, "MELAKA INTERNATIONAL TRADE CENTRE"],
  [/\bKLCC\b/, "KUALA LUMPUR CONVENTION CENTRE"], [/\bPWCC\b/, "PENANG WATERFRONT CONVENTION CENTRE"],
  [/\bSPCC\b|SUNWAY\s*PYRAMID/, "SUNWAY PYRAMID CONVENTION CENTRE"], [/\bSCCC\b|SETIA\s*CITY/, "SETIA CITY CONVENTION CENTRE"],
  [/\bBCCK\b/, "BORNEO CONVENTION CENTRE KUCHING"], [/\bSICC\b/, "SABAH INTERNATIONAL CONVENTION CENTRE"],
  [/\bITCC\b/, "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE"], [/\bAICC\b/, "AUSTIN INTERNATIONAL CONVENTION CENTRE"],
  [/\bPICCA\b/, "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE"],
];
const canonVenue = (raw) => {
  const u = " " + String(raw ?? "").toUpperCase() + " ";
  for (const [re, name] of KWRENAME) if (re.test(u)) return name;
  const old = canonOld(raw);
  return RENAME[old] ?? old;
};
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const toRm = (v) => Math.round(Number(v || 0));

async function main() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name, p.created_by,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) AS nlines,
           (SELECT COUNT(*) FROM project_phase_photos ph WHERE ph.project_id = p.id) AS nphotos,
           (SELECT COUNT(*) FROM project_checklist_attachments a
              JOIN project_checklist ci ON ci.id = a.item_id
             WHERE ci.project_id = p.id AND a.archived_at IS NULL) AS ndocs
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;

  // Excel index by brand|venueNorm(canon). Keep sales>0 and blank(=0) separately.
  const idxSales = new Map(), idxBlank = new Map(), idxBrand = new Map();
  for (const e of events) {
    const k = `${norm(e.brand)}|${venueNorm(canonVenue(e.venue))}`;
    (toRm(e.sales) > 0 ? idxSales : idxBlank).get(k) || (toRm(e.sales) > 0 ? idxSales : idxBlank).set(k, []);
    (toRm(e.sales) > 0 ? idxSales : idxBlank).get(k).push(e);
    const b = norm(e.brand); (idxBrand.get(b) || idxBrand.set(b, []).get(b)).push(e);
  }

  const empties = projects.filter((p) => Number(p.nlines) === 0);
  const withContent = empties.filter((p) => Number(p.nphotos) > 0 || Number(p.ndocs) > 0); // spared by guard
  const bare = empties.filter((p) => Number(p.nphotos) === 0 && Number(p.ndocs) === 0);

  const matchesBlank = [], absent = [], dateMiss = [], venueMiss = [], hasSalesMatch = [];
  for (const p of bare) {
    const vk = venueNorm(p.venue);
    const salesHit = (idxSales.get(`${norm(p.brand)}|${vk}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (salesHit.length) { hasSalesMatch.push({ p, e: salesHit[0] }); continue; } // real event missing its fill -> leave
    const blankHit = (idxBlank.get(`${norm(p.brand)}|${vk}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (blankHit.length) { matchesBlank.push({ p, e: blankHit[0] }); continue; }
    const sameBrandVenueAnyDate = (idxSales.get(`${norm(p.brand)}|${vk}`) || idxBlank.get(`${norm(p.brand)}|${vk}`) || []);
    if (sameBrandVenueAnyDate.length) { dateMiss.push({ p, e: sameBrandVenueAnyDate[0] }); continue; }
    const nearBrand = (idxBrand.get(norm(p.brand)) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (nearBrand.length) { venueMiss.push({ p, e: nearBrand[0] }); continue; }
    absent.push({ p });
  }

  const deletable = [...matchesBlank.map((x) => ({ ...x, why: "blank-row" })), ...absent.map((x) => ({ ...x, why: "absent" }))];

  console.log(`\n=== FAIR PNL STEP 3 EMPTY-DELETE — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`scope 2024-01-01..2026-06-30. projects in scope: ${projects.length}, completely-empty (0 lines): ${empties.length}`);
  console.log(`  spared by photo/doc guard (empty of finance but HAS photos/docs): ${withContent.length}`);
  console.log(`  bare empties (0 lines, 0 photos, 0 docs): ${bare.length}`);
  console.log(`    -> match a sales>0 Excel event (LEAVE, real event missing fill): ${hasSalesMatch.length}`);
  console.log(`    -> match a BLANK Excel row (delete: stray booth):                 ${matchesBlank.length}`);
  console.log(`    -> ABSENT, no same-brand event near date (delete: not real):      ${absent.length}`);
  console.log(`    -> DATE mismatch, same brand+venue exists other date (REVIEW):    ${dateMiss.length}`);
  console.log(`    -> VENUE mismatch, same brand near date other venue (REVIEW):     ${venueMiss.length}`);

  const dump = (label, arr, extra) => {
    console.log(`\n[${label}: ${arr.length}]`);
    for (const { p, e } of arr.slice(0, 40)) console.log(`   p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue}  by=${p.created_by}${extra && e ? `   <- Excel ${e.start} @ ${canonVenue(e.venue)} sales=${toRm(e.sales).toLocaleString()}` : ""}`);
    if (arr.length > 40) console.log(`   ... +${arr.length - 40} more`);
  };
  dump("DELETE bucket (a) blank-row strays", matchesBlank, true);
  dump("DELETE bucket (b) absent (no same-brand event near date)", absent, false);
  dump("REVIEW date-mismatch (NOT deleted)", dateMiss, true);
  dump("REVIEW venue-mismatch (NOT deleted)", venueMiss, true);
  if (withContent.length) dump("SPARED by photo/doc guard (NOT deleted)", withContent.map((p) => ({ p })), false);

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will DELETE ${deletable.length} completely-empty project(s) [blank-row + absent]. Review buckets untouched.`); process.exit(0); }
  if (!deletable.length) { console.log(`\nnothing to delete.`); process.exit(0); }
  const ids = deletable.map((d) => d.p.id);
  await sql`DELETE FROM project_finance_lines WHERE project_id = ANY(${ids})`; // defensive: these have none
  await sql`DELETE FROM projects WHERE id = ANY(${ids})`;
  console.log(`\nCOMMIT done: deleted ${ids.length} completely-empty project(s). Review + photo/doc-guarded projects untouched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

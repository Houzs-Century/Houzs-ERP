// READ-ONLY reconciliation audit. Owner rework 2026-07-26: the seed should have FILLED the
// owner's existing projects, not created a parallel set. This matches each Excel event
// (seed_data_final.json) to an owner project (created_by<>0) by brand + venue + date window,
// and reports: which owner projects to FILL (empty), which already have data, which events
// have NO owner match (create new), and which seed projects (created_by=0) to remove.
// Writes NOTHING. Scope: 2025 + 2026-before-May (2024 pending build_2024.py).
import postgres from "postgres";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const STATE_TAIL = /\b(KL|PG|PNG|JB|JHB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
const ABBR = [[/\bTMN\b/gi, "TAMAN"], [/\bBKT\b/gi, "BUKIT"], [/\bBUKTI\b/gi, "BUKIT"], [/\bMILLENIUM\b/gi, "MILLENNIUM"]];
const expandAbbr = (s) => { let v = String(s ?? ""); for (const [re, to] of ABBR) v = v.replace(re, to); return v; };
const venueNorm = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
// canonVenue (seed keyword rules) -> old maintained name
function canonVenueOld(raw) {
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
// 统称 renames/merges already applied to prod (old name -> current name)
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
// Keyword renames applied to the RAW string first (catches "MITC MELAKA" -> "MELAKA
// INTERNATIONAL TRADE CENTRE" that canonVenueOld+RENAME miss because canonVenueOld has no
// MITC rule and RENAME is keyed on the old exact name).
const KWRENAME = [
  [/\bMITEC\b/, "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE"],
  [/\bMITC\b/, "MELAKA INTERNATIONAL TRADE CENTRE"],
  [/\bKLCC\b/, "KUALA LUMPUR CONVENTION CENTRE"],
  [/\bPWCC\b/, "PENANG WATERFRONT CONVENTION CENTRE"],
  [/\bSPCC\b|SUNWAY\s*PYRAMID/, "SUNWAY PYRAMID CONVENTION CENTRE"],
  [/\bSCCC\b|SETIA\s*CITY/, "SETIA CITY CONVENTION CENTRE"],
  [/\bBCCK\b/, "BORNEO CONVENTION CENTRE KUCHING"],
  [/\bSICC\b/, "SABAH INTERNATIONAL CONVENTION CENTRE"],
  [/\bITCC\b/, "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE"],
  [/\bAICC\b/, "AUSTIN INTERNATIONAL CONVENTION CENTRE"],
  [/\bPICCA\b/, "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE"],
];
const canonVenue = (raw) => {
  const u = " " + String(raw ?? "").toUpperCase() + " ";
  for (const [re, name] of KWRENAME) if (re.test(u)) return name;
  const old = canonVenueOld(raw);
  return RENAME[old] ?? old;
};
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-05-01");
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.created_by,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) nlines,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL),0) income
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL GROUP BY p.id`;
  const seedProjs = projects.filter((p) => Number(p.created_by) === 0);
  const ownerProjs = projects.filter((p) => Number(p.created_by) !== 0);
  const idx = new Map();
  for (const p of ownerProjs) { const k = `${norm(p.brand)}|${venueNorm(p.venue)}`; (idx.get(k) || idx.set(k, []).get(k)).push(p); }

  const idxBrand = new Map();
  for (const p of ownerProjs) { const b = norm(p.brand); (idxBrand.get(b) || idxBrand.set(b, []).get(b)).push(p); }

  let fillEmpty = 0, hasData = 0;
  const dateMiss = [], venueMiss = [], absent = [];
  for (const r of rows) {
    const vk = venueNorm(canonVenue(r.venue));
    const sameBV = idx.get(`${norm(r.brand)}|${vk}`) || [];
    const cands = sameBV.filter((p) => days(p.start_date, r.start) <= 10);
    if (cands.length) { Number(cands[0].income) > 0 ? hasData++ : fillEmpty++; continue; }
    if (sameBV.length) { dateMiss.push([r, sameBV[0]]); continue; }               // same brand+venue, date > 10d off
    const near = (idxBrand.get(norm(r.brand)) || []).filter((p) => days(p.start_date, r.start) <= 10);
    if (near.length) { venueMiss.push([r, near[0]]); continue; }                   // same brand+date, venue differs
    absent.push(r);                                                                // no owner project at all
  }

  console.log(`\n=== FAIR PNL RECONCILE AUDIT (read-only) — scope 2024..2026-04 ===`);
  console.log(`Excel events in scope: ${rows.length}`);
  console.log(`  match owner project WITH data (leave):   ${hasData}`);
  console.log(`  match owner project EMPTY (fill):        ${fillEmpty}`);
  console.log(`  NO-MATCH -> DATE mismatch (same brand+venue exists, date off):  ${dateMiss.length}`);
  console.log(`  NO-MATCH -> VENUE mismatch (same brand+date exists, venue differs): ${venueMiss.length}`);
  console.log(`  NO-MATCH -> ABSENT (no owner project same brand near date):     ${absent.length}`);
  console.log(`\nowner projects: ${ownerProjs.length}  (empty: ${ownerProjs.filter((p) => Number(p.income) === 0).length})   seed to remove: ${seedProjs.length}`);

  const show = (label, arr) => {
    console.log(`\n[${label} — sample ${Math.min(12, arr.length)}/${arr.length}]`);
    for (const [r, o] of arr.slice(0, 12)) console.log(`   Excel ${r.start} [${r.brand}] @ ${canonVenue(r.venue)}   <->   owner p${o.id} ${o.start_date} @ ${o.venue}`);
  };
  show("DATE mismatch", dateMiss);
  show("VENUE mismatch", venueMiss);
  console.log(`\n[ABSENT — sample ${Math.min(12, absent.length)}/${absent.length}]`);
  for (const r of absent.slice(0, 12)) console.log(`   ${r.start} [${r.brand}] ${r.organizer || "SOLO"} @ ${canonVenue(r.venue)} (raw "${r.venue}")`);

  // ===================================================================================
  // EMPTY-OWNER-CENTRIC FILL MAP (task 2026-07-27). Iterate the owner's EMPTY projects
  // (created_by<>0 AND zero non-archived finance lines = nlines===0) and find which
  // in-scope Excel event each should be FILLED from. canonVenue is applied to BOTH sides
  // here (owner venue too) so abbreviated owner spellings match the canonical Excel venue.
  // READ-ONLY: no writes, no commit mode. Reports (a) fillable, (b) excel-absent, (c)
  // empty-with-no-excel-match, at date windows <=4d and <=10d for sensitivity.
  // ===================================================================================
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const keyCanon = (brand, venue) => `${norm(brand)}|${venueNorm(canonVenue(venue))}`;
  const keyPlain = (brand, venue) => `${norm(brand)}|${venueNorm(venue)}`; // owner venue as-stored (no canon)

  const emptyOwner = ownerProjs.filter((p) => Number(p.nlines) === 0);
  const emptyByIncome = ownerProjs.filter((p) => Number(p.income) === 0);

  // Excel events indexed by canonical brand+venue (rows already scoped 2024-01..2026-04).
  const excelIdx = new Map();
  for (const r of rows) { const k = keyCanon(r.brand, r.venue); (excelIdx.get(k) || excelIdx.set(k, []).get(k)).push(r); }
  const idxBrandExcel = new Map();
  for (const r of rows) { const b = norm(r.brand); (idxBrandExcel.get(b) || idxBrandExcel.set(b, []).get(b)).push(r); }
  // ALL owner projects indexed by canonical brand+venue (for "excel event has no owner project at all").
  const ownerCanonIdx = new Map();
  for (const p of ownerProjs) { const k = keyCanon(p.brand, p.venue); (ownerCanonIdx.get(k) || ownerCanonIdx.set(k, []).get(k)).push(p); }

  const closestExcel = (o, cands) => cands.slice().sort((a, b) => days(o.start_date, a.start) - days(o.start_date, b.start))[0];

  // ownerKeyFn lets us A/B the venue normalization: plain owner venue vs canonVenue'd owner venue.
  function analyze(win, ownerKeyFn) {
    const fillable = [], emptyNoMatch = [];
    for (const o of emptyOwner) {
      const cands = (excelIdx.get(ownerKeyFn(o.brand, o.venue)) || []).filter((r) => days(o.start_date, r.start) <= win);
      if (cands.length) fillable.push([o, closestExcel(o, cands)]); else emptyNoMatch.push(o);
    }
    let absentExcel = 0;
    for (const r of rows) {
      const cands = (ownerCanonIdx.get(keyCanon(r.brand, r.venue)) || []).filter((p) => days(p.start_date, r.start) <= win);
      if (!cands.length) absentExcel++;
    }
    return { fillable, emptyNoMatch, absentExcel };
  }

  console.log(`\n\n=== EMPTY-OWNER FILL MAP (read-only; canonVenue on BOTH sides) ===`);
  console.log(`owner projects: ${ownerProjs.length}   EMPTY (0 non-archived lines): ${emptyOwner.length}   (empty-by-income for continuity: ${emptyByIncome.length})`);
  console.log(`in-scope Excel events (2024-01-01..2026-04-30): ${rows.length}`);
  const emptyFuture = emptyOwner.filter((p) => ymd(p.start_date) >= "2026-05-01").length;
  console.log(`EMPTY owner projects by start_date:  in-scope (<2026-05-01): ${emptyOwner.length - emptyFuture}   future (>=2026-05-01): ${emptyFuture}`);

  console.log(`\n-- sensitivity matrix --`);
  console.log(`  window | owner-venue | fillable | empty-no-excel-match | excel-absent(no owner proj)`);
  for (const win of [4, 10]) {
    for (const [mode, fn] of [["plain", keyPlain], ["canon", keyCanon]]) {
      const a = analyze(win, fn);
      console.log(`  <=${String(win).padEnd(2)}d | ${mode.padEnd(5)}       | ${String(a.fillable.length).padStart(6)} | ${String(a.emptyNoMatch.length).padStart(20)} | ${String(a.absentExcel).padStart(4)}`);
    }
  }

  // Detailed mapping using the STRONG matcher (canonVenue both sides).
  const a4 = analyze(4, keyCanon), a10 = analyze(10, keyCanon);
  const distinctExcel = (arr) => new Set(arr.map(([, r]) => `${r.start}|${keyCanon(r.brand, r.venue)}`)).size;
  console.log(`\nfillable empty-owner projects: <=4d ${a4.fillable.length} (distinct Excel events ${distinctExcel(a4.fillable)})   <=10d ${a10.fillable.length} (distinct Excel events ${distinctExcel(a10.fillable)})`);

  const within4Ids = new Set(a4.fillable.map(([o]) => o.id));
  console.log(`\n[FILLABLE sample — <=10d window; (*)=also within 4d]`);
  console.log(`   owner_id  owner_date @ owner_venue  <->  excel_date [brand] @ canon_venue  sales=RM  (deltaDays)`);
  for (const [o, r] of a10.fillable.slice(0, 20)) {
    const star = within4Ids.has(o.id) ? "*" : " ";
    console.log(` ${star} p${o.id}  ${ymd(o.start_date)} @ ${o.venue}  <->  ${r.start} [${r.brand}] @ ${canonVenue(r.venue)}  sales=${Math.round(Number(r.sales))}  (${Math.round(days(o.start_date, r.start))}d)`);
  }

  // EMPTY owner projects with NO Excel match (canon, 10d): future placeholders vs in-scope matcher-gap suspects.
  const noMatch = a10.emptyNoMatch;
  const nmFuture = noMatch.filter((p) => ymd(p.start_date) >= "2026-05-01");
  const nmInScope = noMatch.filter((p) => ymd(p.start_date) < "2026-05-01");
  console.log(`\n[EMPTY, NO Excel match (canon,10d): ${noMatch.length}]  future(>=2026-05): ${nmFuture.length}   in-scope(<2026-05): ${nmInScope.length}`);
  console.log(`  -- in-scope no-match (matcher-gap suspects; nearest same-brand Excel, any venue/date) sample --`);
  for (const p of nmInScope.slice(0, 15)) {
    const sb = idxBrandExcel.get(norm(p.brand)) || [];
    let near = null, bd = Infinity;
    for (const r of sb) { const d = days(p.start_date, r.start); if (d < bd) { bd = d; near = r; } }
    const diag = near
      ? `nearest Excel ${near.start} @ ${canonVenue(near.venue)} (${Math.round(bd)}d; vNorm owner="${venueNorm(canonVenue(p.venue))}" excel="${venueNorm(canonVenue(near.venue))}")`
      : `(no same-brand Excel at all)`;
    console.log(`   p${p.id} ${ymd(p.start_date)} [${p.brand}] @ ${p.venue}  ${diag}`);
  }
  console.log(`  -- future no-match (>=2026-05, expected placeholders) sample --`);
  for (const p of nmFuture.slice(0, 8)) console.log(`   p${p.id} ${ymd(p.start_date)} [${p.brand}] @ ${p.venue}`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

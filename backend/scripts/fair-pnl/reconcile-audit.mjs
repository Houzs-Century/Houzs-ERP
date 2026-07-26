// READ-ONLY comprehensive reconcile audit (owner polish 2026-07-27). Answers three questions
// in one run so nothing is deleted on a guess:
//  (0) SAFETY  — orphaned photos/attachments: rows whose project no longer exists = an earlier
//      delete removed a project that HAD files. Empty on both = no delete touched any file.
//  (1) DUPLICATES — one Excel event matched by >1 LIVE PMS project (incl. data-carrying
//      venue-spelling pairs dedup could not merge). Shows income + photo + attachment counts per
//      project, and the extra COUNT + extra REVENUE cleaning them would remove.
//  (2) FILE-SAFETY — every zero-income in-scope project with its photo/attachment counts, so any
//      future delete is proven to touch no files first.
// Plus unmatched projects. Writes NOTHING. Scope 2024-01-01 .. 2026-07-01 (through June).
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
const bnorm = (b) => { const n = norm(b); return n === "AKEMICC" ? "AKEMI" : n; }; // AKEMI C&C == AKEMI
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const rm = (n) => Number(n || 0).toLocaleString();

async function main() {
  // ---- (0) SAFETY: orphaned files (a deleted project that HAD photos / legacy attachments) ----
  const orphanPhotos = await sql`SELECT project_id, COUNT(*)::int n FROM project_phase_photos WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects) GROUP BY project_id ORDER BY project_id`;
  const orphanAtt = await sql`SELECT project_id, COUNT(*)::int n FROM project_attachments WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects) GROUP BY project_id ORDER BY project_id`;
  console.log(`\n=== (0) SAFETY — did any earlier delete remove a project that HAD files? ===`);
  console.log(`  orphaned project_phase_photos: ${orphanPhotos.length} project(s) -> ${JSON.stringify(orphanPhotos.map((r) => `p${r.project_id}:${r.n}`))}`);
  console.log(`  orphaned project_attachments : ${orphanAtt.length} project(s) -> ${JSON.stringify(orphanAtt.map((r) => `p${r.project_id}:${r.n}`))}`);
  console.log(`  VERDICT: ${orphanPhotos.length === 0 && orphanAtt.length === 0 ? "SAFE — no deleted project had any file." : "REVIEW — a deleted project id above still has orphaned files (recoverable from R2)."}`);

  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name, p.created_by,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) nlines,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL),0) income,
           (SELECT COUNT(*)::int FROM project_phase_photos ph WHERE ph.project_id = p.id) nphotos,
           (SELECT COUNT(*)::int FROM project_attachments a WHERE a.project_id = p.id) nattach
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;

  // ---- (1) DUPLICATES: one Excel event matched by >1 live PMS project ----
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const eidx = new Map();
  for (const e of events) { const k = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (eidx.get(k) || eidx.set(k, []).get(k)).push(e); }

  const evToProj = new Map(); const unmatched = [];
  for (const p of projects) {
    const cands = (eidx.get(`${bnorm(p.brand)}|${venueNorm(canonVenue(p.venue))}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (!cands.length) { unmatched.push(p); continue; }
    const e = cands.sort((a, b) => days(a.start, p.start_date) - days(b.start, p.start_date))[0];
    const ek = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}|${e.start}`;
    (evToProj.get(ek) || evToProj.set(ek, { e, ps: [] }).get(ek)).ps.push(p);
  }
  const dupGroups = [...evToProj.values()].filter((g) => g.ps.length > 1);
  let extraCount = 0, extraRevenue = 0;
  for (const g of dupGroups) {
    extraCount += g.ps.length - 1;
    const sorted = [...g.ps].sort((a, b) => Number(b.income) - Number(a.income));
    for (const p of sorted.slice(1)) extraRevenue += Number(p.income); // all but the richest = removable
  }

  console.log(`\n=== (1) DUPLICATES — one Excel event, >1 live PMS project ===`);
  console.log(`PMS in-scope: ${projects.length}   Excel events: ${events.length}   raw gap: ${projects.length - events.length}`);
  console.log(`duplicate-event groups: ${dupGroups.length}  ->  EXTRA projects: ${extraCount}   EXTRA revenue if trimmed to richest: RM ${rm(extraRevenue)}`);
  for (const g of dupGroups.sort((a, b) => String(a.e.start).localeCompare(String(b.e.start)))) {
    console.log(`\n  Excel ${g.e.start} [${g.e.brand}] @ ${canonVenue(g.e.venue)}  (sales=${rm(g.e.sales)})`);
    for (const p of g.ps.sort((a, b) => Number(b.income) - Number(a.income)))
      console.log(`     p${p.id} ${p.start_date} by${p.created_by}  inc=${rm(p.income)}  lines=${p.nlines}  photos=${p.nphotos}  attach=${p.nattach}  venue="${p.venue}"`);
  }

  // ---- (2) FILE-SAFETY: zero-income projects and whether they hold any file ----
  const empties = projects.filter((p) => Number(p.income) === 0);
  const emptyWithFiles = empties.filter((p) => p.nphotos > 0 || p.nattach > 0);
  console.log(`\n=== (2) FILE-SAFETY — zero-income in-scope projects: ${empties.length} (with files: ${emptyWithFiles.length}) ===`);
  for (const p of empties.sort((a, b) => (b.nphotos + b.nattach) - (a.nphotos + a.nattach) || String(a.start_date).localeCompare(String(b.start_date))))
    console.log(`   p${p.id} ${p.start_date} [${p.brand}] by${p.created_by}  photos=${p.nphotos}  attach=${p.nattach}  lines=${p.nlines}  @ ${p.venue}`);

  // ---- (3) maintained pickers + cost rates + data hygiene ----
  const rates = await sql`SELECT brand, transport_pct, merchandise_pct, commission_normal_pct, commission_boost_pct, boost_min_gp_pct, boost_min_sales FROM project_cost_rates ORDER BY brand`;
  const brandRows = await sql`SELECT name FROM project_brands ORDER BY name`;
  const venueRows = await sql`SELECT name FROM project_venues ORDER BY name`;
  const brandSet = new Set(brandRows.map((r) => norm(r.name)));
  const rateSet = new Set(rates.map((r) => norm(r.brand)));
  const venueSet = new Set(venueRows.map((r) => venueNorm(r.name)));
  const projBrands = [...new Set(projects.map((p) => p.brand))].sort();
  console.log(`\n=== (3) PICKERS + COST RATES + hygiene ===`);
  console.log(`  project_cost_rates (${rates.length}):`);
  for (const r of rates) console.log(`     ${r.brand}: T${r.transport_pct} M${r.merchandise_pct} C${r.commission_normal_pct}${r.commission_boost_pct != null ? `/boost${r.commission_boost_pct}@gp${r.boost_min_gp_pct ?? "-"}&sales${r.boost_min_sales ?? "-"}` : ""}`);
  console.log(`  project_brands picker (${brandRows.length}): ${JSON.stringify(brandRows.map((r) => r.name))}`);
  console.log(`  brands used by projects but NOT in brand picker: ${JSON.stringify(projBrands.filter((b) => !brandSet.has(norm(b))))}`);
  console.log(`  brands used by projects but NOT in cost_rates:   ${JSON.stringify(projBrands.filter((b) => !rateSet.has(norm(b)) && !rateSet.has(bnorm(b))))}`);
  const projVenueMiss = [...new Set(projects.filter((p) => !venueSet.has(venueNorm(canonVenue(p.venue)))).map((p) => `${p.venue}  =>  ${canonVenue(p.venue)}`))].sort();
  console.log(`  project_venues picker: ${venueRows.length} venues. Project venues NOT matching any picker venue (after canon): ${projVenueMiss.length}`);
  for (const v of projVenueMiss.slice(0, 50)) console.log(`     ${v}`);
  const badDates = projects.filter((p) => isNaN(Date.parse(p.start_date)) || Number(String(p.start_date).slice(5, 7)) > 12 || Number(String(p.start_date).slice(8, 10)) > 31);
  console.log(`  CORRUPT start_date: ${badDates.length} -> ${JSON.stringify(badDates.map((p) => `p${p.id}:${p.start_date}`))}`);

  // ---- unmatched (in PMS, no Excel event) ----
  console.log(`\n=== UNMATCHED — live PMS project with no Excel event (${unmatched.length}) ===`);
  for (const p of unmatched.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))))
    console.log(`   p${p.id} ${p.start_date} [${p.brand}] by${p.created_by} inc=${rm(p.income)} photos=${p.nphotos} attach=${p.nattach}  @ ${p.venue} => ${canonVenue(p.venue)}`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

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
const canonVenue = (raw) => { const old = canonVenueOld(raw); return RENAME[old] ?? old; };
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

  let fillEmpty = 0, hasData = 0; const noMatch = [];
  for (const r of rows) {
    const k = `${norm(r.brand)}|${venueNorm(canonVenue(r.venue))}`;
    const cands = (idx.get(k) || []).filter((p) => days(p.start_date, r.start) <= 10);
    if (cands.length) { if (Number(cands[0].income) > 0) hasData++; else fillEmpty++; }
    else noMatch.push(r);
  }

  console.log(`\n=== FAIR PNL RECONCILE AUDIT (read-only) — scope 2024..2026-04 ===`);
  console.log(`Excel events in scope: ${rows.length}`);
  console.log(`  -> match an OWNER project WITH data (verify):       ${hasData}`);
  console.log(`  -> match an OWNER project that is EMPTY (fill):     ${fillEmpty}`);
  console.log(`  -> NO owner match (create new / correct):           ${noMatch.length}`);
  console.log(`\nowner projects: ${ownerProjs.length}  (empty: ${ownerProjs.filter((p) => Number(p.income) === 0).length})`);
  console.log(`seed projects (created_by=0, to remove in rework):   ${seedProjs.length}`);
  console.log(`\n[sample of NO-MATCH events — need new project or a venue/date fix]`);
  for (const r of noMatch.slice(0, 25)) console.log(`   ${r.start}  [${r.brand}]  ${r.organizer || "SOLO"} @ ${canonVenue(r.venue)}  (raw "${r.venue}")`);
  if (noMatch.length > 25) console.log(`   ... +${noMatch.length - 25} more`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

// STEP 5 DEDUP (owner spec, read-only by default). Within the SAME calendar week (Mon-Sun),
// find groups of non-archived projects that share the SAME brand + SAME normalized venue and
// have MORE THAN ONE project. In a group, a project "carries data" if it has an income finance
// line (> 0); a project is "empty" if it has ZERO non-archived finance lines. When a group has
// EXACTLY ONE data-carrier and every other member is TOTALLY EMPTY, those empty members are
// duplicates of the real one -> delete them (keep the one with sales). Any other shape
// (two+ data-carriers, all empty, or a sibling that has finance lines but no income) is
// AMBIGUOUS -> listed for owner review, never auto-deleted. Scope 2024-01-01..2026-06-30;
// projects on/after 2026-07-01 are never considered. Dry-run (default) lists everything;
// --commit deletes only the unambiguous empty duplicates (and their zero lines).
import postgres from "postgres";
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
// canonVenue: map a raw/abbreviated venue to its current maintained (post-统称) full name so
// two spellings of the same hall group together. Same rules as reconcile-audit.mjs.
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
const vkey = (v) => venueNorm(canonVenue(v));
// Monday (UTC) of the date's Mon-Sun week, as YYYY-MM-DD -> the calendar-week key.
const weekKey = (d) => {
  const dt = new Date(String(d) + "T00:00:00Z");
  if (Number.isNaN(dt.getTime())) return "invalid:" + d;
  const dow = (dt.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
};

async function main() {
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name, p.created_by,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) AS nlines,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL), 0) AS income
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL
      AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;

  // group by brand | venueNorm | week
  const groups = new Map();
  for (const p of projects) {
    const k = `${norm(p.brand)}|${vkey(p.venue)}|${weekKey(p.start_date)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(p);
  }

  const toDelete = []; // empty duplicates of a single data-carrier
  const review = [];   // ambiguous groups for owner
  for (const [k, members] of groups) {
    if (members.length < 2) continue;
    const carriers = members.filter((p) => Number(p.income) > 0);
    const empty = members.filter((p) => Number(p.nlines) === 0);
    const costOnly = members.filter((p) => Number(p.nlines) > 0 && Number(p.income) <= 0);
    const clean = carriers.length === 1 && empty.length === members.length - 1 && costOnly.length === 0;
    if (clean) { for (const p of empty) toDelete.push({ p, keep: carriers[0], k }); }
    else review.push({ k, members, carriers: carriers.length, empty: empty.length, costOnly: costOnly.length });
  }

  console.log(`\n=== FAIR PNL STEP 5 DEDUP — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`scope: non-archived projects 2024-01-01..2026-06-30`);
  console.log(`multi-project same brand+venue+week groups: ${[...groups.values()].filter((m) => m.length > 1).length}`);
  console.log(`\n[UNAMBIGUOUS empty duplicates to DELETE: ${toDelete.length}] (one data-carrier kept, empty shells removed)`);
  for (const { p, keep } of toDelete.sort((a, b) => String(a.p.start_date).localeCompare(String(b.p.start_date)))) {
    console.log(`   DEL p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue}  created_by=${p.created_by}  (0 lines)`);
    console.log(`     keep p${keep.id} ${keep.start_date} @ ${keep.venue}  income=${Number(keep.income).toLocaleString()}`);
  }
  console.log(`\n[AMBIGUOUS groups for OWNER REVIEW (never auto-deleted): ${review.length}]`);
  for (const g of review.sort((a, b) => a.k.localeCompare(b.k))) {
    const reason = g.carriers >= 2 ? "TWO+ data-carriers" : g.empty === g.members.length ? "ALL empty" : g.costOnly > 0 ? "sibling has cost lines but no income" : "mixed";
    console.log(`   [${reason}]  ${g.members.length} projects: ${g.members.map((p) => `p${p.id}(${p.start_date},lines=${p.nlines},inc=${Number(p.income).toLocaleString()},by=${p.created_by})`).join("  ")}`);
    console.log(`      brand=${g.members[0].brand}  venue=${g.members[0].venue}`);
  }

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will DELETE ${toDelete.length} empty duplicate project(s). Ambiguous groups untouched.`); process.exit(0); }
  if (!toDelete.length) { console.log(`\nnothing to delete.`); process.exit(0); }
  const ids = toDelete.map((d) => d.p.id);
  await sql`DELETE FROM project_finance_lines WHERE project_id = ANY(${ids})`; // defensive: empties have none
  await sql`DELETE FROM projects WHERE id = ANY(${ids})`;
  console.log(`\nCOMMIT done: deleted ${ids.length} empty duplicate project(s). Data-carriers + ambiguous groups untouched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

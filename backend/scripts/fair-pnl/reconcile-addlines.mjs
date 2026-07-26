// FILL owner projects that are missing their sales line, from the Excel P&L. Scope-matched
// (owner rework 2026-07-26): for each owner project (created_by<>0) that has NO income line,
// match a same-brand + same-venue + within-10-day Excel event and ADD only the finance-line
// categories the project is MISSING (income/sales, cogs_matt_sofa/bedframe/accessories, rental,
// setup). Existing owner lines are never touched or duplicated. Amounts are WHOLE RM (the
// column unit — the ×100 bug is fixed). Dry-run (default) lists every add; --commit inserts.
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
// canonVenue: map Excel raw venue -> the current (post-统称) maintained name so it matches owner venues.
const KWRENAME = [
  [/\bMITEC\b/, "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE"], [/\bMITC\b/, "MELAKA INTERNATIONAL TRADE CENTRE"],
  [/\bKLCC\b/, "KUALA LUMPUR CONVENTION CENTRE"], [/\bPWCC\b/, "PENANG WATERFRONT CONVENTION CENTRE"],
  [/\bSPCC\b|SUNWAY\s*PYRAMID/, "SUNWAY PYRAMID CONVENTION CENTRE"], [/\bSCCC\b|SETIA\s*CITY/, "SETIA CITY CONVENTION CENTRE"],
  [/\bBCCK\b/, "BORNEO CONVENTION CENTRE KUCHING"], [/\bSICC\b/, "SABAH INTERNATIONAL CONVENTION CENTRE"],
  [/\bITCC\b/, "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE"], [/\bAICC\b/, "AUSTIN INTERNATIONAL CONVENTION CENTRE"],
  [/\bPICCA\b/, "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE"],
];
function canonOld(raw) {
  const u = norm(raw);
  if (u.includes("SOUTHKEY")) return "MVEC SOUTHKEY";
  if (u.includes("MVEC") || u.includes("MIDVALLEY")) return "MID VALLEY";
  if (u.includes("PAVILION") || u.includes("PAVILLION")) return "PAVILION BUKIT JALIL";
  if (u.includes("STADIUM") && u.includes("JALIL")) return "STADIUM BUKIT JALIL";
  if (u.includes("STARLING")) return "THE STARLING MALL";
  if (u.includes("SSCC") || u.includes("SETIASPICE")) return "SETIA SPICE CONVENTION CENTRE";
  if (u.includes("SPICEARENA") || u.includes("PISA")) return "PISA SPICE ARENA CONVENTION CENTRE";
  if (u.includes("IOICITYMALL")) return "IOI MALL PUTRAJAYA";
  if (u.includes("IOIDAMANSARA")) return "IOI MALL DAMANSARA";
  if (u.includes("TERBAU") || u.includes("TEBRAU")) return "AEON TEBRAU CITY";
  if (u.includes("PERSADA")) return "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE";
  if (u.includes("VIVACITY")) return "VIVACITY MEGAMALL";
  if (u.includes("ALMA") && u.includes("MERTAJAM")) return "AEON BUKIT MERTAJAM";
  if (u.includes("AEONCHERAS") && !u.includes("SELATAN")) return "AEON TAMAN MALURI";
  if (u.includes("METROCITY") || (u.includes("MCC") && u.includes("KUCHING"))) return "KUCHING METROCITY CONVENTION CENTRE";
  if ((u.includes("INDERAMULIA") || u.includes("ENDERAMULIA")) || (u.includes("STADIUM") && u.includes("IPOH"))) return "STADIUM INDERA MULIA IPOH";
  return raw;
}
const canonVenue = (raw) => { const u = " " + String(raw ?? "").toUpperCase() + " "; for (const [re, n] of KWRENAME) if (re.test(u)) return n; return canonOld(raw); };
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const toRm = (v) => Math.round(Number(v || 0));

// Excel field -> (kind, category)
const LINES = [
  ["income", "sales", "sales"], ["cost", "cogs_matt_sofa", "cogs_m"], ["cost", "cogs_bedframe", "cogs_b"],
  ["cost", "cogs_accessories", "cogs_a"], ["cost", "rental", "rental"], ["cost", "setup", "setup"],
];

async function main() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-05-01");
  const houzs = await sql`SELECT id FROM companies WHERE code='HOUZS' LIMIT 1`;
  const companyId = houzs[0]?.id ?? null;
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name,
           COALESCE(ARRAY_AGG(l.category) FILTER (WHERE l.archived_at IS NULL), '{}') cats,
           BOOL_OR(l.kind = 'income' AND l.archived_at IS NULL) has_income
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.created_by <> 0
    GROUP BY p.id`;
  // index Excel events by brand|venueNorm(canon)
  const idx = new Map();
  for (const e of events) { const k = `${norm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (idx.get(k) || idx.set(k, []).get(k)).push(e); }

  const plan = []; // {p, e, adds:[{kind,cat,amt}]}
  for (const p of projects) {
    if (p.has_income) continue; // only projects missing their sales line
    const cands = (idx.get(`${norm(p.brand)}|${venueNorm(p.venue)}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (!cands.length) continue;
    const e = cands.sort((a, b) => days(a.start, p.start_date) - days(b.start, p.start_date))[0];
    const have = new Set((p.cats || []).map((c) => String(c)));
    const adds = LINES
      .map(([kind, cat, f]) => ({ kind, cat, amt: toRm(e[f]) }))
      .filter((x) => x.amt > 0 && !have.has(x.cat));
    if (adds.length) plan.push({ p, e, adds });
  }

  console.log(`\n=== FAIR PNL ADD-LINES (fill missing sales/COGS) — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`owner projects missing a sales line that match an in-scope Excel event: ${plan.length}`);
  let totalLines = 0;
  for (const { p, e, adds } of plan.sort((a, b) => String(a.p.start_date).localeCompare(String(b.p.start_date)))) {
    totalLines += adds.length;
    console.log(`\n  p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue}`);
    console.log(`     from Excel ${e.start} (${days(e.start, p.start_date)}d)  add: ${adds.map((a) => `${a.cat}=${a.amt.toLocaleString()}`).join(", ")}`);
  }
  console.log(`\ntotal lines to add: ${totalLines} across ${plan.length} project(s). Existing owner lines untouched.`);
  if (!plan.length) { process.exit(0); }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will INSERT ${totalLines} finance line(s).`); process.exit(0); }

  let ins = 0;
  for (const { p, adds } of plan) {
    for (const a of adds) {
      await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id)
                VALUES (${p.id}, ${a.kind}, ${a.cat}, ${a.cat + " (FAIR PNL fill)"}, ${a.amt}, ${p.start_date}, ${companyId})`;
      ins++;
    }
  }
  console.log(`\nCOMMIT done: inserted ${ins} finance line(s) into ${plan.length} owner project(s). No existing line touched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

// FILL MISSING CATEGORIES (owner 2026-07-27: system COGS was ~29% of revenue, should be
// ~48-50% -- many projects have a sales line but are missing their COGS/rental/setup). Like
// reconcile-addlines.mjs but WITHOUT the "no income" restriction: for EVERY in-scope project
// (2024-01-01..2026-06-30) that matches an Excel event (same brand + venueNorm(canonVenue) +
// within 10 days), ADD only the finance-line categories the project is MISSING, where the Excel
// amount > 0. Categories: income/sales, cogs_matt_sofa, cogs_bedframe, cogs_accessories, rental,
// setup. Amounts are WHOLE RM.
//
// Money-data safety (never double-count):
//   - income/sales added only if the project has NO income-kind line at all (guards against a
//     second income line under a different category).
//   - COGS sub-categories added only if the project has NO legacy 'cogs' aggregate line, and only
//     for the exact sub-category names it lacks (the app's COGS bucket is
//     cogs|cogs_matt_sofa|cogs_bedframe|cogs_accessories -- adding a sub-cat on top of a legacy
//     'cogs' would double-count).
//   - rental / setup added only if that exact category is absent.
//   - ONE Excel event fills at most ONE project: if several projects match the same event row, only
//     the primary (data-carrier first, then nearest date, then lowest id) is filled; the rest are
//     reported as overlapping duplicates and left for review (prevents one booth's P&L landing on
//     two projects).
//   - Never touches an existing line; never touches projects on/after 2026-07-01.
// Dry-run (default) prints per-category totals + current vs projected COGS%; --commit inserts.
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
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const COGS_SUB = [["cogs_matt_sofa", "cogs_m"], ["cogs_bedframe", "cogs_b"], ["cogs_accessories", "cogs_a"]];
const COGS_BUCKET = ["cogs", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories"];

async function main() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8"))
    .map((r, i) => ({ ...r, _i: i }))
    .filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const houzs = await sql`SELECT id FROM companies WHERE code='HOUZS' LIMIT 1`;
  const companyId = houzs[0]?.id ?? null;
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name,
           BOOL_OR(l.kind = 'income' AND l.archived_at IS NULL) AS has_income,
           COALESCE(ARRAY_AGG(l.category) FILTER (WHERE l.kind='cost' AND l.archived_at IS NULL AND l.category IS NOT NULL), '{}') AS cost_cats,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL), 0) AS income_sum,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='cost' AND l.archived_at IS NULL AND l.category IN ('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')), 0) AS cogs_sum
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;

  const idx = new Map();
  for (const e of events) { const k = `${norm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (idx.get(k) || idx.set(k, []).get(k)).push(e); }

  // Each project -> its nearest matching event; then one primary project per event.
  const matched = [];
  for (const p of projects) {
    const cands = (idx.get(`${norm(p.brand)}|${venueNorm(p.venue)}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (!cands.length) continue;
    const e = cands.sort((a, b) => days(a.start, p.start_date) - days(b.start, p.start_date))[0];
    matched.push({ p, e, d: days(e.start, p.start_date) });
  }
  const byEvent = new Map();
  for (const m of matched) (byEvent.get(m.e._i) || byEvent.set(m.e._i, []).get(m.e._i)).push(m);

  const plan = [];              // {p, e, adds}
  const overlapDup = [];        // {p, e, primaryId} - project sharing an event with the chosen primary
  let cogsSkippedLegacy = 0;    // projects with a legacy 'cogs' line (sub-cats not added)
  for (const [, ms] of byEvent) {
    ms.sort((a, b) => (Number(b.p.has_income) - Number(a.p.has_income)) || (a.d - b.d) || (a.p.id - b.p.id));
    const { p, e } = ms[0];
    const have = new Set(p.cost_cats);
    const adds = [];
    if (!p.has_income && toRm(e.sales) > 0) adds.push({ kind: "income", cat: "sales", amt: toRm(e.sales) });
    if (have.has("cogs")) cogsSkippedLegacy++;
    else for (const [cat, f] of COGS_SUB) if (!have.has(cat) && toRm(e[f]) > 0) adds.push({ kind: "cost", cat, amt: toRm(e[f]) });
    if (!have.has("rental") && toRm(e.rental) > 0) adds.push({ kind: "cost", cat: "rental", amt: toRm(e.rental) });
    if (!have.has("setup") && toRm(e.setup) > 0) adds.push({ kind: "cost", cat: "setup", amt: toRm(e.setup) });
    if (adds.length) plan.push({ p, e, adds });
    for (const other of ms.slice(1)) overlapDup.push({ p: other.p, e, primaryId: p.id });
  }

  // Totals
  const catTot = {};
  let addIncome = 0, addCogs = 0;
  for (const { adds } of plan) for (const a of adds) {
    catTot[a.cat] = (catTot[a.cat] || 0) + a.amt;
    if (a.kind === "income") addIncome += a.amt; else if (COGS_BUCKET.includes(a.cat)) addCogs += a.amt;
  }
  const curRevenue = projects.reduce((s, p) => s + toRm(p.income_sum), 0);
  const curCogs = projects.reduce((s, p) => s + toRm(p.cogs_sum), 0);
  const projRevenue = curRevenue + addIncome;
  const projCogs = curCogs + addCogs;
  const pctOf = (a, b) => (b > 0 ? (a / b * 100).toFixed(1) + "%" : "n/a");

  console.log(`\n=== FAIR PNL FILL MISSING CATEGORIES — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`in-scope projects: ${projects.length}, matched an Excel event: ${matched.length}, events with >=1 match: ${byEvent.size}`);
  console.log(`projects to top-up (missing >=1 category): ${plan.length}`);
  const totalLines = plan.reduce((s, x) => s + x.adds.length, 0);
  console.log(`\nlines to ADD by category:`);
  for (const c of ["sales", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories", "rental", "setup"]) {
    const n = plan.reduce((s, x) => s + x.adds.filter((a) => a.cat === c).length, 0);
    if (n) console.log(`   ${c.padEnd(18)} ${String(n).padStart(4)} line(s)   total RM ${fmt(catTot[c] || 0)}`);
  }
  console.log(`   ${"".padEnd(18)} ----`);
  console.log(`   total lines: ${totalLines}`);
  console.log(`\nprojects skipped for COGS because they carry a legacy 'cogs' aggregate line: ${cogsSkippedLegacy}`);
  console.log(`projects sharing an event with a chosen primary (NOT filled, likely duplicates -> review): ${overlapDup.length}`);
  for (const o of overlapDup.slice(0, 25)) console.log(`   p${o.p.id} ${o.p.start_date} [${o.p.brand}] @ ${o.p.venue}  shares Excel ${o.e.start} with primary p${o.primaryId}`);
  if (overlapDup.length > 25) console.log(`   ... +${overlapDup.length - 25} more`);

  console.log(`\nCOGS %% of revenue:  current ${fmt(curCogs)} / ${fmt(curRevenue)} = ${pctOf(curCogs, curRevenue)}`);
  console.log(`                     projected ${fmt(projCogs)} / ${fmt(projRevenue)} = ${pctOf(projCogs, projRevenue)}  (after this fill)`);

  console.log(`\n[sample of top-ups, first 25 of ${plan.length}]`);
  for (const { p, e, adds } of plan.slice(0, 25)) {
    console.log(`   p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue}  <- Excel ${e.start}  add: ${adds.map((a) => `${a.cat}=${fmt(a.amt)}`).join(", ")}`);
  }

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will INSERT ${totalLines} finance line(s) across ${plan.length} project(s). No existing line touched.`); process.exit(0); }
  if (!plan.length) { console.log(`\nnothing to add.`); process.exit(0); }
  let ins = 0;
  for (const { p, adds } of plan) {
    for (const a of adds) {
      await sql`INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id)
                VALUES (${p.id}, ${a.kind}, ${a.cat}, ${a.cat + " (FAIR PNL cogs-fill)"}, ${a.amt}, ${p.start_date}, ${companyId})`;
      ins++;
    }
  }
  console.log(`\nCOMMIT done: inserted ${ins} finance line(s) across ${plan.length} project(s). No existing line touched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

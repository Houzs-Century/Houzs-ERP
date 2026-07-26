// READ-ONLY: explain the PMS-vs-Excel count gap. Match every in-scope PMS project to an Excel
// event (brand + venueNorm(canonVenue) + within 10 days). Report:
//  A) DUPLICATE events: one Excel event matched by >1 PMS project (the extras that inflate count/amount)
//  B) UNMATCHED PMS projects: a PMS project matching NO Excel event (in PMS but not in the Excel)
// Writes NOTHING. Scope 2024-01-01..2026-06-30.
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
const KWRENAME = [[/\bMITEC\b/, "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE"], [/\bMITC\b/, "MELAKA INTERNATIONAL TRADE CENTRE"], [/\bKLCC\b/, "KUALA LUMPUR CONVENTION CENTRE"], [/\bPWCC\b/, "PENANG WATERFRONT CONVENTION CENTRE"], [/\bSPCC\b|SUNWAY\s*PYRAMID/, "SUNWAY PYRAMID CONVENTION CENTRE"], [/\bSCCC\b|SETIA\s*CITY/, "SETIA CITY CONVENTION CENTRE"], [/\bBCCK\b/, "BORNEO CONVENTION CENTRE KUCHING"], [/\bSICC\b/, "SABAH INTERNATIONAL CONVENTION CENTRE"], [/\bITCC\b/, "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE"], [/\bAICC\b/, "AUSTIN INTERNATIONAL CONVENTION CENTRE"], [/\bPICCA\b/, "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE"]];
function canonOld(raw) { const u = norm(raw);
  if (u.includes("SOUTHKEY")) return "MVEC SOUTHKEY"; if (u.includes("MVEC") || u.includes("MIDVALLEY")) return "MID VALLEY";
  if (u.includes("PAVILION") || u.includes("PAVILLION")) return "PAVILION BUKIT JALIL"; if (u.includes("STADIUM") && u.includes("JALIL")) return "STADIUM BUKIT JALIL";
  if (u.includes("STARLING")) return "THE STARLING MALL"; if (u.includes("SSCC") || u.includes("SETIASPICE")) return "SETIA SPICE CONVENTION CENTRE";
  if (u.includes("SPICEARENA") || u.includes("PISA")) return "PISA SPICE ARENA CONVENTION CENTRE"; if (u.includes("IOICITYMALL")) return "IOI MALL PUTRAJAYA";
  if (u.includes("IOIDAMANSARA")) return "IOI MALL DAMANSARA"; if (u.includes("TERBAU") || u.includes("TEBRAU")) return "AEON TEBRAU CITY";
  if (u.includes("PERSADA")) return "PERSADA JOHOR INTERNATIONAL CONVENTION CENTRE"; if (u.includes("VIVACITY")) return "VIVACITY MEGAMALL";
  if (u.includes("ALMA") && u.includes("MERTAJAM")) return "AEON BUKIT MERTAJAM"; if (u.includes("AEONCHERAS") && !u.includes("SELATAN")) return "AEON TAMAN MALURI";
  if (u.includes("METROCITY") || (u.includes("MCC") && u.includes("KUCHING"))) return "KUCHING METROCITY CONVENTION CENTRE";
  if ((u.includes("INDERAMULIA") || u.includes("ENDERAMULIA")) || (u.includes("STADIUM") && u.includes("IPOH"))) return "STADIUM INDERA MULIA IPOH"; return raw; }
const canonVenue = (raw) => { const u = " " + String(raw ?? "").toUpperCase() + " "; for (const [re, n] of KWRENAME) if (re.test(u)) return n; return canonOld(raw); };
const bnorm = (b) => { const n = norm(b); return n === "AKEMICC" ? "AKEMI" : n; }; // AKEMI C&C == AKEMI (owner)
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const rm = (n) => Number(n || 0).toLocaleString();

async function main() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8")).filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name, p.created_by,
           COALESCE(SUM(l.amount) FILTER (WHERE l.kind='income' AND l.archived_at IS NULL),0) income
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.start_date >= '2024-01-01' AND p.start_date < '2026-07-01'
    GROUP BY p.id`;
  const eidx = new Map();
  for (const e of events) { const k = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (eidx.get(k) || eidx.set(k, []).get(k)).push(e); }

  const unmatched = []; const evToProj = new Map();
  for (const p of projects) {
    const cands = (eidx.get(`${bnorm(p.brand)}|${venueNorm(p.venue)}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (!cands.length) { unmatched.push(p); continue; }
    const e = cands.sort((a, b) => days(a.start, p.start_date) - days(b.start, p.start_date))[0];
    const ek = `${bnorm(e.brand)}|${venueNorm(canonVenue(e.venue))}|${e.start}`;
    (evToProj.get(ek) || evToProj.set(ek, { e, ps: [] }).get(ek)).ps.push(p);
  }
  const dupGroups = [...evToProj.values()].filter((g) => g.ps.length > 1);
  const extraFromDups = dupGroups.reduce((s, g) => s + (g.ps.length - 1), 0);

  console.log(`\n=== PMS-vs-Excel EXTRAS AUDIT (read-only) 2024-01..2026-06 ===`);
  console.log(`PMS projects in scope: ${projects.length}   Excel events: ${events.length}   gap: ${projects.length - events.length}`);
  console.log(`  A) DUPLICATE events (>1 PMS project for one Excel event): ${dupGroups.length} events -> ${extraFromDups} EXTRA projects`);
  console.log(`  B) UNMATCHED PMS projects (no Excel event at all): ${unmatched.length}`);

  console.log(`\n[A) DUPLICATE events]`);
  for (const g of dupGroups.sort((a, b) => String(a.e.start).localeCompare(String(b.e.start))))
    console.log(`   Excel ${g.e.start} [${g.e.brand}] @ ${canonVenue(g.e.venue)} (sales=${rm(g.e.sales)}) -> ${g.ps.length} PMS:  ${g.ps.map((p) => `p${p.id}(${p.start_date},inc=${rm(p.income)},by${p.created_by})`).join("  ")}`);

  console.log(`\n[B) UNMATCHED PMS projects — in PMS, not in Excel]`);
  for (const p of unmatched.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))))
    console.log(`   p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue} inc=${rm(p.income)} by${p.created_by}  "${String(p.name).slice(0, 48)}"`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

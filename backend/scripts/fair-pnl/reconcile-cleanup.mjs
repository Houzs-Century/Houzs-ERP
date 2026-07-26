// CLEANUP (owner 2026-07-27): (1) relabel brand "AKEMI C&C" -> "AKEMI" (owner: the "(C&C)" rows
// are AKEMI, not a separate brand — only 2 events, one carries the real sales). (2) DELETE the
// blank stray owner projects: created_by<>0, start < 2026-07-01, NO income line, that match a
// BLANK Excel event (sales=0) — i.e. a stray booth row (no real sales, only reference-filled cost)
// sitting next to the filled brand. Owner rule: no real sales = not a real project = delete.
// Dry-run (default) lists both; --commit applies. Future (>=2026-07) placeholders are never touched.
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
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

async function main() {
  const events = JSON.parse(fs.readFileSync(path.join(HERE, "seed_data_final.json"), "utf8")).filter((r) => r.start && r.start >= "2024-01-01" && r.start < "2026-07-01");
  const projects = await sql`
    SELECT p.id, p.brand, p.venue, p.start_date, p.name,
           BOOL_OR(l.kind = 'income' AND l.archived_at IS NULL) has_income
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL AND p.created_by <> 0 GROUP BY p.id`;
  const idx = new Map();
  for (const e of events) { const k = `${norm(e.brand)}|${venueNorm(canonVenue(e.venue))}`; (idx.get(k) || idx.set(k, []).get(k)).push(e); }

  const relabel = projects.filter((p) => norm(p.brand).replace("AND", "") === "AKEMICC");
  const del = [];
  for (const p of projects) {
    if (p.has_income) continue;
    if (String(p.start_date) >= "2026-07-01") continue; // never touch future placeholders
    const cands = (idx.get(`${norm(p.brand === "AKEMI C&C" ? "AKEMI" : p.brand)}|${venueNorm(p.venue)}`) || idx.get(`${norm(p.brand)}|${venueNorm(p.venue)}`) || []).filter((e) => days(e.start, p.start_date) <= 10);
    if (cands.length && cands.every((e) => Number(e.sales) <= 0)) del.push(p); // matched only BLANK excel events
  }

  console.log(`\n=== FAIR PNL CLEANUP — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`\n[RELABEL AKEMI C&C -> AKEMI: ${relabel.length}]`);
  for (const p of relabel) console.log(`   p${p.id} ${p.start_date} @ ${p.venue}  (${p.has_income ? "has sales" : "blank"})`);
  console.log(`\n[DELETE blank stray projects (no sales, matched a blank Excel row, < Jul-2026): ${del.length}]`);
  for (const p of del) console.log(`   p${p.id} ${p.start_date} [${p.brand}] @ ${p.venue}  "${p.name}"`);

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will relabel ${relabel.length}, delete ${del.length} + their lines. Future placeholders untouched.`); process.exit(0); }

  for (const p of relabel) {
    const newName = String(p.name || "").replace(/\[AKEMI C&C\]/gi, "[AKEMI]");
    await sql`UPDATE projects SET brand = 'AKEMI', name = ${newName} WHERE id = ${p.id}`;
  }
  const ids = del.map((p) => p.id);
  if (ids.length) { await sql`DELETE FROM project_finance_lines WHERE project_id = ANY(${ids})`; await sql`DELETE FROM projects WHERE id = ANY(${ids})`; }
  console.log(`\nCOMMIT done: relabeled ${relabel.length} to AKEMI, deleted ${ids.length} blank stray project(s).`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

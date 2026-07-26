// Standardize the PMS venue menu (owner task 2026-07-26: "整理 venue 的统称").
// Objective corrections (dedup merges, wrong/missing states) + full-name expansions
// for convention centres (owner chose 全名). Renames cascade to projects.venue and
// projects.state because those are stored as TEXT snapshots.
//
// Dry-run (default): reports every change + how many projects each touches, checks
// for collisions. Writes NOTHING. --commit applies. Same guard-rails as the seed.
import postgres from "postgres";

const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── MERGE: duplicate maintained rows -> the survivor (already a real venue). ──
// Move every project off the dup, then delete the dup venue row.
const MERGE = {
  "STADIUM  BUKIT JALIL": "STADIUM BUKIT JALIL",      // double-space dup, no state
  "DATARAN CENTRIO SEREMBAN": "DATARAN CENTRIO",       // same mall, Seremban NS
  "EAST COAST MALL KUANTAN": "EAST COAST MALL",        // same mall, Kuantan
  "IOI DAMANSARA": "IOI MALL DAMANSARA",               // same mall
  "MCCC KUCHING": "KUCHING METROCITY CONVENTION CENTRE", // MCCC = MetroCity Convention Centre
};

// ── RENAME: current name -> standardized full name (owner chose 全名). ──
const RENAME = {
  "MITC": "MELAKA INTERNATIONAL TRADE CENTRE",
  "MITEC": "MALAYSIA INTERNATIONAL TRADE AND EXHIBITION CENTRE",
  "BCCK KUCHING": "BORNEO CONVENTION CENTRE KUCHING",
  "SCCC SHAH ALAM": "SETIA CITY CONVENTION CENTRE",
  "KLCC CONVENTION CENTRE": "KUALA LUMPUR CONVENTION CENTRE",
  "PWCC": "PENANG WATERFRONT CONVENTION CENTRE",
  "SPCC": "SUNWAY PYRAMID CONVENTION CENTRE",
  "SICC": "SABAH INTERNATIONAL CONVENTION CENTRE",
  "ITCC": "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE",
  "AICC AUSTIN": "AUSTIN INTERNATIONAL CONVENTION CENTRE",
  "PICCA BUTTERWORTH ARENA": "PENANG INTERNATIONAL CONVENTION CULTURAL AND ARTS CENTRE",
  "DATARAN PAHLAWAN": "DATARAN PAHLAWAN MELAKA MEGAMALL",
};

// ── SET_STATE: FINAL name (after any rename) -> correct maintained state. ──
const SET_STATE = {
  "SETIA CITY CONVENTION CENTRE": "Selangor", // was SCCC SHAH ALAM tagged KL
  "SUNWAY PYRAMID CONVENTION CENTRE": "Selangor", // Sunway Pyramid is PJ/Subang
  "NU EMPIRE SUBANG": "Selangor",
  "INTERNATIONAL TECHNOLOGY AND COMMERCIAL CENTRE": "Sabah", // ITCC Penampang
  "SABAH INTERNATIONAL CONVENTION CENTRE": "Sabah",
  "KSL ESPLANADE MALL": "Selangor", // Klang
};

const VALID_STATES = new Set(["Johor", "Kedah", "Kelantan", "Kuala Lumpur", "Labuan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis", "Pulau Pinang", "Putrajaya", "Sabah", "Sarawak", "Selangor", "Terengganu"]);

async function main() {
  const [venues, houzs] = await Promise.all([
    sql`SELECT name, state FROM project_venues`,
    sql`SELECT id FROM companies WHERE code = 'HOUZS' LIMIT 1`,
  ]);
  const companyId = houzs[0]?.id ?? null;
  const byName = new Map(venues.map((v) => [v.name, v]));
  const projCount = async (venueName) => Number((await sql`SELECT COUNT(*)::int n FROM projects WHERE venue = ${venueName} AND archived_at IS NULL`)[0].n);

  console.log(`\n=== VENUE STANDARDIZATION — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company: HOUZS (id ${companyId})   maintained venues: ${venues.length}`);

  const problems = [];
  // Validate the plan against the live list before doing anything.
  for (const [dup, surv] of Object.entries(MERGE)) {
    if (!byName.has(dup)) problems.push(`MERGE source missing: "${dup}"`);
    if (!byName.has(surv)) problems.push(`MERGE survivor missing: "${surv}" (must already exist)`);
  }
  for (const [from, to] of Object.entries(RENAME)) {
    if (!byName.has(from)) problems.push(`RENAME source missing: "${from}"`);
    if (byName.has(to) && norm(from) !== norm(to)) problems.push(`RENAME target already exists (would collide): "${to}" — make it a MERGE instead`);
  }
  for (const st of Object.values(SET_STATE)) if (!VALID_STATES.has(st)) problems.push(`invalid state: ${st}`);

  // ── Report the plan ──
  console.log(`\n[MERGE ${Object.keys(MERGE).length}] duplicate rows -> survivor (projects moved, dup deleted)`);
  for (const [dup, surv] of Object.entries(MERGE)) console.log(`   x "${dup}"  ->  "${surv}"   (${await projCount(dup)} project(s) move)`);

  console.log(`\n[RENAME ${Object.keys(RENAME).length}] full-name standardization`);
  for (const [from, to] of Object.entries(RENAME)) console.log(`   ~ "${from}"  ->  "${to}"   (${await projCount(from)} project(s))`);

  console.log(`\n[SET STATE ${Object.keys(SET_STATE).length}] state corrections / fills`);
  for (const [name, st] of Object.entries(SET_STATE)) {
    const cur = byName.get(name); const was = cur ? (cur.state || "(blank)") : "(will exist after rename)";
    console.log(`   . "${name}"  state ${was} -> ${st}`);
  }

  if (problems.length) { console.log(`\nBLOCKED — fix these first:\n   - ${problems.join("\n   - ")}\nNOTHING WRITTEN.`); process.exit(0); }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will apply ${Object.keys(MERGE).length} merge(s), ${Object.keys(RENAME).length} rename(s), ${Object.keys(SET_STATE).length} state fix(es).`); process.exit(0); }

  // ── COMMIT ──
  let moved = 0, renamed = 0, stated = 0;
  for (const [dup, surv] of Object.entries(MERGE)) {
    const r = await sql`UPDATE projects SET venue = ${surv} WHERE venue = ${dup}`;
    await sql`DELETE FROM project_venues WHERE name = ${dup}`;
    moved += r.count; console.log(`merged "${dup}" -> "${surv}" (${r.count} projects)`);
  }
  for (const [from, to] of Object.entries(RENAME)) {
    await sql`UPDATE project_venues SET name = ${to} WHERE name = ${from}`;
    const r = await sql`UPDATE projects SET venue = ${to} WHERE venue = ${from}`;
    renamed++; console.log(`renamed "${from}" -> "${to}" (${r.count} projects)`);
  }
  for (const [name, st] of Object.entries(SET_STATE)) {
    await sql`UPDATE project_venues SET state = ${st} WHERE name = ${name}`;
    const r = await sql`UPDATE projects SET state = ${st} WHERE venue = ${name}`;
    stated++; console.log(`state "${name}" -> ${st} (${r.count} projects)`);
  }
  console.log(`\nCOMMIT done: ${moved} projects moved by merge, ${renamed} venues renamed, ${stated} state fixes.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

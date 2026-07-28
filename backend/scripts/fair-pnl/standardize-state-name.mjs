// FAIR PNL presentation standardizer — makes project state + name uniform:
//   state := the venue's state from the project_venues picker (fixes IPOH/KUANTAN/
//            SEREMBAN uppercase-city + wrong-state legacy rows)
//   name  := "<state> [<brand>] <organizer|SOLO> @ <venue>"  (Title-Case state; fixes
//            the JOHOR-vs-Johor / KL-vs-Kuala-Lumpur casing inconsistency)
// ONLY touches state + name (presentation). Never venue/brand/organizer/finances/status.
// DRY-RUN by default. --commit to write. Scope 2024-01..2026-07 (July 2026+ untouched).
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

// Known 1-day gap events (seeded with start=end); set their true multi-day end.
const GAP_ENDS = [
  ["SABAH INTERNATIONAL CONVENTION CENTRE", "2025-02-21", "2025-02-23"],
  ["SABAH INTERNATIONAL CONVENTION CENTRE", "2025-05-01", "2025-05-04"],
  ["MID VALLEY", "2025-05-10", "2025-05-12"],
  ["MID VALLEY", "2025-06-20", "2025-06-22"],
  ["MID VALLEY", "2025-07-18", "2025-07-20"],
];

async function main() {
  let endFix = 0;
  for (const [venue, start, end] of GAP_ENDS) {
    const rows = await sql`SELECT id FROM projects WHERE archived_at IS NULL AND venue=${venue} AND start_date=${start} AND end_date=${start}`;
    for (const r of rows) { if (COMMIT) await sql`UPDATE projects SET end_date=${end} WHERE id=${r.id}`; endFix++; console.log(`  ${COMMIT ? "END-FIXED" : "would set end"} p${r.id} ${venue} ${start} -> end ${end}`); }
  }
  console.log(`multi-day end fixes: ${endFix}`);

  const venues = await sql`SELECT name, state FROM project_venues`;
  const vstate = new Map(venues.map((v) => [v.name, v.state]));
  const projects = await sql`
    SELECT id, brand, venue, organizer, state, name FROM projects
    WHERE archived_at IS NULL AND start_date >= '2024-01-01' AND start_date < '2026-07-01'
    ORDER BY start_date`;
  console.log(`\n=== FAIR PNL standardize state+name — ${COMMIT ? "COMMIT" : "DRY-RUN"} ===`);
  console.log(`in-scope projects: ${projects.length}`);

  let stateFix = 0, nameFix = 0, updated = 0;
  const samples = [];
  for (const p of projects) {
    const pickerState = vstate.has(p.venue) ? vstate.get(p.venue) : p.state; // keep if venue not in picker
    const org = p.organizer && String(p.organizer).trim() ? p.organizer : "SOLO";
    const newName = `${pickerState ? pickerState + " " : ""}[${p.brand}] ${org} @ ${p.venue}`;
    const stChanged = String(p.state ?? "") !== String(pickerState ?? "");
    const nmChanged = String(p.name ?? "") !== newName;
    if (!stChanged && !nmChanged) continue;
    if (stChanged) stateFix++;
    if (nmChanged) nameFix++;
    if (samples.length < 25) samples.push(`  p${p.id}: state ${JSON.stringify(p.state)}->${JSON.stringify(pickerState)} | name ${JSON.stringify(p.name)} -> ${JSON.stringify(newName)}`);
    if (COMMIT) await sql`UPDATE projects SET state=${pickerState ?? null}, name=${newName} WHERE id=${p.id}`;
    updated++;
  }
  console.log(`state corrections: ${stateFix} | name rebuilds: ${nameFix} | rows updated: ${updated}`);
  console.log("samples:");
  samples.forEach((s) => console.log(s));
  if (!COMMIT) console.log("\n--commit to apply (state+name only; reversible via re-run).");
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

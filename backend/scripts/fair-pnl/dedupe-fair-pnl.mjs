// Find + remove FAIR-PNL-seed duplicates: projects the seed inserted (created_by = 0)
// that collide with a pre-existing owner-entered project (created_by <> 0) for the SAME
// brand + venue + organizer in the SAME calendar month. The seed dedup only matched on an
// exact start_date, so owner entries with a slightly different day slipped through.
//
// Owner rule: keep the owner's manual entry, remove the seeded copy. Dry-run (default)
// lists every collision group. --commit deletes the seeded copies (+ their finance lines).
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const vnorm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const ym = (d) => String(d ?? "").slice(0, 7);
const rm = (n) => `RM ${Number(n || 0).toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;

async function main() {
  const houzs = await sql`SELECT id FROM companies WHERE code='HOUZS' LIMIT 1`;
  const companyId = houzs[0]?.id ?? null;
  const projects = await sql`
    SELECT id, code, name, brand, venue, organizer, start_date, end_date, created_by
    FROM projects WHERE archived_at IS NULL AND company_id = ${companyId}`;

  // group by brand + venueNorm + organizerNorm + year-month
  const groups = new Map();
  for (const p of projects) {
    const k = `${vnorm(p.brand)}|${vnorm(p.venue)}|${vnorm(p.organizer)}|${ym(p.start_date)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(p);
  }

  const collisions = []; // groups with BOTH a seeded (created_by=0) and an owner (created_by<>0) row
  for (const [k, members] of groups) {
    const mine = members.filter((p) => Number(p.created_by) === 0);
    const owner = members.filter((p) => Number(p.created_by) !== 0);
    if (mine.length && owner.length) collisions.push({ k, mine, owner });
  }

  console.log(`\n=== FAIR PNL DEDUPE — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company HOUZS (id ${companyId})   projects: ${projects.length}   collision groups: ${collisions.length}`);
  let toDelete = [];
  for (const c of collisions.sort((a, b) => a.k.localeCompare(b.k))) {
    const [brand, , , mon] = c.k.split("|");
    console.log(`\n  [${brand} @ ${c.mine[0].venue} / ${c.mine[0].organizer || "SOLO"} / ${mon}]`);
    for (const p of c.owner) console.log(`     KEEP  (owner #${p.created_by})  ${p.start_date}..${p.end_date}  ${p.name}`);
    for (const p of c.mine)  { console.log(`     DROP  (seed  #0)  ${p.start_date}..${p.end_date}  ${p.name}  [${p.code}]`); toDelete.push(p); }
  }
  console.log(`\nseeded duplicates to remove: ${toDelete.length}`);
  if (!toDelete.length) { console.log("no seed-vs-owner duplicates found."); process.exit(0); }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will delete ${toDelete.length} seeded project(s) + their finance lines. Owner entries are untouched.`); process.exit(0); }

  const ids = toDelete.map((p) => p.id);
  const fl = await sql`DELETE FROM project_finance_lines WHERE project_id = ANY(${ids})`;
  const pr = await sql`DELETE FROM projects WHERE id = ANY(${ids})`;
  console.log(`\nCOMMIT done: deleted ${pr.count} seeded duplicate project(s) + ${fl.count} finance line(s). Owner entries kept.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

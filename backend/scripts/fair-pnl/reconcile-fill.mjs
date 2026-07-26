// RECONCILE the FAIR PNL seed onto the owner's own projects. For each SEED project
// (created_by=0) find the owner project for the same event (brand + venue + date window):
//   - owner EMPTY  -> TRANSFER the seed's finance lines onto the owner project, delete the seed shell.
//   - owner HAS DATA-> the owner already has it; delete the seed duplicate (+ its lines).
//   - NO owner match-> keep the seed project (it's the only one for that event); retitle + stage=completed.
// Owner data is never deleted. Reuses the already-amount-fixed seed lines (re-parents, no recompute).
// Dry-run (default) reports counts + samples. --commit executes.
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const STATE_TAIL = /\b(KL|PG|PNG|JB|JHB|PJ|MLK|NS|SWK|SEL|SELANGOR|PENANG|JOHOR|KEDAH|PERAK|PERLIS|PAHANG|MELAKA|MALACCA|KELANTAN|TERENGGANU|SABAH|SARAWAK|NEGERI\s*SEMBILAN|PUTRAJAYA|IPOH|KUANTAN|SEREMBAN)\b\s*$/i;
const ABBR = [[/\bTMN\b/gi, "TAMAN"], [/\bBKT\b/gi, "BUKIT"], [/\bBUKTI\b/gi, "BUKIT"], [/\bMILLENIUM\b/gi, "MILLENNIUM"]];
const expandAbbr = (s) => { let v = String(s ?? ""); for (const [re, to] of ABBR) v = v.replace(re, to); return v; };
const venueNorm = (s) => { let v = expandAbbr(String(s ?? "").trim()); for (let i = 0; i < 3; i++) v = v.replace(STATE_TAIL, "").trim(); return norm(v); };
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

async function main() {
  // seed projects hold their OWN already-standardized venue (统称 cascade updated projects.venue),
  // so no canonVenue needed here — we match seed.venue against owner.venue directly by venueNorm.
  const rows = await sql`
    SELECT p.id, p.brand, p.venue, p.state, p.organizer, p.start_date, p.created_by, p.name,
           COUNT(l.id) FILTER (WHERE l.archived_at IS NULL) nlines
    FROM projects p LEFT JOIN project_finance_lines l ON l.project_id = p.id
    WHERE p.archived_at IS NULL GROUP BY p.id`;
  const seed = rows.filter((p) => Number(p.created_by) === 0);
  const owner = rows.filter((p) => Number(p.created_by) !== 0);
  const idx = new Map();
  for (const p of owner) { const k = `${norm(p.brand)}|${venueNorm(p.venue)}`; (idx.get(k) || idx.set(k, []).get(k)).push(p); }

  const fill = [], delDup = [], keep = [];
  for (const s of seed) {
    const cands = (idx.get(`${norm(s.brand)}|${venueNorm(s.venue)}`) || []).filter((o) => days(o.start_date, s.start_date) <= 10);
    if (!cands.length) { keep.push(s); continue; }
    const o = cands.sort((a, b) => days(a.start_date, s.start_date) - days(b.start_date, s.start_date))[0];
    (Number(o.nlines) === 0 ? fill : delDup).push([s, o]);
  }

  console.log(`\n=== FAIR PNL RECONCILE-FILL — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`seed projects: ${seed.length}   owner projects: ${owner.length}`);
  console.log(`  TRANSFER seed lines -> owner EMPTY project, then delete seed shell:  ${fill.length}`);
  console.log(`  DELETE seed duplicate (owner already has data):                      ${delDup.length}`);
  console.log(`  KEEP seed project (no owner match) + retitle/stage:                  ${keep.length}`);
  const smp = (label, arr) => { console.log(`\n[${label} — sample ${Math.min(8, arr.length)}/${arr.length}]`); for (const x of arr.slice(0, 8)) { const [s, o] = Array.isArray(x) ? x : [x, null]; console.log(o ? `   seed p${s.id} ${s.start_date} @ ${s.venue}  ->  owner p${o.id} ${o.start_date}` : `   keep p${s.id} ${s.start_date} [${s.brand}] @ ${s.venue}`); } };
  smp("TRANSFER (fill owner)", fill); smp("DELETE dup", delDup); smp("KEEP + retitle", keep);

  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will transfer ${fill.length}, delete ${delDup.length} dup(s), retitle ${keep.length}. Owner data untouched.`); process.exit(0); }

  let moved = 0, del = 0, ret = 0;
  for (const [s, o] of fill) {
    await sql`UPDATE project_finance_lines SET project_id = ${o.id} WHERE project_id = ${s.id}`;
    await sql`DELETE FROM projects WHERE id = ${s.id}`;
    moved++;
  }
  for (const [s] of delDup) {
    await sql`DELETE FROM project_finance_lines WHERE project_id = ${s.id}`;
    await sql`DELETE FROM projects WHERE id = ${s.id}`;
    del++;
  }
  for (const s of keep) {
    const title = `${s.state ? s.state + " " : ""}[${s.brand}] ${s.organizer || "SOLO"} @ ${s.venue}`;
    await sql`UPDATE projects SET name = ${title}, stage = 'completed' WHERE id = ${s.id}`;
    ret++;
  }
  console.log(`\nCOMMIT done: transferred ${moved} to owner projects, deleted ${del} duplicate(s), retitled ${ret}. Owner data untouched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

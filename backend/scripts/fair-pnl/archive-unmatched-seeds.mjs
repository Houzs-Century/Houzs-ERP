// FAIR PNL — archive the 21 leftover seed projects that have NO Excel/v8 row of
// their own after the venue-canonical rematch (11 are duplicate twins of owner
// events seeded by the early, weaker matcher; 10 are orphans whose figures came
// from rows now correctly claimed by other projects). Owner approved removal.
//
// SAFETY: every pid must be created_by=0 (seed), have zero checklist attachments,
// and not already be archived — otherwise it is skipped and reported, never forced.
// archived_at is reversible. DRY-RUN by default; --commit applies.
import postgres from "postgres";

const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const PIDS = [2068, 2069, 2070, 2131, 2147, 647, 648, 1797, 1900, 1901,
  1956, 1963, 1982, 1980, 1979, 1981, 1985, 2004, 2032, 2044, 2054];

async function main() {
  const rows = await sql`
    SELECT p.id, p.created_by, p.archived_at, p.brand, p.venue, p.start_date,
           (SELECT COUNT(*) FROM project_checklist_attachments ca
              JOIN project_checklist c ON c.id = ca.item_id WHERE c.project_id = p.id)::int AS files,
           (SELECT COALESCE(SUM(amount),0) FROM project_finance_lines l
              WHERE l.project_id = p.id AND l.kind='income')::bigint AS income
    FROM projects p WHERE p.id IN ${sql(PIDS)}`;
  console.log(`=== archive unmatched seeds — ${COMMIT ? "COMMIT" : "DRY-RUN"} === (${rows.length}/${PIDS.length} found)`);
  const ok = [], skip = [];
  for (const r of rows) {
    if (String(r.created_by) !== "0") { skip.push([r, "not a seed (created_by!=0)"]); continue; }
    if (r.files > 0) { skip.push([r, `has ${r.files} file(s)`]); continue; }
    if (r.archived_at) { skip.push([r, "already archived"]); continue; }
    ok.push(r);
  }
  for (const r of ok) console.log(`  ARCHIVE p${r.id} ${r.start_date} [${r.brand}] @ ${r.venue} income=${r.income}`);
  for (const [r, why] of skip) console.log(`  SKIP    p${r.id} ${r.start_date} [${r.brand}] @ ${r.venue} — ${why}`);
  if (!COMMIT) { console.log(`\nDRY-RUN OK — --commit archives ${ok.length} (reversible).`); return; }
  for (const r of ok) await sql`UPDATE projects SET archived_at = NOW() WHERE id = ${r.id} AND archived_at IS NULL`;
  console.log(`\nCOMMIT DONE — archived ${ok.length} seed project(s).`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

// FAIR PNL — archive the 3 confirmed duplicate seed projects. The owner reviewed
// the full unmatched list against the calendar and the raw FAIR PNL sheets: 18 of
// the 21 "unmatched" seeds are REAL events my matcher failed to read (label quirks
// like "MLE SREMEBAN" = Dataran Centrio Seremban, "HOMEDEC SPICE" = Setia Spice) —
// those are KEPT. Only these 3 are visibly doubled on the calendar, each shadowing
// a real project with identical/near figures:
//   p2032 <-> p144 (AKEMI MLE @ MID VALLEY 2026-03-20, both RM382,597)
//   p2044 <-> p34  (AKEMI MEGAHOME @ MITC 2026-04-30)
//   p2054 <-> p367 (AKEMI BIGHOME @ MID VALLEY 2026-06-05, both RM515,856)
//
// SAFETY: every pid must be created_by=0 (seed), have zero checklist attachments,
// and not already be archived — otherwise it is skipped and reported, never forced.
// archived_at is reversible. DRY-RUN by default; --commit applies.
import postgres from "postgres";

const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

const PIDS = [2032, 2044, 2054];

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

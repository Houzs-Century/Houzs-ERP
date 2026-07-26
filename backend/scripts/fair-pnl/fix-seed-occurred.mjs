// FIX: the FAIR PNL seed never set project_finance_lines.occurred_at, so the Finance
// Lines date filter (which filters on COALESCE(occurred_at, created_at)) fell back to
// created_at = the seed run date (2026-07-26). Result: every seeded line looked dated
// 2026-07-26, so the 2026 filter matched all of them and 2025 matched none.
//
// This sets occurred_at = the project's start_date (the real event date) for seeded lines
// still missing it. Idempotent (only touches occurred_at IS NULL). Owner rows untouched.
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });

async function main() {
  const [{ n }] = await sql`
    SELECT COUNT(*)::int n
    FROM project_finance_lines l JOIN projects p ON p.id = l.project_id
    WHERE l.description LIKE '%(FAIR PNL seed)%' AND l.occurred_at IS NULL`;
  console.log(`\n=== FAIR PNL occurred_at backfill — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`seeded lines missing occurred_at: ${n}`);

  const sample = await sql`
    SELECT p.start_date, l.category, l.description
    FROM project_finance_lines l JOIN projects p ON p.id = l.project_id
    WHERE l.description LIKE '%(FAIR PNL seed)%' AND l.occurred_at IS NULL
    ORDER BY p.start_date LIMIT 6`;
  for (const r of sample) console.log(`   occurred_at <- ${r.start_date}   (${r.category})`);

  if (!n) { console.log("\nnothing to fix (already set or no seeded lines)."); process.exit(0); }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will set occurred_at = project start_date on ${n} seeded line(s).`); process.exit(0); }

  const r = await sql`
    UPDATE project_finance_lines l
    SET occurred_at = p.start_date
    FROM projects p
    WHERE l.project_id = p.id
      AND l.description LIKE '%(FAIR PNL seed)%'
      AND l.occurred_at IS NULL
      AND p.start_date IS NOT NULL`;
  console.log(`\nCOMMIT done: set occurred_at on ${r.count} seeded finance line(s). The date filter now works.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

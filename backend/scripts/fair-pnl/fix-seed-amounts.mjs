// FIX: the FAIR PNL seed stored project_finance_lines.amount as sen (rm*100), but the
// column is whole-RM integer (the app's createLedgerLine stores input.amount directly;
// fair-report.ts: "amount unit — NOT centi"). So every seeded line is 100x too big —
// hence RM 2,221M totals and int4-overflow 500s on SUM(amount).
//
// This divides ONLY the seeded lines (description ends "(FAIR PNL seed)", created_by=0)
// by 100 and marks them "(FAIR PNL seed) [rm]" so a re-run is a no-op. Owner rows untouched.
// Dry-run (default) prints before/after income+cost totals per year. --commit applies.
import postgres from "postgres";
const COMMIT = process.argv.includes("--commit");
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(DSN, { ssl: "require", max: 1, idle_timeout: 20, connect_timeout: 30 });
const rm = (n) => `RM ${Number(n || 0).toLocaleString("en-MY", { maximumFractionDigits: 0 })}`;

// The seed left finance-line created_by NULL (it set created_by only on the projects),
// so the unique description marker is the discriminator — no created_by condition.
const MATCH = sql`description LIKE '%(FAIR PNL seed)' AND description NOT LIKE '%[rm]%'`;

async function main() {
  const houzs = await sql`SELECT id FROM companies WHERE code='HOUZS' LIMIT 1`;
  const companyId = houzs[0]?.id ?? null;

  const [{ n, s }] = await sql`SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::bigint s FROM project_finance_lines WHERE ${MATCH}`;
  console.log(`\n=== FAIR PNL amount fix (÷100) — ${COMMIT ? "COMMIT" : "DRY-RUN (read-only)"} ===`);
  console.log(`company HOUZS (id ${companyId})`);
  console.log(`seeded lines still x100: ${n}   current SUM(amount): ${rm(s)}  ->  after ÷100: ${rm(Number(s) / 100)}`);

  // Per-year income/cost, current (x100) vs corrected (÷100), seeded lines only.
  const rows = await sql`
    SELECT LEFT(COALESCE(p.start_date,''),4) yr, l.kind,
           COALESCE(SUM(l.amount),0)::bigint cur
    FROM project_finance_lines l JOIN projects p ON p.id = l.project_id
    WHERE l.description LIKE '%(FAIR PNL seed)' AND l.description NOT LIKE '%[rm]%'
    GROUP BY 1,2 ORDER BY 1,2`;
  console.log(`\n  year | kind    | current (x100)        -> corrected (÷100)`);
  for (const r of rows) console.log(`  ${r.yr} | ${String(r.kind).padEnd(7)} | ${rm(r.cur).padEnd(20)} -> ${rm(Number(r.cur) / 100)}`);
  console.log(`  (expected corrected income: 2025 ~RM 31.66M, 2026 ~RM 15.86M)`);

  if (!n) { console.log("\nnothing to fix (already corrected or no seeded lines)."); process.exit(0); }
  if (!COMMIT) { console.log(`\nDRY-RUN OK. --commit will divide ${n} seeded line(s) by 100 and mark them [rm].`); process.exit(0); }

  const r = await sql`
    UPDATE project_finance_lines
    SET amount = round(amount / 100.0),
        description = description || ' [rm]'
    WHERE ${MATCH}`;
  console.log(`\nCOMMIT done: corrected ${r.count} seeded finance line(s) (÷100). Owner rows untouched.`);
}
main().then(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });

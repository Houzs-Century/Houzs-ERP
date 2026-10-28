// How many rows landed in each table since the flip? Drives the re-point
// plan: tables with post-flip rows must be carried over (or accepted as
// loss) when production moves to the company Supabase project.
// Usage: node scripts/delta-since-flip.mjs ["2026-06-12 16:40:00"]
import { readFileSync } from "node:fs";
import postgres from "postgres";

const FLIP = process.argv[2] || "2026-06-12 16:40:00";
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const candidates = await pg.unsafe(`
  SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = 'public'
   WHERE c.table_schema = 'public'
     AND t.table_type = 'BASE TABLE'
     AND c.column_name IN ('created_at','started_at','occurred_at','submitted_at')
   ORDER BY c.table_name`);

const seen = new Set();
let total = 0;
for (const { table_name, column_name } of candidates) {
  if (seen.has(table_name)) continue;
  seen.add(table_name);
  try {
    const [{ n }] = await pg.unsafe(
      `SELECT count(*)::int AS n FROM "${table_name}" WHERE "${column_name}" > '${FLIP}'`,
    );
    if (n > 0) {
      console.log(`${table_name}.${column_name}: +${n}`);
      total += n;
    }
  } catch {
    /* non-timestamp text column etc. — skip */
  }
}
console.log(`\ntotal post-flip rows across ${seen.size} tables checked: ${total}`);
await pg.end();

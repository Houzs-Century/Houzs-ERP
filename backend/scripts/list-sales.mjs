// Read-only: list sales org positions (config) + rep counts (aggregate, no PII).
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, idle_timeout: 2 });

const cols = await sql`
  SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
  FROM information_schema.columns
  WHERE table_name IN ('sales_positions','sales_reps','sales_position_tiers')
  GROUP BY table_name ORDER BY table_name`;
console.log("COLUMNS:");
for (const c of cols) console.log(`  ${c.table_name}: ${c.columns}`);

const positions = await sql`SELECT * FROM sales_positions ORDER BY id`;
console.log(`\nSALES_POSITIONS (${positions.length} rows):`);
for (const p of positions) console.log("  " + JSON.stringify(p));

const repTotal = await sql`SELECT count(*) AS n FROM sales_reps`;
console.log(`\nsales_reps total: ${repTotal[0].n}`);

await sql.end({ timeout: 3 }).catch(() => {});
process.exitCode = 0;

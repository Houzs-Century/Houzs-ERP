// Apply a .sql file to the Supabase database statement-by-statement.
// Usage: node scripts/apply-sql-file.mjs <path-to-sql>
import { readFileSync } from "node:fs";
import postgres from "postgres";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-sql-file.mjs <file.sql>");
  process.exit(2);
}
const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const sql = readFileSync(file, "utf8");
const stmts = sql
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);

let ok = 0;
const failed = [];
for (const s of stmts) {
  try {
    await pg.unsafe(s);
    ok++;
  } catch (e) {
    failed.push({ sql: s.slice(0, 90), err: e.message.slice(0, 110) });
  }
}
console.log(`${file}: ${ok}/${stmts.length} statements ok`);
for (const f of failed) console.log(`  FAIL ${f.err}\n    ${f.sql}`);
await pg.end();
process.exit(failed.length ? 1 : 0);

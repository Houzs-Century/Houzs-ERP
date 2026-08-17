/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for the D1 -> Supabase cutover and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   It replayed the D1 migrations into an in-memory SQLite to diff them against Postgres. D1 is test-only now.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
// Replay all D1 migrations into an in-memory SQLite (sql.js) to recover the
// AUTHORITATIVE final schema (after all 195 ALTERs), then dump each table's
// final CREATE + columns. Source for porting the raw-SQL-only tables to PG.
// No Cloudflare needed — migrations are the source of truth.
import initSqlJs from "sql.js";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = "src/db/migrations";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));

const SQL = await initSqlJs();
const db = new SQL.Database();

let okFiles = 0,
  errStmts = 0;
for (const f of files) {
  const text = readFileSync(`${dir}/${f}`, "utf8");
  // Strip full-line comments FIRST (a leading `-- ...` line would otherwise
  // make the whole statement chunk look like a comment), then split.
  const clean = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  const stmts = clean
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    try {
      db.run(s);
    } catch (e) {
      errStmts++;
      // Only surface schema-affecting failures, not seed/data ones.
      if (/CREATE TABLE|ALTER TABLE/i.test(s))
        console.log(`  [${f}] ${e.message.slice(0, 70)} :: ${s.slice(0, 60).replace(/\s+/g, " ")}`);
    }
  }
  okFiles++;
}

const res = db.exec(
  "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_new' AND name NOT LIKE '%_rebuild' ORDER BY name",
);
const rows = res[0] ? res[0].values : [];
const dump = rows.map((r) => r[1].trim() + ";").join("\n\n");
writeFileSync("src/db/d1-schema-dump.sql", dump + "\n");

console.log(`files: ${files.length}, schema-stmt errors: ${errStmts}`);
console.log(`TABLES RECOVERED: ${rows.length}`);
console.log("-> src/db/d1-schema-dump.sql");

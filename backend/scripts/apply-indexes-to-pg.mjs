// Apply the CREATE INDEX statements from the D1 dump to Supabase Postgres.
// The loader (load-d1-dump-to-pg.mjs) extracts them but never executes them,
// so a freshly loaded database runs every query as a sequential scan.
// Idempotent: IF NOT EXISTS is injected; rerunning is safe.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const dump = readFileSync("houzs-d1-full.sql", "utf8");
// CREATE INDEX statements can span multiple lines in the dump — accumulate
// from the CREATE line until the terminating semicolon.
const lines = dump.split("\n");
const raw = [];
let buf = null;
for (const ln of lines) {
  const t = ln.trim();
  if (buf === null && /^CREATE (UNIQUE )?INDEX/i.test(t)) buf = t;
  else if (buf !== null) buf += " " + t;
  if (buf !== null && /;\s*$/.test(buf)) {
    raw.push(buf);
    buf = null;
  }
}
const stmts = raw.map((l) =>
  l
    .replace(/;\s*$/, "")
    // PG has no NOCASE collation; dropping it keeps the index usable.
    .replace(/\s+COLLATE\s+NOCASE/gi, "")
    .replace(/^CREATE INDEX (?!IF NOT EXISTS)/i, "CREATE INDEX IF NOT EXISTS ")
    .replace(/^CREATE UNIQUE INDEX (?!IF NOT EXISTS)/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
);

console.log(`applying ${stmts.length} index statements...`);
let ok = 0;
const failed = [];
for (const s of stmts) {
  try {
    await pg.unsafe(s);
    ok++;
  } catch (e) {
    failed.push({ sql: s.slice(0, 120), err: e.message.slice(0, 120) });
  }
}
console.log(`indexes applied: ${ok}/${stmts.length}`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ${f.err}\n    ${f.sql}`);
}
const [{ n }] = await pg`
  SELECT count(*)::int AS n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'`;
console.log(`PG non-PK indexes now: ${n}`);
await pg.end();
process.exit(failed.length ? 1 : 0);

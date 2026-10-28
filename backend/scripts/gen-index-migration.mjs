// One-shot: extract every CREATE INDEX from the D1 dump and emit a single
// idempotent, tracked Postgres migration (0002_indexes.sql). This folds the
// 194 B-tree indexes — previously applied only by an ad-hoc script — into the
// versioned migration history so a fresh DB build is complete + reproducible.
import { readFileSync, writeFileSync } from "node:fs";

const dump = readFileSync("houzs-d1-full.sql", "utf8");
const lines = dump.split("\n");
const raw = [];
let buf = null;
for (const ln of lines) {
  const t = ln.trim();
  if (buf === null && /^CREATE (UNIQUE )?INDEX/i.test(t)) buf = t;
  else if (buf !== null) buf += " " + t;
  if (buf !== null && /;\s*$/.test(buf)) { raw.push(buf); buf = null; }
}
const stmts = raw
  .map((l) =>
    l
      .replace(/;\s*$/, "")
      .replace(/\s+COLLATE\s+NOCASE/gi, "")
      .replace(/^CREATE INDEX (?!IF NOT EXISTS)/i, "CREATE INDEX IF NOT EXISTS ")
      .replace(/^CREATE UNIQUE INDEX (?!IF NOT EXISTS)/i, "CREATE UNIQUE INDEX IF NOT EXISTS "),
  )
  .sort();

const header = `-- 0002_indexes.sql — all B-tree indexes carried over from the D1 schema.
-- Generated from the D1 export (scripts/gen-index-migration.mjs). Every
-- statement is IF NOT EXISTS so this is safe to re-run / apply to a DB that
-- already has the indexes. Keep this in the tracked migration history so a
-- fresh load (loader builds tables, pg-migrate applies this) is fully indexed
-- and never silently sequential-scans. ${stmts.length} indexes.\n\n`;
writeFileSync("src/db/migrations-pg/0002_indexes.sql", header + stmts.join(";\n") + ";\n");
console.log(`wrote src/db/migrations-pg/0002_indexes.sql with ${stmts.length} indexes`);

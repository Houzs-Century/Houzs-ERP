// The drizzle-kit export is a point-in-time snapshot of 2990's schema.ts, but
// some columns are added only in the migration ledger (the team adds a column
// via migration and doesn't always backport it to schema.ts) — e.g.
// supplier_material_bindings.is_cost_anchor (0177). Those columns are missing
// from the scm tables, so the ported routes 500 with "column X does not exist".
//
// This back-fills EVERY migration-added column into scm idempotently: it scans
// all 2990's migrations in order, pulls out the pure ADD COLUMN ALTER statements,
// rewrites each `ADD COLUMN` -> `ADD COLUMN IF NOT EXISTS`, and applies them to
// scm (search_path = scm, public). IF NOT EXISTS makes already-present columns a
// no-op; per-statement try/catch logs (and skips) anything that references a
// table/type not in scm. Tables are near-empty (fresh clone) so NOT NULL adds
// are fine.
//
//   node scripts/scm-schema/apply-scm-column-backfill.mjs
import { readFileSync, readdirSync } from "node:fs";
import postgres from "postgres";

const MIG_DIR = "C:/Users/User/Desktop/2990s/packages/db/migrations";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

// Pull pure ADD COLUMN statements: ALTER TABLE ... that ONLY adds columns (no
// constraint/type/rename/drop actions, which carry FK + drift risk and aren't
// needed for the read paths). Split a migration on ";\n", strip line comments.
function extractAddColumnStmts(body) {
  return body
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean)
    .filter((s) => /^alter\s+table\s+/i.test(s))
    .filter((s) => /\badd\s+column\b/i.test(s))
    // pure add-column only — skip mixed statements (constraints/fks/type changes)
    .filter((s) => !/\b(add\s+constraint|add\s+(primary|foreign|unique)|alter\s+column|drop\s+|rename\s+|using\s+btree)\b/i.test(s))
    // make every ADD COLUMN idempotent
    .map((s) => s.replace(/\badd\s+column\s+(?!if\s+not\s+exists)/gi, "ADD COLUMN IF NOT EXISTS "));
}

const files = readdirSync(MIG_DIR).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
let applied = 0, failed = 0;
const fails = [];
try {
  await sql.unsafe(`SET search_path TO scm, public`);
  for (const f of files) {
    const body = readFileSync(`${MIG_DIR}/${f}`, "utf8");
    for (const stmt of extractAddColumnStmts(body)) {
      try {
        await sql.unsafe(stmt + ";");
        applied++;
      } catch (e) {
        failed++;
        const t = stmt.match(/alter\s+table\s+"?(?:public"?\.")?"?([a-z_][a-z0-9_]*)"?/i)?.[1] ?? "?";
        fails.push(`${f} :: ${t} -> ${String(e?.message || e).slice(0, 110)}`);
      }
    }
  }
  console.log(`ADD COLUMN statements: ${applied} applied (idempotent), ${failed} failed`);
  if (fails.length) {
    console.log("\nFAILURES (skipped — table/type not in scm, expected for unported modules):");
    // De-dupe by table for readability
    const seen = new Set();
    for (const x of fails) {
      const key = x.split("->")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      console.log("  " + x);
    }
  }
  // Spot-check the column that triggered this.
  const chk = await sql`select column_name from information_schema.columns where table_schema='scm' and table_name='supplier_material_bindings' and column_name='is_cost_anchor'`;
  console.log(`\nsupplier_material_bindings.is_cost_anchor present: ${chk.length > 0 ? "YES" : "NO"}`);
} catch (err) {
  console.error("BACKFILL FAILED:", String(err?.message || err).slice(0, 300));
  process.exitCode = 2;
}
await sql.end();

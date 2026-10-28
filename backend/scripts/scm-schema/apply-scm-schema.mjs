// Build the 2990's SCM schema inside Houzs's Supabase, in a dedicated `scm`
// Postgres schema (avoids name collisions with Houzs's own public.* tables;
// supabase-js client uses { db: { schema: 'scm' } } so route code is unchanged).
//
// Idempotent: drops + recreates the `scm` schema each run. Houzs's `public`
// schema (the live app) is never touched. The 2990's export is self-contained
// (all 140 FKs resolve internally; zero auth/cross-schema refs).
//
//   node scripts/scm-schema/apply-scm-schema.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const dv = readFileSync(".dev.vars", "utf8");
const url = dv.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, "");
if (!url) { console.error("DATABASE_URL missing in .dev.vars"); process.exit(1); }

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });

let ddl = readFileSync("scripts/scm-schema/2990s-full-schema.sql", "utf8");
// Re-target the whole export from public -> scm. The export fully qualifies
// every table / enum / FK as "public"."x", so this single rewrite is total.
ddl = ddl.replaceAll('"public".', '"scm".');

const stmts = ddl
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`applying ${stmts.length} statements into schema "scm" ...`);
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS scm CASCADE`);
    await tx.unsafe(`CREATE SCHEMA scm`);
    // The export's CREATE TABLE / ALTER are UNQUALIFIED (only enums + FK targets
    // carry "public"., which the rewrite moved to "scm".). search_path puts the
    // unqualified DDL into scm too; public stays for builtins/extensions.
    await tx.unsafe(`SET LOCAL search_path TO scm, public`);
    for (const s of stmts) await tx.unsafe(s);
  });
  const t = await sql`select count(*)::int c from information_schema.tables where table_schema='scm'`;
  const e = await sql`select count(*)::int c from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='scm' and t.typtype='e'`;
  console.log(`DONE — scm schema: ${t[0].c} tables, ${e[0].c} enums.`);
} catch (err) {
  console.error("APPLY FAILED:", String(err?.message || err).slice(0, 400));
  process.exitCode = 2;
}
await sql.end();

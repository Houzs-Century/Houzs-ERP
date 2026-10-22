// Read-only report: which id counters stand at or below their table's highest
// id. Such a counter makes the app's next insert into that table raise
// duplicate key on the primary key, which the operator sees as "Something went
// wrong processing that request." — and any statement the same request ran
// before it has already committed.
//
// How a counter falls behind: rows written with explicit ids (SQL run by hand,
// a copy between databases) do not move it. Seen on audit_events (three audit
// rows lost, 2026-10-19) and sales_reps (member Save blocked, 2026-10-21; fixed
// by migration *_realign_id_counters.sql).
//
// Run with Actions -> "Run a backend script on production", script
// check-id-counters.mjs, mode plan. Strictly SELECTs on catalogs, tables and
// sequences. Exits 0 for every real answer, including "none behind"; only an
// unreachable database exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // Same population as the migration that realigns them: every serial or
  // identity column outside the Supabase-managed schemas.
  const counters = await pg`
    SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col,
           pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) AS seq
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid AND c.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE a.attnum > 0 AND NOT a.attisdropped
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'auth', 'storage', 'realtime',
                             'supabase_functions', 'supabase_migrations', 'extensions', 'graphql',
                             'graphql_public', 'pgsodium', 'vault', 'net', 'cron', 'pgbouncer')
       AND n.nspname NOT LIKE 'pg\\_%'
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
     ORDER BY 1, 2, 3`;

  let behind = 0;
  for (const k of counters) {
    const [{ mx }] = await pg.unsafe(`SELECT max(${ident(k.col)}) AS mx FROM ${ident(k.schema)}.${ident(k.tbl)}`);
    const [s] = await pg.unsafe(`SELECT last_value, is_called FROM ${k.seq}`);
    const next = s.is_called ? Number(s.last_value) + 1 : Number(s.last_value);
    if (mx != null && next <= Number(mx)) {
      behind++;
      notice(`BEHIND ${k.schema}.${k.tbl}.${k.col}: next id ${next}, table max ${mx} -> up to ${Number(mx) - next + 1} insert(s) without an explicit id fail`);
    }
  }
  notice(`${counters.length} id counters checked, ${behind} behind their table.`);
} finally {
  await pg.end({ timeout: 5 });
}

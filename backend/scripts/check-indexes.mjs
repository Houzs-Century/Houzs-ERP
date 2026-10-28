// Quick check: how many indexes exist in the live Supabase vs the D1 dump.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const [{ n: pgIndexes }] = await pg`
  SELECT count(*)::int AS n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname NOT LIKE '%_pkey'`;
const [{ n: pgTables }] = await pg`
  SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;

const dump = readFileSync("houzs-d1-full.sql", "utf8");
const dumpIndexes = (dump.match(/CREATE INDEX/gi) || []).length
  + (dump.match(/CREATE UNIQUE INDEX/gi) || []).length;

console.log(`PG tables: ${pgTables}`);
console.log(`PG non-PK indexes: ${pgIndexes}`);
console.log(`Dump CREATE INDEX statements: ${dumpIndexes}`);
await pg.end();

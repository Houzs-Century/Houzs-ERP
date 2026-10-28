// D1 -> Supabase cutover: the live database is now Postgres, so the Drizzle
// schema is the pg-core one. Routes import tables from "../db/schema" — keep
// that path working by re-exporting the Postgres schema. The original
// SQLite (sqlite-core) definitions remain in git history for rollback.
//
// Follow-up: regenerate schema.pg.ts from the live tables with
// `drizzle-kit pull` so column types exactly match what load-d1-dump-to-pg.mjs
// created (bigint / identity), then this file can re-export the generated one.
export * from "./schema.pg";

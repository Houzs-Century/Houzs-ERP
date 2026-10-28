import type { Config } from "drizzle-kit";

/**
 * Postgres drizzle-kit config for the D1 -> Supabase migration.
 * `generate` (schema -> SQL DDL) needs no DB connection; `push`/`migrate`
 * read DATABASE_URL from .dev.vars at run time. Kept separate from the
 * legacy sqlite drizzle.config.ts until cutover.
 */
export default {
  schema: "./src/db/schema.pg.ts",
  out: "./src/db/migrations-pg",
  dialect: "postgresql",
} satisfies Config;

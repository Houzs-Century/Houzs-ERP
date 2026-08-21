import type { Config } from "drizzle-kit";

/**
 * READ-ONLY introspection config: `drizzle-kit pull` regenerates
 * src/db/schema.pg.ts from the LIVE database.
 *
 * WHY IT EXISTS. schema.pg.ts was hand-ported from the SQLite schema at the
 * Postgres cutover and its own header still says "DRAFT ... UNTESTED until
 * validated with drizzle-kit against the live Supabase DB". db/schema.ts
 * carries the same follow-up. Nobody did it, and by 2026-08-21 the file was
 * missing project_brands.company_id (mig 0093) and logo_r2_key (mig 0069) and
 * declaring a UNIQUE on project_brands.name that production does not have. A
 * drizzle read cannot name a column the schema does not know about, so both
 * company-scope checkers were blind to the brand-letterhead leak.
 *
 * `pull` only reads the catalog — it never writes to the database, and the
 * repo's rule stands: drizzle-kit is for type generation and schema diffing,
 * NEVER as the migration runner. The .sql files in src/db/migrations-pg remain
 * the only thing that changes production.
 *
 * casing "preserve" is load-bearing: the default camel-cases every identifier,
 * which would rename all 49 table exports and every column key and rewrite
 * hundreds of call sites for no gain. Preserve keeps `project_brands` and
 * `logo_r2_key` exactly as the database spells them.
 *
 * tablesFilter is the artifact's own table list, kept in sync by
 * scripts/gen-pull-table-filter.mjs. The public schema holds far more than the
 * app models; pulling all of it would import tables no code touches.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for `drizzle-kit pull`.");

export default {
  schema: "./src/db/schema.pg.ts",
  out: "./drizzle-pull",
  dialect: "postgresql",
  dbCredentials: { url },
  schemaFilter: ["public"],
  introspect: { casing: "preserve" },
} satisfies Config;

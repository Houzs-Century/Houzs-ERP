import type { Config } from "drizzle-kit";

/**
 * drizzle-kit config. We use it for type generation and ad-hoc schema
 * diffing, not as the migration runner — raw .sql files in
 * src/db/migrations/ remain authoritative and are applied via the
 * `db:migrate` npm script.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/drizzle-out",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;

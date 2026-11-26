import { drizzle } from "drizzle-orm/postgres-js";
import type { SQLWrapper } from "drizzle-orm";
import type { Env } from "../types";
import { getSql, resolveDatabaseUrl } from "./pg";
import * as schema from "./schema.pg";

/**
 * Drizzle client over Supabase Postgres (postgres.js). Built per request —
 * postgres.js sockets can't cross the Worker request boundary, and Hyperdrive
 * pools the connection, so a fresh client per call is cheap.
 *
 * Coexists with raw SQL during the cutover: `env.DB` is injected with a
 * D1-compatible shim over the SAME Postgres (see middleware/db.ts), so the
 * legacy `env.DB.prepare(...)` paths and Drizzle paths hit one database.
 */
export function getDb(env: Env) {
  const db = drizzle(getSql(resolveDatabaseUrl(env)), { schema });
  return Object.assign(db, {
    async get<T extends Record<string, unknown> = Record<string, unknown>>(
      query: SQLWrapper | string,
    ): Promise<T> {
      const rows = await db.execute<T>(query);
      return rows[0] as T;
    },
  });
}

export type DB = ReturnType<typeof getDb>;
export { schema };

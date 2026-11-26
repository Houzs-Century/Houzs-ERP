import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import { getSql, resolveDatabaseUrl } from "../db/pg";
import { d1Compat } from "../db/d1-compat";

/**
 * D1 -> Supabase cutover glue. Replaces `env.DB` with a D1-compatible shim
 * over Postgres so the ~685 existing `env.DB.prepare(...).bind(...).all()`
 * call sites run against Supabase with no per-call changes. The shim also
 * rewrites the SQLite-isms (datetime('now'), char()) in query text.
 *
 * Mounted FIRST (before auth + routes) so every handler — including the
 * unauthenticated /api/auth, /api/survey, /api/track routes — gets Postgres.
 */
export const dbInject = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const url = resolveDatabaseUrl(c.env);
  if (!url) return next();
  c.env = { ...c.env, DB: d1Compat(() => getSql(url)) as unknown as D1Database };
  await next();
});

/**
 * Same swap for the cron path, which calls services with the raw Worker `env`
 * (no Hono context). Wrap once at the top of `scheduled`, pass the result down.
 */
export function withPgDb(env: Env): Env {
  const url = resolveDatabaseUrl(env);
  if (!url) return env;
  return { ...env, DB: d1Compat(() => getSql(url)) as unknown as D1Database };
}

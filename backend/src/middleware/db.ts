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
  // No HYPERDRIVE binding and no DATABASE_URL → leave the bound D1 in place.
  // This keeps the rollback path alive (drop [[hyperdrive]], D1 still bound →
  // app keeps serving instead of 500ing on getSql("")), and lets vitest run
  // against its isolated migrated D1 instead of a live Postgres.
  const url = resolveDatabaseUrl(c.env);
  if (!url) return next();
  // Build per request, do NOT .end() it: the socket is to Hyperdrive's local
  // proxy (cheap) and Hyperdrive owns origin-side pooling. Closing per request
  // caused connection churn/exhaustion on 2026-06-13. Matches Hookka's config.
  //
  // CRITICAL — assign a NEW per-request env object; do NOT mutate the shared
  // `c.env` (the old `c.env.DB = ...`). Workers serves many requests
  // concurrently in ONE isolate that all share the same env object, so mutating
  // it lets a later request clobber an in-flight request's DB client: a handler
  // resuming after an await (e.g. the 12s cold-start hang) then touches a socket
  // opened in ANOTHER request's context -> "Cannot perform I/O on behalf of a
  // different request" 500s (intermittent, every page, worse the more staff are
  // online). Spreading into a fresh object — exactly what withPgDb() already
  // does for the cron path — isolates each request's client to its own context.
  c.env = { ...c.env, DB: d1Compat(() => getSql(url)) as unknown as D1Database };
  await next();
});

/**
 * Same swap for the cron path, which calls services with the raw Worker `env`
 * (no Hono context). Wrap once at the top of `scheduled`, pass the result down.
 */
export function withPgDb(env: Env): Env {
  const url = resolveDatabaseUrl(env);
  if (!url) return env; // same fallback as dbInject: cron stays on bound D1
  return { ...env, DB: d1Compat(() => getSql(url)) as unknown as D1Database };
}

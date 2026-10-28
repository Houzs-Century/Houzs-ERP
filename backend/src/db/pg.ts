// ---------------------------------------------------------------------------
// Supabase Postgres client for Cloudflare Workers (D1 -> Postgres migration).
//
// Ported from the proven Hookka ERP connection layer, adapted for Houzs:
//   - Houzs reads columns as snake_case everywhere (row.password_hash,
//     row.role_id), so we DO NOT apply the camelCase column transform that
//     Hookka needs. postgres.js returns columns as-named by default, which
//     already matches Houzs app code. (If a route ever expects camelCase,
//     fix the route, do not flip a global transform — it would break the
//     other 600+ snake_case readers.)
//   - bigint -> Number coercion is KEPT. It is universal: COUNT(*), SUM()
//     and BIGSERIAL ids come back as JS strings by default, and string
//     math silently corrupts totals (Hookka's real "029014" = 290 + 4 bug).
//
// Connection model:
//   - Prod (Cloudflare Workers): Hyperdrive sits in front of Supabase's
//     Supavisor transaction-mode pooler. The Worker gets a warm pooled
//     connection with no TCP/TLS handshake cost per request.
//   - Local dev / scripts: connect directly to the Supavisor pooler URL
//     from .dev.vars (DATABASE_URL).
//
// HARD-WON RULES (do not "optimize" these without reading why):
//   * prepare: false  -- the transaction-mode pooler (port 6543) does NOT
//     support prepared statements. With prepare:true every query 500s with
//     a Parse/Bind protocol rejection. (Hookka bug, 2026-04-27.)
//   * Hyperdrive branch: NO `ssl` option -- Hyperdrive terminates TLS
//     origin-side; the driver must not negotiate TLS itself.
//   * Hyperdrive branch: NO `connect_timeout` -- under DB load a 10s cap
//     turns slow-but-working queries into fast-fail 500s and blanks lists
//     (operator sees "all data gone" when rows are intact). Hookka shipped
//     this as an emergency revert, 2026-06-04. Fix slow queries, not by
//     capping the connection.
//   * Never cache the client across requests in a Worker: a socket opened
//     in one request cannot be used by another ("Cannot perform I/O on
//     behalf of a different request"). Build per request -- it is cheap.
//
// Usage from a route (raw SQL via postgres.js tagged template):
//     import { getSql } from "../db/pg";
//     const sql = getSql(c.env.DATABASE_URL);
//     const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
//
// Usage from a route (Drizzle): see db/client.ts getDb(), which will be
// repointed to drizzle-orm/postgres-js over this same getSql().
// ---------------------------------------------------------------------------
import postgres, { type Sql } from "postgres";

// Coerce Postgres BIGINT (int8, OID 20) from string to JS Number. Safe up to
// 2^53; every bigint in this schema (counts, *_sen sums, bigserial ids) is
// bounded well under that. Re-evaluate only if a single table's row count or
// a money sum could approach 9e15.
const bigintAsNumber = {
  to: 20,
  from: [20],
  parse: (x: string) => Number(x),
  serialize: (x: number | string) => String(x),
};

/**
 * Returns a fresh postgres.js client for the given connection URL.
 *
 * Detects a Hyperdrive-backed URL by its `*.hyperdrive.local` host. In prod
 * the Worker reads `c.env.HYPERDRIVE.connectionString`; locally it reads the
 * direct Supabase pooler URL from `c.env.DATABASE_URL`.
 */
export function getSql(databaseUrl: string): Sql {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL / HYPERDRIVE.connectionString is empty. " +
        "Set DATABASE_URL in .dev.vars (local) or bind HYPERDRIVE (prod).",
    );
  }

  const isHyperdrive = /hyperdrive\.local/i.test(databaseUrl);

  return isHyperdrive
    ? postgres(databaseUrl, {
        // max:1 — one socket per request; Hyperdrive pools origin-side.
        // Higher values risk "Cannot perform I/O on behalf of a different
        // request" when postgres.js keeps pool sockets past the request
        // boundary. This matches Hookka's months-proven prod config — do
        // NOT add max>1, .end()-per-request, or query retries: each caused
        // connection churn/exhaustion when tried 2026-06-13.
        max: 1,
        prepare: false, // transaction pooler: no prepared statements
        fetch_types: false,
        idle_timeout: 0,
        // NO connect_timeout here -- see header note (2026-06-04 incident).
        types: { bigint: bigintAsNumber },
      })
    : postgres(databaseUrl, {
        // Direct Supavisor pooler (local dev / migration scripts).
        ssl: "verify-full", // validate cert chain AND hostname (anti-MITM)
        prepare: false,
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        fetch_types: false,
        types: { bigint: bigintAsNumber },
      });
}

/** Resolve the live connection string from the Worker env, prod or local.
 *  DATABASE_URL wins when present — an explicit empty string means "no
 *  Postgres" (vitest pins it to keep the suite on its isolated D1 even
 *  though the wrangler.toml hyperdrive binding exists). Prod sets neither
 *  var and falls through to the Hyperdrive binding. */
export function resolveDatabaseUrl(env: {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}): string {
  return env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? "";
}

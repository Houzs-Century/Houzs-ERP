import { createClient } from "@supabase/supabase-js";
import type { Env } from "../types";
import { recordStep } from "../lib/step-timing";

/**
 * supabase-js / PostgREST client for the SCM modules ported from 2990's.
 *
 * The rest of Houzs talks to Postgres via Drizzle over Hyperdrive. The ported
 * 2990's SCM routes talk to the SAME Supabase database via its REST API
 * (PostgREST) using supabase-js — one database, two access paths. This mirrors
 * how 2990's itself runs (server-side, service-role key, RLS bypassed).
 *
 * Config (set on the Worker; never commit the keys):
 *   SUPABASE_URL               = https://<project-ref>.supabase.co
 *   wrangler secret put SUPABASE_SERVICE_ROLE_KEY
 *   wrangler secret put SUPABASE_ANON_KEY
 */

function requireConfig(env: Env): { url: string; serviceKey: string } {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase REST not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY " +
        "(SUPABASE_URL var + `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`).",
    );
  }
  return { url, serviceKey };
}

/* Transient-retry wrapper for the SCM PostgREST calls. supabase-js uses the
   global fetch, which has NO retry — a cold/blip on the Supabase REST edge would
   surface as an error where a retry would have succeeded (the same transient
   class the d1-compat path already retries for env.DB). Conservative to avoid
   double-writes: retry when the request almost certainly never reached the
   server — a network THROW (any method; nothing applied) and a 502/503/504
   gateway status on GET (idempotent). A 5xx on a write is returned as-is so a
   possibly-applied mutation is never re-sent. Up to 3 retries with backoff. */
const REST_RETRIES = 3;
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(input, init);
      // Per request: how many REST round trips and their summed time (Server-Timing s-db-rest).
      recordStep("db-rest", Date.now() - t0);
      if ((res.status === 502 || res.status === 503 || res.status === 504) && method === "GET" && i < REST_RETRIES) {
        await new Promise((r) => setTimeout(r, 300 + i * 500));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < REST_RETRIES) {
        await new Promise((r) => setTimeout(r, 300 + i * 500));
        continue;
      }
      throw lastErr;
    }
  }
}

/**
 * Service-role client (full access, RLS bypassed) for the server-side SCM route
 * handlers. Built per request — a Worker request boundary can't share a client.
 */
/** Service-role client scoped to the `scm` schema (see below). */
export function getSupabaseService(env: Env) {
  const { url, serviceKey } = requireConfig(env);
  return createClient(url, serviceKey, {
    // Retry transient REST-edge blips (see retryingFetch) so an SCM page doesn't
    // error on a hiccup that a retry clears — parity with the env.DB retry path.
    global: { fetch: retryingFetch },
    // The ported 2990's SCM tables live in a dedicated `scm` Postgres schema
    // (kept apart from Houzs's own public.* tables, which carry different
    // AutoCount-named tables — warehouses / purchase_orders / etc.). Pointing
    // the default schema here means the ported route code's `sb.from('x')`
    // calls resolve to `scm.x` unchanged.
    db: { schema: "scm" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when the Supabase REST keys are present (used to gate the SCM routes). */
export function isSupabaseConfigured(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

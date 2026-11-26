import { createClient } from "@supabase/supabase-js";
import type { Env } from "../types";
import { recordStep } from "../lib/step-timing";


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

const REST_RETRIES = 3;
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(input, init);
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
    global: { fetch: retryingFetch },
    db: { schema: "scm" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when the Supabase REST keys are present (used to gate the SCM routes). */
export function isSupabaseConfigured(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

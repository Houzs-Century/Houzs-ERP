// ----------------------------------------------------------------------------
// bridge-2990-command — the USER-JWT bridge for the SO-amendment write-back
// (design docs/2990-mirror-full-design.md §3.2, D2).
//
// WHY THIS IS A SEPARATE FILE FROM bridge-2990.ts, AND MUST STAY ONE.
// bridge-2990.ts is the DIRECT writer for exactly one table
// (public.maintenance_config_history) using 2990's SERVICE-ROLE key. That works
// there because that endpoint is an RBAC check plus a plain INSERT — no apply
// engine to reuse (its header argues this at length; read it, do not merge the
// two).
//
// This path is the opposite case. It calls 2990's OWN API
// (PATCH /so-amendments/:id/{approve-so,approve-po,send,reject,supplier-confirm}),
// because behind each of those endpoints is applySoAmendment / reviseBoundPo —
// snapshot + line diff + honest-pricing recompute + delivery-fee re-derive +
// revision bump. We must run THAT, not a row write, or we fork the pricing
// engine.
//
// And 2990's API gates on a real user: middleware/auth.ts verifies the bearer
// token via GoTrue /auth/v1/user, then every amendment gate calls
// isApproveSoCaller(sb, user.id) which looks up public.staff WHERE id = user.id.
// The SERVICE-ROLE key carries NO user identity — user.id would be undefined and
// every RBAC check would fail. So this bridge MUST authenticate as a real 2990
// Supabase auth user (BRIDGE_2990_EMAIL / BRIDGE_2990_PASSWORD) that has a
// public.staff row with an approve-capable role (coordinator / showroom_lead /
// admin+). The service-role key is deliberately NOT imported here.
//
// WHAT IS REUSED from bridge-2990.ts: the GoTrue host (BRIDGE_2990_SUPABASE_URL)
// and the createClient shape. WHAT DIFFERS: the credential (a user
// email/password sign-in, not a service key) and the transport (an HTTPS call to
// 2990's API, not a supabase-js table write). That difference is the whole point
// of D2 and is stated here so no future edit collapses the two paths.
//
// The JWT is cached for the isolate lifetime and refreshed on a 401 — a Worker
// isolate is short-lived, so this is a per-isolate memo, not a durable store.
// ----------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import type { AmendAction } from '../shared';

export interface BridgeCommandConfig {
  // GoTrue host — the same Supabase project URL bridge-2990.ts reads. The token
  // exchange hits ${supabaseUrl}/auth/v1/token.
  supabaseUrl: string;
  // The project anon key, used as supabase-js's key for signInWithPassword. This
  // is NOT the service-role key: it grants no identity of its own; the identity
  // comes from the email/password sign-in.
  anonKey: string;
  // 2990's API base — the origin (and any /api prefix) that reaches the Hono
  // soAmendments router. The dispatcher appends `/so-amendments/:id/:action`.
  // Kept as a whole base so it is deployment-agnostic (custom domain vs *.workers.dev).
  apiBase: string;
  email: string;
  password: string;
}

export type BridgeCommandConfigResult =
  | { ok: true; config: BridgeCommandConfig }
  | { ok: false; missing: string[] };

// All five secrets are required: a half-configured bridge must not half-work.
// With any of them unset the write-back cannot reach 2990 at all — which is how
// this feature ships dark (alongside the DB kill switch), on the strength of an
// absent secret, with no follow-up data step to forget.
export function readBridgeCommandConfig(env: Env): BridgeCommandConfigResult {
  const raw = {
    BRIDGE_2990_SUPABASE_URL: env.BRIDGE_2990_SUPABASE_URL,
    BRIDGE_2990_ANON_KEY: env.BRIDGE_2990_ANON_KEY,
    BRIDGE_2990_API_URL: env.BRIDGE_2990_API_URL,
    BRIDGE_2990_EMAIL: env.BRIDGE_2990_EMAIL,
    BRIDGE_2990_PASSWORD: env.BRIDGE_2990_PASSWORD,
  };
  const missing = Object.entries(raw)
    .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      supabaseUrl: raw.BRIDGE_2990_SUPABASE_URL!.replace(/\/+$/, ''),
      anonKey: raw.BRIDGE_2990_ANON_KEY!,
      apiBase: raw.BRIDGE_2990_API_URL!.replace(/\/+$/, ''),
      email: raw.BRIDGE_2990_EMAIL!,
      password: raw.BRIDGE_2990_PASSWORD!,
    },
  };
}

export class BridgeCommandError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.name = 'BridgeCommandError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Isolate-lifetime JWT memo (§3.2 "cached for the isolate lifetime"). Keyed by
// email so a secret rotation to a different bridge user does not serve a stale
// token. A Worker isolate is ephemeral, so this never needs durable storage or
// explicit expiry — a dead isolate drops it, and a 401 refreshes it (below).
let cachedToken: { key: string; token: string } | null = null;

async function signIn(cfg: BridgeCommandConfig): Promise<string> {
  const sb = createClient(cfg.supabaseUrl, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email: cfg.email, password: cfg.password });
  const token = data?.session?.access_token;
  if (error || !token) {
    throw new BridgeCommandError(
      'bridge_signin_failed',
      "Could not sign in to 2990 as the bridge user. Check BRIDGE_2990_EMAIL / BRIDGE_2990_PASSWORD and that the account exists in 2990.",
      502,
      error?.message ?? 'no_session',
    );
  }
  cachedToken = { key: cfg.email, token };
  return token;
}

async function getToken(cfg: BridgeCommandConfig, forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.key === cfg.email) return cachedToken.token;
  return signIn(cfg);
}

export interface BridgeResponse {
  status: number;
  // The parsed JSON body when the response was JSON, else null.
  body: Record<string, unknown> | null;
}

// One PATCH to a 2990 amendment gate, with refresh-on-401 (§3.2). Returns the
// raw status + parsed body so the dispatcher — not this transport — owns the
// 409-converged decision. A network throw becomes a 502 so the caller treats it
// as retryable (the command stays PENDING) rather than as 2990's own refusal.
export async function patchAmendmentGate(
  cfg: BridgeCommandConfig,
  amendmentId: string,
  action: AmendAction,
  body: Record<string, unknown>,
): Promise<BridgeResponse> {
  const url = `${cfg.apiBase}/so-amendments/${encodeURIComponent(amendmentId)}/${action}`;

  const call = async (token: string): Promise<Response> =>
    fetch(url, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });

  let res: Response;
  try {
    res = await call(await getToken(cfg));
    // Refresh-on-401: the isolate-cached token may have expired. Sign in once
    // more and retry a single time before giving up.
    if (res.status === 401) {
      res = await call(await getToken(cfg, true));
    }
  } catch (e) {
    throw new BridgeCommandError('bridge_unreachable', "2990's API could not be reached.", 502, e instanceof Error ? e.message : String(e));
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const text = await res.text();
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

// Read-only end-to-end probe for the diagnostic route (§ "dry-run / diagnostic
// path"). Proves the two things that can only be verified once the bridge
// account exists: (1) the email/password sign-in yields a JWT, and (2) that JWT
// is accepted by 2990's API. Uses GET /so-amendments — a plain authed list that
// mutates NOTHING — so the owner can run it safely any number of times. Forces a
// fresh sign-in so a stale isolate token cannot mask a broken credential.
export async function probeBridge(cfg: BridgeCommandConfig): Promise<{
  signIn: boolean;
  api: { ok: boolean; status: number; count?: number };
  detail?: string;
}> {
  let token: string;
  try {
    token = await getToken(cfg, true);
  } catch (e) {
    return { signIn: false, api: { ok: false, status: 0 }, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    const res = await fetch(`${cfg.apiBase}/so-amendments`, { headers: { authorization: `Bearer ${token}` } });
    let count: number | undefined;
    try {
      const b = (await res.json()) as { amendments?: unknown };
      if (Array.isArray(b?.amendments)) count = b.amendments.length;
    } catch { /* body not JSON — leave count undefined */ }
    return { signIn: true, api: { ok: res.ok, status: res.status, count } };
  } catch (e) {
    return { signIn: true, api: { ok: false, status: 0 }, detail: e instanceof Error ? e.message : String(e) };
  }
}

// Read one amendment's current status back from 2990 (the 409-converged
// read-back, §3.2). Uses GET /so-amendments/:id, which needs only a valid JWT
// (no role gate) and mutates nothing. Returns null when the row/status can't be
// read, so the caller keeps the command retryable rather than guessing.
export async function fetchAmendmentStatus(
  cfg: BridgeCommandConfig,
  amendmentId: string,
): Promise<string | null> {
  const url = `${cfg.apiBase}/so-amendments/${encodeURIComponent(amendmentId)}`;
  const call = async (token: string): Promise<Response> =>
    fetch(url, { headers: { authorization: `Bearer ${token}` } });

  let res: Response;
  try {
    res = await call(await getToken(cfg));
    if (res.status === 401) res = await call(await getToken(cfg, true));
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { amendment?: { status?: unknown } };
    const s = body?.amendment?.status;
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

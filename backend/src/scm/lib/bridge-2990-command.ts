
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../env';
import type { AmendAction } from '../shared';

export interface BridgeCommandConfig {
  supabaseUrl: string;
  anonKey: string;
  apiBase: string;
  email: string;
  password: string;
}

export type BridgeCommandConfigResult =
  | { ok: true; config: BridgeCommandConfig }
  | { ok: false; missing: string[] };

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
  body: Record<string, unknown> | null;
}

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
    } catch { }
    return { signIn: true, api: { ok: res.ok, status: res.status, count } };
  } catch (e) {
    return { signIn: true, api: { ok: false, status: 0 }, detail: e instanceof Error ? e.message : String(e) };
  }
}

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

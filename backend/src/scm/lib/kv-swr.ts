// ----------------------------------------------------------------------------
// kv-swr — stale-while-revalidate over SESSION_CACHE KV for a heavy, read-only,
// company-scoped report. Ported from HOOKKA's `cached()` (src/api/lib/kv-cache.ts,
// Laphii, 2026-07-14) for HC-0145 (owner 2026-10-22: Procurement Overview "over a
// minute" at the afternoon peak).
//
//   - fresh (younger than softSeconds) -> served from KV, no database work;
//   - stale -> served at once, recomputed in the background (waitUntil), with a
//     short KV marker so a crowd of stale readers starts one recompute, not one
//     each;
//   - missing / hard-expired -> computed once, stored, served.
//
// A compute that FAILED is never stored. The caller supplies the key and must
// put the company in it (configCache.ts: a key that omits its scope is a
// cross-company leak); a null key bypasses the cache entirely.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import { activeCompanyId } from './companyScope';

export type SwrEnvelope<T> = { __swr: 1; v: T; soft: number; at: string };
export type SwrSource = 'fresh' | 'stale' | 'miss' | 'bypass';

const LOCK_SECONDS = 60; // KV's minimum expirationTtl

function isEnvelope<T>(x: unknown): x is SwrEnvelope<T> {
  return typeof x === 'object' && x !== null && (x as { __swr?: unknown }).__swr === 1
    && typeof (x as { soft?: unknown }).soft === 'number';
}

export async function writeSwr<T>(
  kv: KVNamespace, key: string, value: T, softSeconds: number, hardSeconds: number, now = Date.now(),
): Promise<void> {
  const env: SwrEnvelope<T> = { __swr: 1, v: value, soft: now + softSeconds * 1000, at: new Date(now).toISOString() };
  await kv.put(key, JSON.stringify(env), { expirationTtl: hardSeconds });
}

export async function cachedSwr<R>(opts: {
  kv: KVNamespace | undefined;
  key: string | null;
  softSeconds: number;
  hardSeconds: number;
  compute: () => Promise<R>;
  cacheable: (r: R) => boolean;
  waitUntil: ((p: Promise<unknown>) => void) | null;
  now?: () => number;
}): Promise<{ result: R; source: SwrSource; at: string | null }> {
  const { kv, key, compute, cacheable } = opts;
  const now = opts.now ?? Date.now;
  if (!kv || !key) return { result: await compute(), source: 'bypass', at: null };

  const store = async (r: R) => {
    if (cacheable(r)) await writeSwr(kv, key, r, opts.softSeconds, opts.hardSeconds, now());
  };
  // A failed KV write costs only the next reader a recompute; it must never fail this one.
  const storeLogged = async (r: R) => {
    try {
      await store(r);
    } catch (e) {
      console.warn(`[kv-swr] store failed for ${key}:`, (e as Error)?.message ?? e);
    }
  };

  let hit: unknown = null;
  try { hit = await kv.get(key, { type: 'json' }); } catch { hit = null; }

  if (isEnvelope<R>(hit)) {
    if (now() < hit.soft) return { result: hit.v, source: 'fresh', at: hit.at };
    if (opts.waitUntil) {
      const lockKey = `${key}:refreshing`;
      opts.waitUntil((async () => {
        try {
          if (await kv.get(lockKey)) return;
          await kv.put(lockKey, '1', { expirationTtl: LOCK_SECONDS });
          await store(await compute());
          await kv.delete(lockKey);
        } catch {
          /* keep serving the stale copy until it hard-expires */
        }
      })());
    }
    return { result: hit.v, source: 'stale', at: hit.at };
  }

  const result = await compute();
  if (opts.waitUntil) opts.waitUntil(storeLogged(result));
  else await storeLogged(result);
  return { result, source: 'miss', at: null };
}

/** What a cached report's build returns: its JSON body, or the error to send uncached. */
export type SwrBuild = { ok: true; body: unknown } | { ok: false; status: 500; body: unknown };

/**
 * A route's whole answer through cachedSwr: keyed by `family`, the active
 * company and `parts` (every input that changes the body, today's date among
 * them), with X-Cache / X-Cache-At saying which copy went out. No active
 * company = no cache. Only for a body that depends on nothing per user once the
 * route's own gates have passed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Hono route context; only env, executionCtx and the company var are read
export async function serveSwr(c: Context<any>, opts: {
  family: string;
  parts: Array<string | number>;
  softSeconds: number;
  hardSeconds: number;
  build: () => Promise<SwrBuild>;
}): Promise<Response> {
  const companyId = activeCompanyId(c);
  let waitUntil: ((p: Promise<unknown>) => void) | null = null;
  try { const ec = c.executionCtx; waitUntil = (p) => ec.waitUntil(p); } catch { waitUntil = null; }
  const { result, source, at } = await cachedSwr({
    kv: (c.env as { SESSION_CACHE?: KVNamespace }).SESSION_CACHE,
    key: companyId == null ? null : `swr:${opts.family}:v1:${companyId}:${opts.parts.join(':')}`,
    softSeconds: opts.softSeconds,
    hardSeconds: opts.hardSeconds,
    compute: opts.build,
    cacheable: (r) => r.ok,
    waitUntil,
  });
  c.header('X-Cache', source);
  if (at) c.header('X-Cache-At', at);
  return result.ok ? c.json(result.body as object) : c.json(result.body as object, result.status);
}

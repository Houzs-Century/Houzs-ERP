// Scope-keyed read cache for hot, read-mostly CONFIG endpoints.
//
// Two storage tiers, ONE invalidation mechanism:
//
//   - Cache API (caches.default) for responses shared by everyone in the SAME
//     scope — today that scope is a COMPANY (/api/branding per companyCode,
//     /api/scm/maintenance-config/resolved per active companyId). The scope
//     value is a REQUIRED parameter embedded in the synthetic cache-key URL:
//     there is no keyless overload and no default, because a cache key that
//     silently omits its scope dimension is a cross-company data leak — the
//     exact class the multi-company hardening is fighting. A caller whose
//     scope is UNRESOLVED (pre-migration / cold-start / restricted-to-nothing)
//     must BYPASS the cache entirely, never guess a scope.
//
//   - SESSION_CACHE KV for PER-USER payloads (the announcements banner),
//     keyed by user id — the inbox snapshot pattern (routes/inbox.ts).
//     Per-user data must never enter the shared Cache API.
//
// Invalidation = a monotonic VERSION SEGMENT in KV, one per family. Every
// cache key embeds the family's current version; a write path bumps the
// version, which orphans every existing entry at once (they then expire by
// their own TTL). Chosen over cache.delete() because caches.default is
// PER-COLO: a delete only purges the datacenter that ran the mutation, while
// a KV bump propagates to every colo within KV's ~60s global window — and
// immediately in the writing colo, so the editor sees their own change on the
// very next read. Worst-case staleness after a write is bounded by
// max(KV propagation, entry TTL); there is no stale-forever state.
//
// Pure optimization layer (sessionCache.ts's philosophy): every operation is
// wrapped, so KV unbound (local dev without the binding) or any KV / Cache
// API error just BYPASSES caching and serves today's DB path unchanged. On
// *.workers.dev hosts the Cache API is a documented no-op — match always
// misses, put is ignored — which degrades to the same bypass.

/** Minimal env the cache needs — structural, so both the public tree
 *  (types.ts Env) and the scm tree (scm/env.ts) can pass their own env. */
export type ConfigCacheEnv = { SESSION_CACHE?: KVNamespace };

/** One version counter per cached surface. Adding a family here is the whole
 *  registration step — the TTL table below must get a row (the Record type
 *  enforces it). */
export type ConfigCacheFamily = "branding" | "maintcfg" | "banner" | "presence";

export const CONFIG_CACHE_TTL_SECONDS: Record<ConfigCacheFamily, number> = {
  // Company identity for letterheads + shell chrome. Edited rarely, read on
  // every app load by every signed-in user.
  branding: 300,
  // Variant/pricing config feeding the SO form picklists. Kept SHORT because
  // it is pricing-adjacent — note the money itself is safe regardless: SO save
  // recomputes prices server-side from the live DB (mfg-pricing-recompute
  // reads the table directly, never this HTTP cache).
  maintcfg: 120,
  // Per-user banner snapshot. TTL MUST stay COMFORTABLY ABOVE the frontend
  // poll — do NOT lower it back to 60.
  //
  // CORRECTED 2026-09-02: this said the poll was 60s and reasoned "300s
  // (5 polls)" from it. useAnnouncementBanner.ts carries POLL_MS = 180_000, so
  // the real margin is 1.67 polls, not 5 — still above the poll, which is the
  // property that matters, but not the headroom the sentence claimed. The
  // number is no longer re-typed here to be re-checked by hand: it is mirrored
  // in services/auth-fastpath-probe.ts and PINNED against the hook's source by
  // backend/tests/authFastPathProbe.test.ts, which fails when either moves.
  // A TTL == poll means the entry expires exactly as the next poll arrives, so
  // every poll MISSES and rebuilds the full feed: measured live 2026-08-18 at
  // ~874-984ms on EVERY 60s human poll despite the "cache" being configured
  // (the neighbouring presence note records the same KV-consistency failure at
  // 15s). 300s leaves every poll landing inside a valid entry even
  // with KV propagation lag, matching `branding`. The catch this buys: the
  // banner filters by department_id/position_id/company grants (userCanSee /
  // companyCanSee), so a longer TTL would serve STALE TARGETING unless those
  // edits bust the entry — they do now, via bustBannerForUser wired into the
  // user PATCH (dept/position/role/company/status) and DELETE paths.
  banner: 300,
  // Shared who's-online row list. Short by design: presence must stay live, and
  // this rides the EDGE-cache tier (caches.default, read-your-write in the same
  // colo) NOT the KV tier — a 15s KV entry never survives KV's up-to-60s
  // negative-cache to be read back, so a shared payload this fresh only works on
  // the edge cache. Verified live: KV at 15s stayed 100% miss.
  presence: 15,
};

const VERSION_KEY_PREFIX = "cachev:";

/**
 * Current version for a family. `null` means the cache is UNUSABLE (KV unbound
 * or erroring) and the caller must bypass caching for this request — a guessed
 * version could serve an entry a bump already orphaned. A missing key is a
 * valid, stable version 0 (family never bumped since the namespace was made).
 */
export async function configCacheVersion(
  env: ConfigCacheEnv,
  family: ConfigCacheFamily,
): Promise<number | null> {
  if (!env.SESSION_CACHE) return null;
  try {
    const raw = await env.SESSION_CACHE.get(VERSION_KEY_PREFIX + family);
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Orphan every cached entry of a family. Monotonic: next = max(prev + 1, now),
 * so concurrent bumpers still land on a value that keys a FRESH namespace and
 * a clock hiccup can never move the version backwards. Best-effort — a failed
 * bump leaves the entries to their TTL expiry, never fails the mutation.
 */
export async function bumpConfigVersion(
  env: ConfigCacheEnv,
  family: ConfigCacheFamily,
): Promise<void> {
  if (!env.SESSION_CACHE) return;
  try {
    const raw = await env.SESSION_CACHE.get(VERSION_KEY_PREFIX + family);
    const prev = raw == null ? 0 : Number(raw);
    const next = Math.max(Number.isFinite(prev) ? prev + 1 : 1, Date.now());
    await env.SESSION_CACHE.put(VERSION_KEY_PREFIX + family, String(next));
  } catch {
    /* non-fatal: TTL expiry still bounds staleness */
  }
}

/**
 * Synthetic cache-key URL for the shared Cache API tier.
 *
 * `scopeKey` is the REQUIRED scope dimension — an already-encoded query
 * fragment (e.g. `co=HOUZS`, `co=2&scope=master&asOf=2026-07-19`). It must be
 * derived from the SAME resolved value the handler uses to build the response,
 * so key and payload can never disagree. An empty scopeKey returns null (the
 * caller bypasses) rather than minting a scope-less shared key.
 *
 * The origin comes from the live request URL, so distinct hostnames
 * (prod / staging / preview) can never share an entry even if they were ever
 * served from the same zone cache. The /__config-cache/ path is never routed —
 * nothing can request it into or out of the cache except this module.
 */
export function configCacheKeyUrl(
  origin: string,
  family: ConfigCacheFamily,
  scopeKey: string,
  version: number,
): string | null {
  if (!scopeKey) return null;
  return `${origin}/__config-cache/${family}?${scopeKey}&v=${version}`;
}

/** Cache API lookup. Any error reads as a miss. */
export async function configCacheMatch(keyUrl: string): Promise<Response | null> {
  try {
    const hit = await caches.default.match(keyUrl);
    return hit ?? null;
  } catch {
    return null;
  }
}

/**
 * Store a JSON body under the synthetic key. The Cache-Control header written
 * here is INTERNAL — it drives the cache entry's expiry and must never reach
 * the client (see toClientResponse). Awaited (a colo-local put is ~ms and only
 * runs on a miss) so tests are deterministic and nothing dangles past the
 * request. Best-effort.
 */
export async function configCachePut(
  keyUrl: string,
  json: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await caches.default.put(
      keyUrl,
      new Response(json, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch {
    /* non-fatal: next request just rebuilds from the DB */
  }
}

/**
 * Turn a cached internal Response into the client-facing one. Deliberately
 * REBUILDS the header set: the internal `cache-control: public, max-age=N`
 * must not escape to the browser — these endpoints are Authorization'd and
 * company-switched via the X-Company-Id header, which browser caches do not
 * key on, so advertising cacheability client-side would recreate the exact
 * cross-company staleness this key design exists to prevent. Today's live
 * responses carry no cache-control; the hit path keeps that contract.
 */
export function toClientResponse(hit: Response): Response {
  return new Response(hit.body, {
    status: 200,
    headers: {
      "content-type": hit.headers.get("content-type") ?? "application/json",
      "x-config-cache": "hit",
    },
  });
}

// ── Per-user KV tier (announcements banner) ───────────────────────────────

/**
 * The banner endpoint serves TWO per-user payloads that must never share a
 * cache entry: the POP-UP slice ("human" — human-authored posts, source IS
 * NULL) and the notification-BELL slice ("system" — machine notices, source
 * NOT NULL). The default (unscoped) request is the SAME payload as the human
 * slice, so it maps to "human" too — there are only these two distinct
 * payloads, never a third. A cache key that carried the user id but not the
 * slice would let one scope's payload answer the other; the scope is a
 * REQUIRED key dimension for exactly the reason userId is.
 */
export type BannerScope = "human" | "system";

/** Every banner scope that can hold a per-user entry — the set a per-user bust
 *  must clear, since a user's own ack / private notice can affect either. */
export const BANNER_SCOPES: readonly BannerScope[] = ["human", "system"];

/** KV key for one user's banner snapshot under the family's current version.
 *  All three parts REQUIRED — userId AND scope are both scope dimensions, and
 *  omitting the scope would collide the human and system payloads. */
export function bannerCacheKey(
  version: number,
  userId: number,
  scope: BannerScope,
): string {
  return `banner:v${version}:u${userId}:s${scope}`;
}

/**
 * Bust ONE user's banner snapshots (their own ack / a private notice targeted
 * at them) — ALL scope variants, since an ack or a private notice can land on
 * either the pop-up or the bell slice. Broadcast-shaped changes (create / edit
 * / delete / remind) must bump the `banner` family version instead — every
 * user's entry is affected. Best-effort: a failed delete falls back to the 60s
 * TTL.
 */
export async function bustBannerForUser(
  env: ConfigCacheEnv,
  userId: number,
): Promise<void> {
  if (!env.SESSION_CACHE || !userId) return;
  try {
    const version = await configCacheVersion(env, "banner");
    if (version == null) return; // nothing reachable was cached
    const kv = env.SESSION_CACHE;
    await Promise.all(
      BANNER_SCOPES.map((scope) =>
        kv.delete(bannerCacheKey(version, userId, scope)),
      ),
    );
  } catch {
    /* non-fatal */
  }
}

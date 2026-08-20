## The notification-bell banner re-queried the whole announcements table on every 60s poll, from every desktop session [medium]

<!-- area: Mail, search, notifications -->

**Symptom.** `GET /api/announcements/banner?scope=system` (the notification
bell) and `?scope=human` (the pop-up banner) are polled ~every 60s from every
desktop session. Live `[perf] slow` console logs on 2026-08-18 showed BOTH
taking ~874-1393ms every ~60s. The human slice was already cached; the system
slice was not, so the bell paid a full-table build on every poll, on every
screen, for every signed-in user.

**Root cause traced.** In `backend/src/routes/announcements.ts` the banner
handler computed `cacheKey = bannerVersion == null || systemOnly ? null : …` —
so the `scope=system` variant BYPASSED the per-user KV snapshot and ran the
live build each poll: `SELECT * FROM announcements ORDER BY created_at DESC`
(full-table) + a per-user acks query + an in-memory filter. It was assumed a
"cheap live read", but at ~900ms it is not. (The `humanOnly` half of the bypass
had already been removed in an earlier change; only the system half remained.)

**Fix.** Cache the system slice too, keyed on scope so the two per-user payloads
(human / system) can never answer each other. `bannerCacheKey(version, userId)`
gains a required `scope: BannerScope` (`"human" | "system"`) dimension — default
and `scope=human` are the identical human slice, so both map to `"human"`; only
the machine-notice bell is `"system"`. The handler now always computes a
cacheKey (keeping only the best-effort `bannerVersion == null` guard) and takes
the read-from-cache + waitUntil-fill path for both slices, exactly as the human
slice already did. The per-user bust (`bustBannerForUser`, called from an ack
and from `postPersonalNotice`) now clears BOTH scope variants for that user via
`BANNER_SCOPES`, so an ack / private notice still reflects within the poll; the
broadcast bust works unchanged because `bannerVersion` is in every key. Same
endpoint, same response shape — no surface change. TTL stays 60s (desktop poll);
mobile bell polls 30s so it may serve up to TTL-stale, the trade the human slice
already makes.

**Ref.** 2026-08-18, branch `perf/banner-scope-cache`. Tests:
`backend/tests/configCache.test.ts` (per-scope keys never collide; bust clears
all scopes) and `backend/tests/announcementsBannerFilter.test.ts` (system slice
now miss→hit, and a system entry never answers the human read).

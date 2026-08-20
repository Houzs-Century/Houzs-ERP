## The announcements banner "cache" was configured but never HIT — its TTL equalled the poll, so every 60s poll still rebuilt the whole table [medium]

<!-- area: Mail, search, notifications -->

**Symptom.** Even the HUMAN banner slice — which was already cached — was
measured live on 2026-08-18 returning ~874-984ms on EVERY ~60s poll. A cache
that truly hits is not slow on every poll. So the cache was configured but not
hitting. (This is the contradiction that showed the scope-cache fix below was
necessary but INSUFFICIENT.)

**Root cause traced — two independent causes.**

1. **TTL == poll.** `CONFIG_CACHE_TTL_SECONDS.banner` was 60s and
   `useAnnouncementBanner.ts` polls at `POLL_MS = 60_000` (60s). A 60s KV entry
   expires exactly as the next 60s poll arrives, so the poll almost always
   MISSES and rebuilds the full feed. The neighbouring `presence` note in
   `configCache.ts` already recorded the same class of failure ("KV at 15s
   stayed 100% miss") from KV's up-to-60s negative-cache + eventual consistency.

2. **Serial DB reads.** The banner handler `await`ed the announcements read and
   then the acks read sequentially, so every MISS paid ~2 round-trips (~900ms)
   instead of ~1.

**Fix.**
- Raise `CONFIG_CACHE_TTL_SECONDS.banner` to 300s (5 polls, matching
  `branding`), so a poll lands inside a valid entry even with KV propagation
  lag. Commented at the TTL definition as a MUST-exceed-poll invariant, with the
  live evidence, so nobody re-lowers it to == poll.
- Raising the TTL makes department/position/company targeting stale unless those
  edits bust the banner, so wire `bustBannerForUser` (BOTH scopes) into every
  targeting-change route: the users PATCH (a `bannerTargetingChanged` predicate
  over department_id / position_id / role_id / status / department_ids /
  company_ids), PUT `/:id/companies`, and DELETE `/:id`; and bump the banner
  family version on department DELETE (a bulk multi-user un-assign). Note the
  existing session bust was NOT enough: it fires only on disable / role change,
  while a dept-only / position-only / company-only edit changes targeting
  without touching the session.
- Parallelize the announcements + acks reads with `Promise.all` so even a MISS
  is ~1 round-trip. Behaviour-identical: both are independent reads of the same
  user, and an error in either still rejects the handler.

**Measurement.** Before: human + system ~900ms every 60s, live 2026-08-18,
`[perf]` console. Structural after: a poll now lands inside the 300s TTL (proven
by the miss->hit banner tests) and a MISS is halved by the parallel reads. A
production stopwatch is DEFERRED (owner-run probe) — not fabricated.

**Ref.** 2026-08-18, branch `perf/banner-scope-cache` (same PR as the entry
below). Tests: `backend/tests/configCache.test.ts` (TTL > poll invariant;
bustBannerForUser clears both scopes; the bust is wired into every
targeting-change route) and `announcementsBannerFilter.test.ts` (payload
unchanged through the parallelized reads).

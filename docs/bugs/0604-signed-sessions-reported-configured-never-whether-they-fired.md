## Signed sessions reported configured, never whether they fired [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** The owner asked why the ERP still feels slow. The read-only client
error dump (`client-errors-check.yml`, 3-day window, 2026-09-02) answered part of
it: `/api/presence` and `/api/announcements/banner` are **697 of 761 slow
occurrences — about 90%**, and `/api/auth/me` does not appear at all. Both slow
endpoints already cache. Nothing on any screen could say why they were still
slow, and the one number that looked relevant — System Health's *Signed
sessions: On/Off* — answers a different question than the one being asked.

I could not answer it either: `wrangler secret list` fails here because this
machine's Cloudflare login is a different account from the one running the
Worker. So the honest position was UNKNOWN, and the owner chose **B — build the
check** over guessing.

**Root cause (traced).** Two gaps, both of them "a reading of the configuration
standing in for an observation of the behaviour".

1. **Configured is not firing.** `/api/admin/health/live` reported
   `sessionSigning.configured`, and the page rendered it On/Off. A key can be set
   while every request still pays the two joined authorization reads — the pass
   may be absent, expired, or never sent. **That is `0593` exactly**: the feature
   shipped, read as working from its source, and was inert for ~95% of every
   session's life. Nothing distinguished the two states.
2. **Cache hit rates were never reported at all.** Both slow endpoints cache and
   both carry a note about a cache that silently never hits — the banner's TTL
   once equalled the frontend poll, so every poll missed and rebuilt the feed at
   **874-984ms**, which is the same order as the 800ms+ threshold these rows trip.

**Found while wiring it — a stale number of exactly the kind CLAUDE.md warns
about.** `configCache.ts` says the banner poll is 60s and reasons *"300s (5
polls)"* from it. `useAnnouncementBanner.ts` carries `POLL_MS = 180_000`, so the
real margin is **1.67 polls, not 5**. Still above the poll — the property that
matters holds — but not the headroom the comment claimed, and every later
decision reasoning from that sentence would have inherited the error.

**Fix.** `backend/src/services/auth-fastpath-probe.ts` and a `authFastPath` block
on `/api/admin/health/live`, surfaced as a second System Health card plus one
plain sentence:

* `session_pass.this_request` — `pass` / `session-db` / `unknown`, recorded by
  the auth middleware on the request in hand. `unknown` never collapses onto
  either answer.
* `config_cache` — per family, the TTL beside the browser's poll interval and
  whether the TTL can outlive it. `<=` counts as structural: a TTL *equal* to
  the poll is the measured 874-984ms case, not a near miss.
* `reading` — the one plain sentence, **derived from those numbers** rather than
  written beside them, so it cannot drift away from what was measured.

The poll intervals are mirrored from the frontend and **pinned against the hooks'
source**, so the drift found above cannot recur silently.

**What this already tells us, from the constants alone:** presence keeps its
cached copy for **15s while the browser asks every 60s**, so a lone user misses
every single poll. Asserted in the test, so the day it is fixed that test is what
says so. Whether that is the whole cause is **UNKNOWN until the probe is read on
production** — which is the point of building it rather than changing the TTL on
a hypothesis.

**Verified.** `backend/tests/authFastPathProbe.test.ts` — 9 tests. The mirror
guard was **proved RED**: changing the banner constant to 60 fails it (1 of 9),
restored green. Backend + frontend typecheck exit 0.

**UNTESTED against production** — the probe ships unread; it needs one load of
the System Health page to answer. No remedy is claimed here, only a measurement.

**Ref.** feat/auth-fastpath-probe, 2026-09-02.

# Server-side snapshot / cache playbook (build at the trigger, not before)

Decision (owner, 2026-07-14): the big-data server-side machinery — Postgres
snapshot tables, KV edge cache, single-flight, maintained counters, freshness
probes — is **deferred until a real trigger**, not built proactively. Reason: it
adds a permanent invalidation burden to every write path (the source of HOOKKA's
whole snapshot-staleness bug class) in exchange for **zero benefit while data is
small** (our endpoints are 40–330ms today). This doc is the recipe so that when a
trigger fires, the build is fast and ships with HOOKKA's hard-won guardrails from
day one.

---

## 1. Trigger — when to build a server snapshot for an endpoint

Build it for a specific endpoint only when ALL of:
- It aggregates across growing tables (AR aging, dashboard rollups, stats).
- It is measured **stable >500ms warm** under REAL production data (not cold-start;
  the `*/5` keep-warm cron already handles cold pool). Measure with the Chrome
  method used this campaign: `performance.getEntriesByType('resource')` +
  3× sequential warm fetch of the endpoint.
- Client-side caching (react-query 30min gcTime + the localStorage snapshot in
  `frontend/src/lib/query-persist.ts`) doesn't already hide it — those make warm
  AND cold *re-opens* instant; a snapshot only helps the genuinely-slow *first*
  compute and concurrent load.

First likely candidates (watch these): `/api/scm/outstanding/summary` (AR aging,
~333ms today) and the dashboard/overview rollups.

Add KV edge cache ONLY if the trigger is **concurrency** (many operators hitting
the same list at once causing repeated cold recomputes), not just single-request
latency.

---

## 2. Recipe — the snapshot, with guardrails baked in

Model on HOOKKA's `src/api/lib/snapshot.ts`. A `withSnapshot(key, sourceTables, compute)`
cache-aside helper backed by a `scm.<entity>_snapshot(company_id, cache_key, payload jsonb, built_from, refresh_count)` table.

Mandatory guardrails (each maps to a HOOKKA incident — do NOT skip):

1. **Freshness probe, epoch-normalized.** Compute `MAX(updated_at)` across
   `sourceTables` in ONE `UNION ALL` round-trip; compare `built_from >= max`
   **chronologically via `new Date(x).getTime()` on BOTH sides** — never `Date >=
   string` (their bug: mixed TEXT/TIMESTAMP `updated_at` made `'T' > ' '` so older
   beat newer → served 4-day-stale data). NaN/ambiguity → **fail toward recompute**.
2. **Schema-aware probe.** Not every table has `updated_at`; probe
   `information_schema` (cache per isolate) for which of `updated_at`/`created_at`
   exists + its type. Tables with none → covered by the nightly rebuild, skipped.
3. **DELETE on write, don't mark-stale.** Every mutation to a source table must
   `DELETE` the snapshot row (force cold recompute) — NOT set `built_from=epoch` and
   trust the probe. Their mark-stale race kept re-serving + re-caching the stale
   copy for up to a day. This is the per-write-path maintenance cost; wire it on
   EVERY create/update/void/cancel path, and add a recurring audit for missed ones.
4. **Single-flight.** Module-global `Map<key, Promise>` so concurrent cold/stale
   reads share ONE `compute()` — else the first N concurrent opens each run the full
   recompute (their "爆"/overload). Always on.
5. **Serve-stale-while-revalidate (opt-in).** With a Worker runtime + a present-but-
   stale snapshot: return the old payload now, refresh via `executionCtx.waitUntil`.
   Correctness cost: one stale read after each write — so DON'T enable it on grids
   where an edit must show immediately (use plain DELETE-recompute there).
6. **Declared fields.** Every field the grid reads must be a declared property of the
   cached payload shape; a field mutated on afterward is silently dropped by
   serialize→deserialize. Round-trip the row through `JSON.parse(JSON.stringify())`
   in a test.
7. **Cold-recompute reads the columns.** If a cold recompute SELECTs a column added
   by a runtime `ALTER … ADD COLUMN IF NOT EXISTS`, `await` that ensure-migration at
   the top of the READ handler too, not just writes (their 500 on a fresh isolate).
8. **Namespace / version.** Bump a per-org/version key on invalidation so any KV
   layer stops serving its stale body; instrument `refresh_count` + cache.hit/miss.

## 3. If adding the KV edge layer (concurrency trigger only)
- Stable body key + org **version in KV metadata**; on version mismatch serve the
  previous body with `X-Cache: STALE` and refresh in background (their newer,
  better pattern — avoids dropping every scanner onto the cold path).
- Write via `waitUntil` (non-blocking).

## 4. Explicitly do NOT
- Materialized views — HOOKKA tried 5, nobody read them, pure CPU waste; they
  dropped them for change-aware snapshots. We never adopted MVs; keep it that way.
- Proactive build across all endpoints — build per-endpoint at its trigger.

---

## Related client-side backlog (always-worth-it, being cleared separately)
From the Hookka technique-parity review, Bucket C (removed 2026-09-15, in git history). Remaining real gaps after
verification: SW cache keyed to build id (auto), weak-net asset pre-cache, FE RUM /
slow-fetch timing, verified-save readback, wider localStorage-snapshot whitelist
(needs the non-SCM pages on stable query keys first), more trgm indexes.

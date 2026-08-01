# HOOKKA ↔ Houzs — technique parity

Answers "why aren't we mirroring ALL of HOOKKA's techniques?" HOOKKA's full
perf/scale/rendering/delivery technique set (mined from their repo) mapped to
Houzs status, with a verdict for each. Three buckets: **DONE** (adopted /
equivalent), **SKIP-FOR-NOW** (big-data/high-concurrency machinery, premature at
our ~tens-of-orders scale), and **GAP** (always-worth-it, not done yet → backlog).

Key architecture divergence: HOOKKA uses **direct SQL (postgres.js)** everywhere,
so the PostgREST 1000-row cap is moot for them. Our SCM layer DOES use PostgREST
(`sb.from(...)`), so that cap is real for us (already handled via chunked `.in()`).

---

## Bucket A — DONE (adopted or equivalent)

| HOOKKA technique | Houzs status |
|---|---|
| Client localStorage SWR cache | ✅ react-query + `lib/query-persist.ts` snapshot (SCM lists) + `api/cache.ts` 15s memory. (narrower than HOOKKA — see GAP-9) |
| Per-build cache namespace (`__BUILD_ID__`) | ✅ added this campaign (snapshot key) |
| Cross-tab invalidation (BroadcastChannel) | ✅ `cross-tab-sync.ts` + `api/cache.ts` bus |
| `_headers`: `/*` no-cache HTML, `/assets/*` immutable | ✅ verified (deep SPA routes revalidate) |
| Route-level code-splitting (React.lazy) | ✅ desktop + **mobile (this campaign, #426)** |
| Heavy libs lazy (`await import` jspdf/xlsx) | ✅ |
| Manual vendor chunk splitting | ✅ `react-vendor`/`leaflet`/`lucide`/`vendor` (less granular — GAP-4) |
| `keepPreviousData` | ✅ SCM hooks `placeholderData: prev` |
| Skeleton / Suspense fallbacks | ✅ (mobile Suspense added #426) |
| Virtualization / windowing | ✅ DataGrid + **DataTable (#430)** + **mobile lists (#433/#434)** |
| SW per-resource strategy (network-first HTML, cache-first assets) | ✅ `public/sw.js` |
| SW always returns a Response (no white screen) | ✅ verified |
| Version-check auto-reload | ✅ `NewVersionBanner` (mobile reach = GAP-5b) |
| Keep-warm cron | ✅ `*/5` Hyperdrive ping |
| Hyperdrive connection pooling + tuning | ✅ pool tuned; new client per request |
| Visibility-aware singleton polling | ✅ presence deduped + notifications singleton |
| No WebSockets (polling instead) | ✅ same choice |
| No materialized views | ✅ same (never adopted) |
| Web Push | ✅ `BrowserPushSink` + push outbox |
| `waitUntil` background work | ✅ scan bg-job, email outbox |
| Field projection (`?fields=minimal`) | ❌ **NOT DONE — the mobile lists SEND it and no backend route reads it.** See the section below the buckets. |

---

## Bucket B — SKIP FOR NOW (big-data / high-concurrency; premature at our scale)

These pay off at HOOKKA's data volume + concurrent operators. At ~tens of orders
they add infra + complexity + a class of freshness bugs (HOOKKA's own snapshot
staleness incidents) for **zero current benefit**. Adopt when a specific endpoint
actually gets slow under real data — not before.

| HOOKKA technique | Why skip now / when to adopt |
|---|---|
| Server-side Postgres **snapshot tables** (`withSnapshot`) | Our aggregations are cheap on small data. **Adopt for AR aging / dashboard first** when they slow down. Follow their freshness guardrails (epoch-normalize timestamps, DELETE-on-write, single-flight, declared fields). |
| Cloudflare **KV edge body cache** (version-keyed + serve-stale) | Needs a KV namespace + per-org version keys. Only helps under concurrent load on the same list. Not our profile yet. |
| **Single-flight / stampede protection** (server) | Only matters when many operators hit the same cold recompute at once. |
| **Serve-stale-while-revalidate** (server) | Rides on snapshots (above). |
| **Freshness probes** (cross-table MAX(updated_at)) | Only exists to validate server snapshots. |
| **Maintained counter columns** (outstandingSen) | We compute balance live via the payment-totals VIEW. Fine until the view aggregation is a bottleneck. |
| In-isolate short-TTL memoization | Micro-opt for hot bursts; negligible at our volume. |
| Nightly snapshot-rebuild crons | Only needed once server snapshots exist. |

---

## Bucket C — GAP (always-worth-it, NOT done yet → backlog)

These are cheap at any scale and are HOOKKA's incident-hardening. Ranked.

> **Re-verified 2026-08-02 against the tree, and FIVE of the eleven had been
> done since the last pass — including the one ranked P1.** Each is corrected in
> place below with the evidence. This is the cost of a status list nothing forces
> anyone to revisit: the top-priority item was "SW cache keyed to build id",
> which `public/sw.js` has done for some time
> (`VERSION = "houzs-erp-v191-__SW_BUILD_ID__"`), so anyone working this backlog
> top-down would have rebuilt something that already existed.
>
> **Rule, so this stops happening: close a GAP here in the SAME PR that closes
> it in the code.** It is the same rule `CLAUDE.md` already applies to module
> guides, for the same reason. Where a status can be MEASURED instead of typed,
> measure it — GAP-10 now has `npm --prefix backend run audit:trgm`, and that
> command is the answer to "are we covered?", not this table.

1. ~~SW cache keyed to build id (auto), not a manual constant~~ **DONE** —
   `public/sw.js` reads `VERSION = "houzs-erp-v191-__SW_BUILD_ID__"`, the token
   replaced by the build, so a deploy that forgets to bump the human part still
   gets a fresh cache key. This entry claimed a hand-bumped `v174` and was ranked
   **P1**; it was the most expensive line in this file.
2. ~~purgeServiceWorkerAndCaches on chunk-load error~~ **ALREADY DONE** —
   `components/RouteFallback.tsx:ChunkReloadBoundary` unregisters every SW + deletes
   every cache before reloading, with a one-shot loop-guard. Only small belt-and-
   braces left: a WINDOW-level `vite:preloadError` + capture-phase `/assets/*` 404
   handler for a failure BEFORE React mounts (the boundary can't catch that). **P2.**
3. **Degraded-response guard** — never overwrite populated cache with an empty /
   `{success:false}` body. LOW value for us: `api/client.ts` non-2xx already throws
   (never caches), and our endpoints return raw data not `{success}` envelopes, so a
   "degraded 200" is rare. Add a light guard at `client.ts:303` if desired. **P3.**
4. ~~Atomic doc-number counter~~ **NOT A GAP — intentional.** `scm/lib/doc-no.ts`
   uses `max+1` on purpose: it self-heals a deleted-mid-month gap (reuses the freed
   number), which an ever-incrementing atomic counter cannot. The concurrent-create
   race is handled by a unique constraint + `mint()` retry (re-reads the live max).
   Considered tradeoff with an advantage over HOOKKA's counter. **No action.**
5. ~~Background pre-cache of build assets on SW install~~ **DONE** — `sw.js` has
   an `install` handler that fetches the asset list `no-store` inside
   `waitUntil` and `addAll`s it, tolerant of a 404 so one missing URL cannot fail
   the install.
6. ~~Module-preload filtering~~ **DONE** — `vite.config.ts` carries
   `modulePreload.resolveDependencies`, and its comment names this as
   "HOOKKA's resolveDependencies trick".
7. ~~Verified-save readback~~ **DONE, not dropped** — `vendor/scm/lib/verified-save.ts`
   exists, is unit-tested (`api/transportCorrelation.test.ts` covers the
   server-omits-its-echo case), and `pages/scm-v2/Products.tsx` routes its PATCH
   through it. This entry said we had dropped it.
8. ~~FE RUM / slow-fetch timing~~ **DONE** — `api/client.ts` warns on any request
   over `SLOW_FETCH_MS = 800`; its comment calls it "the 'find the next slow
   thing' signal — how this whole perf campaign started". This entry said
   "We have none".
9. **Extend the localStorage snapshot to more lists** (Projects / Service / Team)
   if they also cold-open with a spinner — same `query-persist.ts`, add to the
   whitelist. **P2.**
10. ~~More trgm GIN indexes on remaining searched columns~~ **DONE 2026-08-02**,
    and the status is now MEASURED rather than typed. `0239` covered the five
    document sources global search had been reading unindexed since PR #1269;
    `0240` covered the module LIST search boxes — supplier code/name/contact,
    the SO/DO/SI extras (debtor_code, branding, sales_location, driver_name,
    agent) and the whole consignment trio, which had never been indexed at all.
    **Do not trust this line — run the check:**

    ```
    npm --prefix backend run audit:trgm
    ```

    It diffs every `.or(...ilike...)` column in `backend/src/scm` against every
    `gin_trgm_ops` index in `migrations-pg/`, resolves views to their base table,
    and lists anything missing. At the time of writing: 54 searched columns, 52
    indexed, 2 accepted with a recorded reason, 0 missing. Deliberately not a CI
    gate (it is a static approximation, and a false positive must cost a
    conversation, never a deploy).
11. **Runtime self-applied indexes** — HOOKKA `CREATE INDEX IF NOT EXISTS` on first
    hit of a hot endpoint (deploys don't replay migrations). We auto-apply via
    pg-migrate on deploy instead, so this is **equivalent, not needed.**

---

## One Bucket A entry is wrong, and it is the interesting one

**`?fields=minimal` field projection — listed as DONE, actually a NO-OP.**
`frontend/src/mobile/MobileModuleList.tsx` appends `&fields=minimal` to seven SCM
list endpoints (delivery-orders-mfg, sales-invoices, grns, mfg-purchase-orders,
delivery-returns, purchase-invoices, purchase-returns), and **no backend code
reads a `fields` query parameter at all** — `grep -rn "query('fields')" backend/src`
returns nothing. Every one of those lists returns its full `HEADER` projection;
`sales_invoices`' is over forty columns including address, emergency contact and
every money split, at `limit=500`, to a phone.

This is HOOKKA's BUG-2026-07-13-003 ("`?fields=minimal` alone still inlined
jobCards — the slim didn't slim") in a more complete form: theirs partially
worked, ours never ran.

**Left unimplemented deliberately, 2026-08-02.** Building it means enumerating,
per endpoint, every column the mobile config reads — and an attempt to extract
that automatically already showed why that is risky: the extractor missed one
config entirely, mistook FK embeds for columns, and could not follow helpers like
`balanceCenti(r)`. Miss one column and the row renders "—", which is HOOKKA's
own BUG-2026-07-03-005/-006/-007 class, and it is only visible on a real phone —
jsdom has no layout, so no test here would catch it. That verification needs the
owner. **Until then the parameter is a lie in the URL**: either implement the
projection or delete the parameter, and this file should not claim it works.

## The short answer to "why not all?"
- The **always-worth-it** techniques: mostly already adopted (Bucket A). The rest
  are a concrete backlog (Bucket C, and as of 2026-08-02 only THREE remain real —
  see the re-verification note above).
- The **big-data machinery** (Bucket B): deliberately deferred — at ~tens of orders
  it's pure overhead and drags in HOOKKA's own snapshot-staleness bug class. It
  becomes worthwhile as data grows; the first candidate is a server snapshot for
  AR aging / the dashboard.

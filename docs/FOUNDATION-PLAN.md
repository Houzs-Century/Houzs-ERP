# Houzs ERP — Foundation Plan (post-Supabase-cutover)

Written 2026-06-13, the night the database moved from Cloudflare D1 to
Supabase Postgres via Hyperdrive. Sources: a file-level audit of Hookka ERP
(`weisiang329-eng/hookka-erp-testing`, the sibling system that did this
migration first), the issues found and fixed during the Houzs cutover
itself, and current industry practice for Postgres-backed SaaS dashboards.

Goal set by the owner: make the Houzs foundation at least as strong as
Hookka's, then push past it.

---

## 1. Where Houzs stands after tonight

| Area | State |
|---|---|
| Database | Supabase Postgres (project `xxoszhxglfgkqkokvofa`, ap-southeast-1), fronted by Hyperdrive `houzs-erp-pg` (4e820fcf). D1 still bound as rollback net, receives no traffic. |
| Data | 111 tables / 47,196 rows, row-for-row verified. Sequences continue correctly (execution_logs id 23822+ post-flip). |
| Dialect | d1-compat shim: ? -> $n, datetime/julianday/strftime/instr/char rewrites, LIKE -> ILIKE (added tonight), date(col) callsites converted to substr(col,1,10) (10 sites, tonight). |
| Indexes | 194 B-tree restored tonight (loader extracted but never applied them) + 30 pg_trgm GIN for search (migrations-pg/0001_search_trgm.sql). |
| Tests | 20/20 vitest green on isolated D1; DATABASE_URL pinned empty so the suite can never touch live Postgres. Typecheck 0 errors. |
| Rollback | Drop [[hyperdrive]] from wrangler.toml + deploy (~1 min). dbInject/withPgDb/auth now fall back to bound D1 instead of 500ing (fixed tonight; the handoff's rollback story was broken before). |
| Crons | All three schedules confirmed writing to Supabase every 5 min since the flip. |

## 2. Hookka vs Houzs — foundation comparison

| Dimension | Hookka | Houzs today | Verdict |
|---|---|---|---|
| DB migrations | 170 numbered PG files + `_migrations` tracker table + incremental idempotent runner with dry-run | Hand-numbered D1-era SQL; PG side has only a drizzle baseline + 0001_search_trgm | COPY the tracker + runner |
| Search backend | ILIKE + pg_trgm GIN on 20+ columns | Same as of tonight (shim ILIKE + 30 trgm indexes) | Parity reached tonight |
| Search frontend | Ctrl+K command palette, 250ms debounce, AbortController, recent searches in localStorage, grouped results | GlobalSearch.tsx exists; depth unknown vs Hookka's 680-line palette | Compare, then lift gaps |
| Data fetching | localStorage SWR (cached-fetch.ts, 541 lines): build-id namespacing, cross-tab BroadcastChannel invalidation, in-flight dedup, degraded-response guards | Hand-rolled useQuery hook, no shared cache, no cross-tab invalidation | COPY cached-fetch or adopt TanStack Query (see section 4) |
| Big tables | DataGrid on TanStack Table: virtualization (@tanstack/react-virtual), frozen columns, saved views, per-column value filters, localStorage column prefs | DataTable.tsx custom; no virtualization | COPY DataGrid approach for Orders/PO/ASSR lists |
| Loading UX | Skeleton system shaped like the real layout (SkeletonTable/Detail/Dashboard); lazy routes with PageSkeleton suspense fallback | Skeleton.tsx exists; panels show plain "Loading..." (Overview tonight) | Lift the shaped-skeleton pattern |
| Bundle discipline | .bundle-baseline.json per-chunk 5% budget, CI bot auto-regens, manual vendor chunks, modulePreload filter keeps PDF/XLSX out of cold start | No bundle budget, no manual chunks | COPY the CI bot + vite config |
| Observability | [req] + [slow-query] (100ms threshold) logs, W3C traceparent browser->worker, Analytics Engine metrics, Sentry, FE RUM sink | console.error only; wrangler tail observability enabled | COPY slow-query logging first (1 file), then traceparent |
| Caching | KV SWR for sessions/permissions (5 min TTL), snapshot tables for dashboards, 4 materialized views | None (every request hits PG) | KV session cache is the highest-leverage single item |
| Audit | Immutable audit_events with before/after JSON + replay engine + DLQ | Per-module activity tables (project_activity etc.) | Adopt a global audit_events; keep module feeds |
| Rate limiting | KV counter, 10 tries / 15 min on login/PIN | None | COPY (small) |
| Idempotency | X-Idempotency-Key + KV dedup on mutations | None | Adopt for POD/payment submissions |
| CI | lint + test + strict build + bundle check + canary deploy per PR + post-deploy schema verification | typecheck + test + build on main only; branch never CI'd | Extend CI to branches; add canary later |
| Error UX | error-boundary with stale-chunk auto-reload; humanized API errors | ErrorBoundary present; raw PG errors can surface (tonight's "operator does not exist" hit users) | Add an error humanizer in index.ts onError |

What Houzs already does BETTER than Hookka: per-warehouse inventory binding,
the driver mobile sub-app, public tracking portals, the permission-page
access model (mig 073), and now a cleaner single-Worker architecture
(Hookka runs Pages Functions; Houzs runs a dedicated Worker with real cron
triggers — Hookka had to move crons to GitHub Actions).

## 3. Copied tonight (done)

1. pg_trgm GIN search indexes (Hookka 0150 pattern) — 30 indexes live.
2. LIKE -> ILIKE in the shim — restores SQLite-era case-insensitive search
   across all ~685 legacy callsites; 4 unit tests.
3. Index discipline — 194 missing B-tree indexes applied; check/apply/explain
   scripts now in backend/scripts/.
4. Per-request socket close in dbInject (waitUntil) — kills the
   "Network connection lost" noise Hookka also sees.

## 4. Roadmap

### P0 — this week (stability + felt speed)

1. **Slow-query log in the shim** (~20 lines in d1-compat.ts): time every
   query, console.warn SQL + ms + rows when >100ms. Tail becomes a
   self-serve performance dashboard. (Hookka: observability.ts)
2. **PG migration tracker** : `_migrations` table + incremental runner
   (port Hookka's apply-postgres-migrations-incremental.mjs, ~150 lines).
   From now on every PG schema change is a numbered file in
   migrations-pg/ — no more ad-hoc DDL scripts.
3. **KV session + permission cache** (5 min TTL, invalidate on role edit):
   removes 1-2 PG round-trips from EVERY request — the auth middleware
   queries sessions+users+role_page_access today. Biggest single latency
   win available. (Hookka: rbac.ts + kv-cache.ts)
4. **Error humanizer** in index.ts onError: map PG error codes to operator
   messages; never show "operator does not exist: date < text" to staff.
5. **Decide D1 lockout** (owner call): remove [[d1_databases]] + deploy
   once a few quiet days pass; keep the D1 database itself ~1 week, then
   delete. Also transfer Supabase project xxoszh... into the owner's paid
   org (hello@houzscentury.com) — zero-downtime, Settings -> Transfer.

### P1 — next 2-4 weeks (felt quality)

6. **Adopt TanStack Query** for new pages + the Overview panels first
   (query-key factories, optimistic updates, background refetch), or port
   Hookka's cached-fetch.ts wholesale if staying dependency-light. Either
   ends the duplicate-fetch + stale-panel behaviour seen tonight.
7. **DataGrid upgrade**: TanStack Table + react-virtual for Orders /
   PO / ASSR / Delivery lists (Houzs lists already pull 200+ rows).
   Saved views + column prefs come almost free from Hookka's component.
8. **Shaped skeletons** on Overview/inbox panels (SkeletonDashboard).
9. **Bundle budget CI**: vite manualChunks (react-vendor/charts/icons) +
   check-bundle-size.mjs + baseline bot. Houzs ships jsPDF-equivalent and
   maps code today with zero size governance.
10. **CI on branches + post-deploy schema check** (Hookka deploy.yml).

### P2 — the "better than Hookka" layer

11. **Hybrid search ranking**: tsvector FTS for word/prefix matches ranked
    with ts_rank, falling back to trgm similarity for typos — one
    `/api/search` endpoint with unified scoring. Hookka never built
    ranking; this leapfrogs them. (Their gap list: "no ranking, no
    tsvector".)
12. **Keyset pagination** on the big lists (sales_orders is 2,695 rows and
    growing ~daily): cursor = (doc_date, id), stable under inserts,
    replaces OFFSET. Industry default for Postgres SaaS.
13. **Dashboard materialized views** (or snapshot tables) for Overview
    KPI/P&L aggregates + a refresh slot in the 0 2 * * * cron — Houzs has
    real cron triggers, so the refresh that Hookka had to bolt onto
    GitHub Actions is native here.
14. **audit_events** (immutable, before/after JSON) feeding the existing
    activity feeds; replay-ready like Hookka's.
15. **Idempotency keys + KV rate limiting** on login and the public
    POD/survey endpoints.
16. **Measure the authoritative session-read budget before optimizing it:** the
    hardened cache path deliberately performs two narrow indexed DB reads on
    every authenticated request so revocation is next-request consistent. Add
    per-query p50/p95/p99 latency, cache-hit ratio, and request-level auth time
    to the slow-query telemetry; measure production load before considering a
    single DB-maintained authz-revision stamp or another read reduction. Never
    trade the measured latency away by returning to KV-TTL authorization.

## 5. Explicitly NOT copying

- Pages Functions architecture (Houzs's dedicated Worker + native crons is
  better for this workload).
- Supabase Storage migration (R2 works; revisit only if egress costs bite).
- Multi-org tenancy (Houzs is single-company; Hookka needed it).
- The 800-entry column-rename-map (Houzs schema was snake_case already —
  a permanent advantage; do not introduce camelCase columns).

## 6. References

- Hookka audit (file-level): see session notes 2026-06-13; key files:
  src/lib/cached-fetch.ts, src/components/ui/data-grid.tsx,
  src/components/layout/global-search.tsx, src/api/lib/observability.ts,
  scripts/apply-postgres-migrations-incremental.mjs [external],
  scripts/check-bundle-size.mjs, migrations-postgres/0150.
- TanStack Query practices: tanstack.com/query, tanstackship.com
- Postgres search: supabase.com/blog/postgres-full-text-search-vs-the-rest,
  sourcegraph.com/blog/postgres-text-search
- Keyset pagination: citusdata.com five-ways-to-paginate,
  blog.sequinstream.com keyset-cursors
- Materialized views: postgresql.org/docs/current/rules-materializedviews

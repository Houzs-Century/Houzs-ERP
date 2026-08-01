# Houzs ERP — Architecture & Data Model (system map)

Written 2026-06-13 from a full read of the codebase. This is the human map of the
system. Pair with `UPGRADE-PLAN.md` (what to improve) and `FOUNDATION-PLAN.md`
(Hookka audit).

**No counts live in this file.** File counts, LOC and migration numbers are in
[`docs/generated/codebase-map-facts.md`](./generated/codebase-map-facts.md),
computed from the tree. This file carried them until 2026-08-02 and they had
drifted badly — it still said "92 numbered migrations" when the live tree held
well over twice that. Per `docs/KNOWLEDGE-SYSTEM.md`, a number that moves on
every merge must be generated, never typed.

Stack: Cloudflare Workers + Hono (backend) · Supabase Postgres via Hyperdrive
(data, migrated off D1) · R2 (files) · React 18 + Vite + TS + Tailwind (SPA on
Cloudflare Pages) · session/Bearer auth · Resend (email) · Google Maps · AutoCount
.NET middleware (upstream of record for sales/PO).

---

## 1. Backend (`backend/src`)

**Entry + middleware** (`index.ts`): Hono app → `cors` → `dbInject`
(swaps `env.DB` for the Postgres shim per request) → public routes
(`/api/auth`, `/api/survey`, `/api/track`, portals) → `auth` → ~40 authed route
modules. Cron `scheduled` handler runs through `withPgDb`:
- `*/5` — incremental SO pull from AutoCount (checkpointed).
- `*/30` — PO docs + lines pull, ASSR stage alerts, scheduled lead-time flips.
- `0 2` — overdue auto-extend, SLA escalation, ASSR daily digest, project due
  reminders, creditors + stock-items resync, weekly streaks, leaderboard cache,
  monthly gifting reset.

**DB layer (the D1→Postgres cutover)** — `src/db/`:
- `pg.ts` — `getSql()` builds a per-request postgres.js client. Hyperdrive branch:
  `max:1, prepare:false, idle_timeout:0, no connect_timeout` (matches Hookka's
  proven prod config — do not deviate; deviations caused the 06-13 incident).
- `d1-compat.ts` — the shim. `?`→`$n` placeholder rewrite + dialect
  rewrites (`datetime('now')`, `julianday`, `strftime`, `LIKE`→`ILIKE`, `instr`,
  `char`) so the ~685 legacy `env.DB.prepare(...)` call sites run on Postgres
  unchanged. `.run()` auto-appends `RETURNING *` for `last_row_id`. Slow-query
  log (>100ms) on every query.
- `client.ts` — `getDb(env)` = Drizzle over postgres-js (schema.pg.ts), ~20+ new
  call sites; legacy raw SQL coexists on the same connection.
- `middleware/db.ts` — `dbInject` / `withPgDb`; falls back to bound D1 if no
  DATABASE_URL/HYPERDRIVE (rollback path).

**Routes (~40)**, grouped: sales/orders, balance, overdue, sync; po, creditors,
stockItems; assr (+ portal, print); projects (+ driverProjects, print); trips,
planner, delivery, lorries, fleet; users, auth, roles, departments; sales-team,
sales; gamify, awards, innovations, suggestions, ideas*; search, logs, finance,
inbox, notifications, events, presence; portal, supplierPortal, track, survey;
settings, udf, warehouses, pettyCash. (No `/api/maps` route — geocoding lives in
scm/routes/scan-so.ts and trip route-optimisation in scm/lib/maps.ts, reached via
POST /api/scm/trips/:id/optimize-route.)

**Services (~40)** carry the domain logic: `autocount.ts` (+ pull/po/push/
creditors), `assr*` (workflow, alerts, escalation, leadTime), `projects*`
(lifecycle, cost rates, reminders), `delivery`/`planner`/`trips` (logistics),
`points`/`salesTeam`/`salesEntries`, `permissions`/`pageAccess`/`projectAcl`
(authz), `email`/`push`/`logger` (integration). Maps is not a service module:
see scm/lib/maps.ts (Directions, env-gated on GOOGLE_MAPS_API_KEY).

**Authz model** (3 layers):
- Flat permission strings (`permissions.ts`, ~30 keys) → `requirePermission` /
  `requireAnyPermission` (O(1) Set lookup on the hydrated user).
- Per-page access matrix (`pageAccess.ts`, mig 073, `role_page_access`) →
  `requirePageAccess(page, level)` with none/partial/full + parent→child cascade.
- Row scope (`projectAcl.ts`, mig 049): PIC one-hop (`pic_id ∈ {self, manager}`)
  ∩ brand allow-list. `scope_to_pic` role flag turns it on.

**Integrations**: AutoCount (`autocount.ts`, has a global writes kill-switch),
Resend email (no-op-safe, per-purpose toggles, `email_log` audit), Google Maps,
R2 (POD photos, ASSR/project attachments, profile pics), Hyperdrive.

**Tests/CI**: vitest on `@cloudflare/vitest-pool-workers` (isolated D1 per file,
`DATABASE_URL=""` pins it off live PG); thin coverage (pageAccess, projects).
GitHub Actions: CI (typecheck+test) + Deploy on main.

---

## 2. Data model (the migration trees + `schema.pg.ts`), by domain

1. **Auth/access**: `users` (role_id, manager_id, department_id, points), `roles`
   (JSON permissions, `scope_to_pic`, `is_system`), `role_page_access` (mig 073),
   `sessions`, `invitations`, `password_resets`, `departments` + `department_brands`
   (mig 048), `user_brands` (mig 049).
2. **Sales**: `sales_orders` + `order_details` (legacy, AutoCount-synced,
   region WEST/EAST/SG); modern `sales_entries` + `sales_entry_items` +
   `sales_entry_payments` (mig 070/051, project-linkable, multi-payment);
   `sales_reps` org (`sales_positions`, `commission_tiers`, `rep_brands`).
3. **Procurement**: `purchase_orders` (line-level, AutoCount read-only),
   `purchase_order_docs` (header), `po_docs_raw` (cache), `creditors` (supplier
   master), `stock_items` (item→main_supplier cache).
4. **Service (ASSR)**: `assr_cases` (9-stage pipeline, per-priority SLA snapshot)
   + `assr_stage_history`, `assr_items`, `assr_attachments`, `assr_activity`
   (append-only + correction chain), lookups (`assr_issue_categories`,
   `resolution_methods`, `priorities`, `ncr_categories`), lead-time profiles +
   per-priority stage targets + scheduled activations, alert acks.
5. **Projects/events**: `projects` (derived code, stage+status, pic_id, brand,
   setup/dismantle crew mig 083, payment proof mig 026), `project_checklist`
   (+ template/sections mig 050, attachments, comments, review mig 085),
   `project_finance` + `_lines` + `project_cost_rates` (per-brand), `project_activity`,
   `project_reads`, `project_brands`, `event_types`, `phase_photos`, `sales_attendees`,
   `stock_transfers` (manual OUT/RETURN).
6. **Logistics/fleet**: `trips` + `trip_stops` + `trip_locations`,
   `trip_proposals` + `_trips` (planner output), `lorries`, drivers/helpers,
   `warehouses` + `state_warehouse_map` (KL/PG/SBH/SRW/SG).
7. **Inventory**: `stock_items` (cost/price/supplier) + `project_stock_transfers`
   (manual count). NO perpetual stock-level ledger, NO lot/FIFO — a known gap.
8. **Gamification/misc**: `point_transactions` + streaks + leaderboard cache,
   `awards` + redemptions, `innovations`/`suggestions`/`votes` + idea attachments/
   comments, `petty_cash_entries`, `email_log` + `app_settings`, `execution_logs`,
   `system_settings`, `udf_fields` + `udf_values`.

**Hub tables**: `users` (every audit FK), `sales_orders` (AutoCount sync hub),
`assr_cases`, `projects`, `trips`, `purchase_orders`. Cross-domain joins are by
`doc_no` (orders↔details↔ASSR↔PO), `item_code` (ASSR↔stock_items↔creditors),
`pic_id`/`created_by` (projects↔users), `project_id` (projects↔sales_entries↔trips).

**Most important model decisions**: (1) 9-stage ASSR with snapshotted per-stage
SLA; (2) append-only activity with correction chain; (3) two-dimensional PIC∩brand
scoping; (4) dual sales model (legacy AutoCount `sales_orders` + modern
`sales_entries`); (5) state→warehouse routing binding SO→trip→lorry.

---

## 3. Frontend (`frontend/src`)

**Shell**: `main.tsx` (provider stack Toast→Dialog→Auth→AuthGate; public surfaces
survey/portal/reset split before auth even mounts; PWA register). `App.tsx` —
**every page lazy-loaded** with `Suspense`+`PageSkeleton`+`ChunkReloadBoundary`;
`Guard`/`PageGuard` permission wrappers; driver-only auto-redirect to `/driver`.

**Data layer**: `api/client.ts` (fetch wrapper, token store, 401/403 listeners,
blob/download/openHtml helpers) + `api/cache.ts` (15s SWR memory cache, in-flight
dedup, cross-tab `BroadcastChannel` invalidation) + legacy `hooks/useQuery.ts`.
No react-query; no SSE/WebSocket (chat/presence/notifications poll every 3–30s).

**Pages** (by size): `Projects.tsx` (9.8k LOC — list+detail+checklist+chat+Gantt+
P&L+lightbox in ONE file), `ServiceCases.tsx` (4.7k), `Team.tsx` (1.8k),
`Sales.tsx` (1.7k), `PurchaseOrders.tsx` (1.3k), Logistics/Trips, Overview, plus
driver + portal pages.

**Components**: `DataTable.tsx` (columns/sort/filter/CSV/UDF/density, persisted per
tableId, mobile cards; it has grown roughly fourfold since this was written and is
now large enough to grep rather than read whole). It **does** window its rows now —
`VIRTUAL_ROW_THRESHOLD` / `VIRTUAL_OVERSCAN`, with `MobileVirtualList` on the phone.
This paragraph said "no row virtualization" until 2026-08-02, which is worse than a
stale number: it invites someone to build a thing that already exists. `PnlCalendar`,
`GlobalSearch` (Cmd+K), `Sidebar` (NAV_TABS perm-gated registry), `MapView`
(leaflet), `ProjectGantt`, `ProjectChat` (3s poll), `IdeaList`, `Panel`/
`DetailLayout`, `SignaturePad`, `Skeleton` (Table/List), many primitives.

**Auth/UI**: `auth/AuthContext` (can/canAny/canAll O(1), pageAccess(page)),
`PageGuard`. **Driver sub-app** (`/driver`, mobile shell). **Public portals**
(`portal/`, survey, track, reset) bypass auth. **PWA** (`public/sw.js`, `pwa.ts`).

**Build**: `vite.config.ts` manualChunks (react-vendor / leaflet / lucide);
Tailwind brand theme (cream/brass, Manrope + Plus Jakarta Sans).

---

## 4. Cross-cutting strengths & weaknesses (see UPGRADE-PLAN.md for fixes)

**Strengths**: clean cutover shim; layered authz (perm + page + row scope); cron
orchestration; mature ASSR + projects domains; reusable DataTable; permission-driven
nav; URL-as-state; route code-splitting + SWR cache + cross-tab sync (added 06-13).

**Weaknesses**: (1) money columns risk int4 overflow on PG (amounts in sen);
(2) indexes live in a script, NOT in numbered migrations (fresh envs load indexless);
(3) giant page files (Projects 9.8k LOC); (4) no DataTable virtualization, full-res
images, whole lucide bundle; (5) missing skeletons on detail panels; (6) no
react-query/SWR-revalidate (refetch-on-mount, 3s polls); (7) AutoCount writes
kill-switch is a hardcoded const; (8) SQLite-era FKs not enforced (PG will);
(9) no perpetual inventory ledger; (10) thin test coverage + no error boundary
for render errors.

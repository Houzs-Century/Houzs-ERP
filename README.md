# Houzs ERP

Internal operations platform for Houzs Century — AutoCount sync, procurement tracking, delivery planning, fleet + driver dispatch, service cases (ASSR), projects, and cross-module P&L. Replaces a legacy Google Sheets + Apps Script workflow with a single web app.

---

> ## ⚠️ Parts of this README are out of date. Trust the code-backed docs instead.
>
> This file and [`docs/CODEBASE-MAP.md`](docs/CODEBASE-MAP.md) / [`CLAUDE.md`](CLAUDE.md)
> disagree about several things. **Where they disagree, the map and `CLAUDE.md` are
> right** — each claim below was checked against the tree on 2026-08-13. This banner
> is deliberately a pointer, not a rewrite: the README is being corrected section by
> section, and a silent merge would have hidden which half was wrong.
>
> | This README says | The code says | Authority |
> |---|---|---|
> | Data store is **Cloudflare D1 (SQLite)** | D1 was **removed 2026-06-13**; there is no `env.DB` binding in prod. Supabase Postgres via Hyperdrive (`[[hyperdrive]]` in `backend/wrangler.toml`) | `CLAUDE.md`, `docs/CODEBASE-MAP.md` §4 |
> | Migrations are `001_*.sql … 036_*.sql` in `backend/src/db/migrations/` | **Two trees.** `migrations-pg/` (286 files, to `0285_*`) is what reaches production; `migrations/` (147 files) is the D1/test tree only | `CLAUDE.md` § Migrations, `docs/CODEBASE-MAP.md` §4 |
> | "No backend/frontend unit tests exist yet" | **167** backend test files under `backend/tests/`, run by vitest in `deploy.yml` | `docs/CODEBASE-MAP.md` §1 |
> | The Modules table (Overview, Orders, PO, ASSR, Projects, Logistics, Team, Settings) | Omits **`/scm/*` entirely** — the vendored SCM supply-chain surface is the largest part of the app | `docs/CODEBASE-MAP.md` §2-3 |
>
> **Start at [`docs/README.md`](docs/README.md)** — it maps every doc to the one thing
> it is authoritative for.

---

## Stack

| Layer | Tech | Lives in |
|-------|------|----------|
| Worker runtime | Cloudflare Workers + [Hono](https://hono.dev) | `backend/src/index.ts` |
| Data store | Cloudflare D1 (SQLite) | `backend/src/db/` |
| Blob store | Cloudflare R2 (proof-of-delivery photos, signatures, payment proofs) | R2 bucket `houzs-erp` |
| SPA | React 18 + Vite + TypeScript + Tailwind | `frontend/` |
| SPA hosting | Cloudflare Pages | `frontend/wrangler.toml` |
| Auth | Session-based (Bearer token), server-issued, role/permission gated | `backend/src/middleware/auth.ts` |
| Email | [Resend](https://resend.com) | `backend/src/services/email.ts` |
| Maps / geocoding | Google Geocoding (SO scan address) + Directions (trip route optimisation) | `backend/src/scm/routes/scan-so.ts` (geocode) · `backend/src/scm/lib/maps.ts` (routing, env-gated on `GOOGLE_MAPS_API_KEY`) |
| Upstream of record | AutoCount middleware (.NET) over HTTPS | `backend/src/services/autocount.ts` |
| E2E tests | Playwright | `e2e/` |

The Worker is the single HTTP entry point — the SPA calls it over CORS. AutoCount is called only from the Worker (never the browser) so credentials never leave the backend.

---

## Modules

| Module | Route | Perm | What it does |
|--------|-------|------|--------------|
| **Overview** | `/` | — | Daily briefing. Inbox (tasks, reviews, blockers, this-week), KPI ribbon, cross-module P&L calendar, pipeline snapshot. |
| **Sales Orders** | `/orders` | `sales_orders.read` | AutoCount sync target. Editable delivery fields that push back to AutoCount. Tabs: Orders, Balance (expiry collections), Overdue (auto-extension history), Sales P&L. |
| **Delivery Orders** | `/delivery-orders` | `delivery_orders.read` | Flat delivery-ready view of sales orders with logistics fields (lorry, driver, dates). Auto-hidden for dispatchers who have the richer Trips Queue (`hidePerm: trips.read.all`). |
| **Purchase Orders** | `/po` | `purchase_orders.read` | Unified procurement surface. Tabs: PO Documents (doc-level with per-status filter + line drill-down panel), Creditors (AutoCount mirror with PO aggregates), PO Cost P&L. PO amounts are read-only (upstream authority). |
| **Service Cases (ASSR)** | `/assr` | `service_cases.read` | After-sales workflow — stage pipeline, SLA tracking, satisfaction survey. Creditor auto-resolves from `case.item_code` → `stock_items.main_supplier` → `creditors.creditor_code` (no parallel supplier registry). Tabs: Cases, By Creditor, Quality Metrics, Service Cost P&L. |
| **Projects** | `/projects` | `projects.read` | Event-scoped lifecycle (exhibitions). Tabs: List, Calendar, Analytics, Profitability, Finance ledger, Checklist, Trips. Brand-scoped; payment proof stored in R2. |
| **Logistics** | `/logistics` | `trips.read.all` or `fleet.read` | Two-level nav. Primary tabs → Trips (Queue, Drafts, Live, Tracking, Events, History) and Fleet (Drivers, Helpers, Lorries, Compliance). Legacy `/trips` and `/fleet` redirect here preserving `?focus=…`. |
| **Team** | `/team` | `users.read` or `roles.read` | Tabs: Members (user accounts + pending invitations), Roles (grid of role cards with permission editor). Legacy `/roles` redirects to `/team?tab=roles`. |
| **Settings** | `/settings` | `settings.manage` | Tabs: Connection, Sync (filtered cron + full refresh), Email (Resend channel toggles), Activity Log (execution history across all jobs). |
| **Profile** | `/profile` | — | Password change, session, display name. |

### Driver sub-app

Driver-only users (holding `trips.read.own` without `trips.read.all` or `sales_orders.read`) are auto-redirected from `/` into the mobile shell at `/driver`. Pages: `DriverHome` (today's trip), `DriverTrip` (stop-by-stop POD capture), `DriverProfile` (clock-in, earnings, salary).

### Public (no login) surfaces

| Path | Token source | Purpose |
|------|--------------|---------|
| `/track` and `/portal/case/:token` | `assr_cases.public_token` | Customer-facing case status page. |
| `/survey/:token` | `assr_surveys.token` | Post-close satisfaction survey emailed on case closure. |

---

## Repository layout

```
ERP-Houzs/
├── backend/                        # Cloudflare Worker (Hono + D1 + R2)
│   ├── src/
│   │   ├── index.ts                  # route mounts + scheduled(cron) handler
│   │   ├── middleware/
│   │   │   ├── auth.ts               # Bearer → user + permissions
│   │   │   └── caseTrack.ts          # public case-token gate
│   │   ├── routes/                   # one file per HTTP surface (orders, po, assr, …)
│   │   ├── services/                 # business logic + AutoCount client
│   │   │   ├── autocount.ts          # typed AutoCount HTTP client
│   │   │   ├── creditors.ts          # /Creditor/getAll pull
│   │   │   ├── stockItems.ts         # /StockItem/getSingle cache + resolver
│   │   │   ├── logger.ts             # writeLog → execution_logs
│   │   │   ├── email.ts              # Resend wrapper (no-ops if unset)
│   │   │   ├── permissions.ts        # role → permission expansion
│   │   │   └── …
│   │   └── db/
│   │       ├── schema.sql              # baseline (used by db:reset)
│   │       └── migrations/             # 001_*.sql … 036_*.sql, applied in order
│   ├── package.json                  # wrangler, hono
│   ├── tsconfig.json
│   └── wrangler.toml                 # D1/R2 bindings, crons, vars
├── frontend/                       # React SPA on Cloudflare Pages
│   ├── src/
│   │   ├── pages/                    # top-level routes
│   │   ├── components/               # DataTable, TabStrip, PageHeader, Panel, …
│   │   ├── hooks/                    # useQuery, useServerSort, useLocalStorage, …
│   │   ├── lib/utils.ts              # formatters + cn()
│   │   ├── auth/AuthContext.tsx      # session, permission checks (`can("…")`)
│   │   ├── api/client.ts             # fetch wrapper (Bearer, base URL, buildQuery)
│   │   └── pwa.ts                    # service worker registration
│   ├── public/                       # favicons, logo, manifest.webmanifest, sw.js
│   ├── .env.production               # VITE_API_URL
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── wrangler.toml                 # Pages config (pages_build_output_dir)
├── e2e/                            # Playwright suite (parameterised by BASE_URL)
├── docs/                           # architecture PDFs + module guides
├── reference/                      # legacy Apps Script + brand assets
└── package.json                    # root orchestrator — no deps, forwards via `npm --prefix`
```

Each sub-app (`backend/`, `frontend/`) owns its own `package.json`, `tsconfig.json`, and `wrangler.toml`. The root `package.json` is a thin forwarder — every script shells into one of the sub-apps via `npm --prefix`.

---

## Quick start

```bash
# One-time: install deps in both sub-apps
npm run install:all

# Backend secrets (one-time per env)
cd backend
wrangler secret put AUTOCOUNT_API_KEY       # required
wrangler secret put DASHBOARD_API_KEY       # required — internal-ops API gate
wrangler secret put GOOGLE_MAPS_API_KEY     # route planner geocoder
wrangler secret put RESEND_API_KEY          # optional — email no-ops if unset
cd ..

# Apply schema + migrations to remote D1 (idempotent)
npm run db:migrate

# Dev servers (separate terminals)
npm run dev:backend     # wrangler dev on :8787
npm run dev:frontend    # vite on :5173
```

Create the first owner account with `wrangler d1 execute …` or the bootstrap route (see `backend/src/routes/auth.ts`). Subsequent users are created by invitation from `/team`.

---

## Scripts (root orchestrator)

| Command | What it does |
|---------|--------------|
| `npm run dev:backend` | Runs `wrangler dev` inside `backend/` |
| `npm run dev:frontend` | Runs `vite dev` inside `frontend/` |
| `npm run typecheck` | `tsc --noEmit` across both sub-apps |
| `npm run deploy:backend` | Deploys the Worker (`wrangler deploy`) |
| `npm run deploy:frontend` | Builds (`vite build`) + deploys the SPA to Cloudflare Pages |
| `npm run deploy:all` | Both, in order |
| `npm run db:migrate` | Applies every `backend/src/db/migrations/*.sql` to remote D1 (idempotent — tracks applied files in `d1_migrations`) |
| `npm run db:reset` | Disabled guard — prints why and exits 1 (it used to wipe the remote D1 cold-backup with no confirmation) |
| `npm run db:reset:remote:DANGER` | Re-applies `schema.sql` to the **remote** D1 (**destructive — prod data loss**). Explicit name on purpose |
| `npm run db:reset:local` | Same but against the local D1 sandbox |
| `npm run install:all` | `npm install` in `backend/` + `frontend/` |

---

## Cron schedule

Configured in `backend/wrangler.toml → [triggers] crons`. Dispatched by `backend/src/index.ts → scheduled(event, env, ctx)`.

**Read `backend/src/index.ts → scheduled()` for the authoritative list** — three
`event.cron` branches at `:479`, `:550`, `:635`. The table below was re-derived
from those branches on **2026-08-14** and is a snapshot, not a binding.

| Schedule | Jobs (in branch order) | Entrypoints |
|----------|-----|------------|
| `*/5 * * * *` (`:479`) | Hyperdrive keep-warm ping · durable email outbox retry · AutoCount inbound SO pull (`/SalesOrder/getSince` + checkpoint) · amendment write-back drain · ERP→AutoCount outbox drain · SO stock-allocation recompute sweep · iOS fleet-reminder push (UTC hour 0 only) · orphan payment-slip reaper | `services/pull.ts → runPull`, `drainEmailOutbox`, `drainCommands`, `drainAutoCountOutbox`, `drainStockAllocationRecompute`, `services/pushFleetReminders.ts`, the slip `reapOnce` |
| `*/30 * * * *` (`:550`) | ASSR per-stage alert scanner · ASSR lead-time scheduled activations · agent heartbeat | `services/assrAlerts.ts → runAssrAlerts`, `runScheduledLeadTimeActivations`, `runAgentHeartbeat` |
| `0 2 * * *` (`:635`) | ASSR SLA escalation · AutoCount DO-header mirror refresh · ASSR daily digest · project due-date reminder emails · client-error digest + 90-day sweep · idempotency-key TTL sweep · `scm.mv_ar_aging` refresh · scan-SO weekly rule distill (Sundays only) | `services/assrEscalation.ts → runSlaEscalation`, `services/doMirror.ts → runDoMirrorSync`, `services/assrAlerts.ts → runAssrDailyDigest`, `services/projectReminders.ts → runProjectDueReminders`, `services/clientErrors.ts → runClientErrorDigest`, inline SQL ×2, `scm/routes/scan-so.ts → distillAllSalespersonRules` |

> **CORRECTED 2026-08-14.** Every row above was wrong. The table named
> `services/sync.ts`, `services/po.ts`, `services/overdue.ts` and
> `services/creditors.ts`; **none of those files exists** — `overdue.ts` and
> `creditors.ts` were deleted by `dfa1111a` "chore: strip ERP to core modules"
> (`git log --diff-filter=D`), and the SO pull has always lived in
> `services/pull.ts`. It described a `*/30` purchase-order sync:
> `grep -rn 'runPOPull\|runPODocsPull' backend/src` returns nothing — that job
> does not exist. And it credited the daily batch with overdue auto-extension, a
> `/Creditor/getAll` resync and a stock-items refresh; none of the three appears
> in the `0 2 * * *` branch (`grep -n 'stockItems\|reditor\|overdue'
> backend/src/index.ts` returns only the `routes/stockItems` import at `:49`).
> Anyone debugging "why did the creditor code not resync" was starting from a
> file deleted months ago — **while this same README said so 45 lines further
> down**: *"there is no PO, creditor or overdue cron service in
> `backend/src/services/` … Earlier versions of this table listed them as live;
> they were not."* The AutoCount section was corrected on 2026-08-12 and the cron
> table three screens above it was not, because nothing ties the two. That is the
> whole failure mode in one file.

Everything else runs on-demand from user actions (Refresh buttons, panel interactions, manual `Sync All`).

Every scheduled run writes one row to `execution_logs` (`type`, `status`, `message`, `started_at`, `request_id`). The Activity Log tab in Settings is a paginated view over that table.

---

## AutoCount integration

**Start at `docs/autocount-integration-map.md`** — there is more than one channel and they run in opposite directions. This section covers only the legacy READ relay; the ERP -> AutoCount write-back is a different service and is documented there.

**The ERP is the master.** Documents are created and edited in the ERP and pushed into AutoCount, which is a receiving end for the accounts. This section used to open by calling AutoCount "the system of record" — that was true before the cutover and is the wrong way round now.

### The legacy read relay (`AUTOCOUNT_API_URL`, `it-houzs.dev`)

Inbound only. Gated by `AUTOCOUNT_SYNC_DISABLED` (`wrangler.toml [vars]`, currently `"false"` = pulls ON). The client is `backend/src/services/autocount.ts`; it authenticates with `AUTOCOUNT_API_KEY` and writes a `FAILED` row to `execution_logs` on failure.

| AutoCount endpoint | Used by | When |
|-|-|-|
| `/SalesOrder/getSince` | SO mirror into `sales_orders` (`services/pull.ts`) | `*/5` cron |
| `/DeliveryOrder/getSince`, `/DeliveryOrder/getAll` | DO header mirror (`services/doMirror.ts`); incremental first, full dump as fallback | daily `0 2` cron |
| `/SalesOrder/getSingle`, `/SalesOrder/getDetail` | ASSR service cases resolving their SO context | on demand |
| `/StockItem/getSingle` | `item_code -> main_supplier` for case routing, cached in `stock_items` | on demand + refresh route |

**Everything else the client can call has no caller.** Verified against `main`, 2026-08-12: `getOverdue`, `getOutstandingPOs`, `getAllPODocs`, `getPODetail`, `getAllCreditors`, `getSingleCreditor` are all zero-callsite, and there is no PO, creditor or overdue cron service in `backend/src/services/`. Earlier versions of this table listed them as live; they were not. There are no `purchase_orders` / `creditors` refresh jobs.

**The two write methods on this client are inert.** `pushSalesOrder` and `pushPODates` short-circuit on the compile-time constant `AUTOCOUNT_WRITES_DISABLED = true` and have no callers. A push path did once exist (`routes/orders.ts` called it on save) and was removed with the Orders module in the strip-to-core change — which is why older docs describe delivery-field edits pushing back. They do not.

**Known defect, not yet fixed:** Settings -> Sync calls `/api/sync/status`, `/api/sync/pull` and `/api/sync/retry-errors`. Only the five `*-mirror` receivers are mounted under `/api/sync`, so those three 404. The tab's checkpoint display and both buttons are dead.

---

## Auth & permissions

- **Sessions** — `POST /api/auth/login` returns a `session_token`; the SPA stores it in `localStorage` and sends it as `Authorization: Bearer <token>`. Server resolves the token → `user_id` → role → permission set on every request (`backend/src/middleware/auth.ts`).
- **Roles** are rows in `roles`; permissions are stored as JSON arrays on the role. `is_system = 1` roles (Owner, Admin, Dispatcher, Driver, …) are immutable — the editor panel is read-only for them.
- **Wildcard** — the Owner role holds `*`, granting every permission. Other roles list explicit keys like `sales_orders.read`, `trips.manage`, `fleet.read`.
- **Route guards** — `App.tsx` wraps every protected route in a `<Guard perm="…">` (or `anyPerm={[…]}`) that redirects to `/` when the current user is missing the permission. This is defense-in-depth; the sidebar already hides entries the user can't use.
- **Driver-only routing** — a user who can read trips (`trips.read.own`) but no office surfaces (`sales_orders.read`, `delivery_orders.read`) is auto-bounced to `/driver` at the root level (see `isDriverOnly` in `App.tsx`).
- **Public surfaces** (`/track`, `/survey/:token`) — gated by opaque row-scoped tokens in the DB, not session auth. Middleware in `backend/src/middleware/caseTrack.ts`.

---

## Configuration

### `backend/wrangler.toml`

```toml
[vars]
AUTOCOUNT_API_URL = "https://it-houzs.dev/"
PUBLIC_APP_URL    = "https://erp.houzscentury.com"   # canonical domain; used to build email links
EMAIL_FROM        = "Houzs ERP <no-reply@mail.it-houzs.dev>"

[[d1_databases]]
binding      = "DB"
database_name = "autocount-sync"

[[r2_buckets]]
binding     = "POD_BUCKET"
bucket_name = "houzs-erp"
```

### Required secrets (`wrangler secret put`)

| Secret | Who uses it | What happens if unset |
|-|-|-|
| `AUTOCOUNT_API_KEY` | Every AutoCount call | Syncs fail, `execution_logs` records `FAILED` |
| `DASHBOARD_API_KEY` | Internal ops routes | Requests 401 |
| `GOOGLE_MAPS_API_KEY` | Route planner geocoder | Planner falls back to "unknown", no map render |
| `RESEND_API_KEY` | Transactional email | Email service silently no-ops (intentional — deploy never breaks) |

### `frontend/.env.production`

```
VITE_API_URL=https://autocount-sync-api.<account>.workers.dev
```

The SPA prepends this to every API call. In dev the fallback is `http://localhost:8787`.

---

## Data model highlights

- **`execution_logs`** — every sync / cron / manual job writes a row. Activity Log tab is a paginated view.
- **`d1_migrations`** — tracks which `0NN_*.sql` files have been applied; `npm run db:migrate` skips already-applied files.
- **`users`, `roles`, `user_roles`** — auth. System roles are seeded in `001_auth.sql`.
- **`sales_orders`, `purchase_orders`, `purchase_order_lines`, `purchase_order_docs_raw`** — AutoCount mirrors. `purchase_order_docs_raw` holds the untransformed header JSON so the side panel can surface every AutoCount field without another API call.
- **`creditors`, `stock_items`** — AutoCount mirrors (Phase 5). `assr_cases.creditor_code` is populated from `stock_items.main_supplier` at save time and re-reconciled every daily cron.
- **`assr_cases`** — service case with stage pipeline (`stage` column), SLA tracking (`sla_deadline`, `sla_breached_at`), and customer-facing `public_token`.
- **`projects`** — event-scoped, brand-scoped. `payment_proof_r2_key` points at R2. No FK to contractors/suppliers (dropped in migration 036).
- **`trips`, `trip_stops`, `trip_events`, `trip_drivers`** — dispatch graph. `trip_events` is append-only (clock-ins, status changes, notes).
- **`finance_ledger`** — double-entry-ish project cost tracking feeding the Projects P&L.

All financial rollups (Sales P&L, PO Cost P&L, Service Cost P&L, Projects P&L, Overview) run against SQLite views or ad-hoc queries — no pre-computed aggregates, since D1 handles the data volumes comfortably.

---

## Architecture notes

- **Single Worker, many routes** — each route file in `backend/src/routes/*.ts` mounts onto the root Hono app at a specific prefix (e.g. `app.route("/api/orders", orders)`). The auth middleware runs before every `/api/*` route.
- **Scheduled handler** wraps each cron branch in `ctx.waitUntil(...)` with an outer try/catch so one job's failure doesn't kill the rest. Each branch owns its own `execution_logs` row.
- **Server-side sort** — `DataTable` accepts a `serverSort` prop; `useServerSort` manages state. Paginated endpoints read `sort_by` and `sort_dir` query params, validate against a backend `SORT_MAP` allow-list, and apply a tiebreaker on `id` so pagination is stable across page boundaries.
- **Tab + title pattern** — every multi-view page renders `<TabStrip>` first, then a `<PageHeader>` whose title/description come from a `TAB_HEADER` map keyed by the active tab. Action buttons (e.g. "Invite Member" on Members tab, "New Role" on Roles tab) are driven by the same map and sit in `PageHeader.actions`.
- **PWA** — service worker caches the app shell (HTML, JS, CSS, icons, logo, manifest) cache-first; API calls bypass the worker and go network-first over CORS to the Worker. Driver-only users get an offline-tolerant POD capture flow.
- **Global search** (⌘K / `/`) — `GET /api/search?q=…` fans out to 8 sources (orders, POs, creditors, cases, projects, trips, stock items, users) in parallel, merges, and deep-links into the right module with the right tab.

---

## Deploy

```bash
npm run deploy:all              # frontend build + deploy, then worker deploy
npm run deploy:backend          # worker only
npm run deploy:frontend         # SPA only
```

The Pages deploy picks up the SPA build from `frontend/dist/` (configured in `frontend/wrangler.toml` → `pages_build_output_dir`). DNS / custom domains are managed in the Cloudflare dashboard and not in this repo.

Migrations must be applied before any deploy that depends on new schema. The canonical order is:

```bash
npm run db:migrate          # apply any new migrations first
npm run deploy:all          # then ship the code
```

---

## Testing

Playwright specs in `e2e/specs/`. Parametrised by `BASE_URL` — point at localhost for dev, the staging Pages URL for PR previews, or prod as a smoke test.

```bash
cd e2e
npm install
npx playwright install --with-deps
npm test                                     # hits BASE_URL (default localhost)
npm test -- --base-url=https://…             # override
```

No backend/frontend unit tests exist yet — Vitest is the planned pick when a service grows complex enough to warrant them.

---

## Migrations discipline

- Every schema change goes through a new numbered file in `backend/src/db/migrations/`.
- Files are applied in numeric order by `npm run db:migrate`; the script tracks applied files in the `d1_migrations` table and skips them on re-run.
- Don't edit a migration after it's been applied to prod. Write a new one.
- SQLite can't `DROP COLUMN` when the column is referenced by an index or a foreign key. Pattern: `DROP INDEX` first, or rebuild the table (see `036_drop_legacy_suppliers.sql` for the projects-table rebuild example).
- Use `IF EXISTS` and `IF NOT EXISTS` liberally — it keeps the migration idempotent against re-runs on half-applied state.

---

## Getting help

- `/help` surface inside the app — in-app tour + keyboard shortcuts (⌘K / `/` for search).
- `docs/` holds architecture PDFs and module-specific guides. Check there first when something is non-obvious.
- Cloudflare dashboard → Workers → `autocount-sync-api` → Logs for live request traces.
- `execution_logs` table in D1 for cron / sync history (also exposed in Settings → Activity Log).

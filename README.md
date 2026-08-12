# Houzs ERP

Internal operations platform for Houzs Century — AutoCount sync, procurement tracking, delivery planning, fleet + driver dispatch, service cases (ASSR), projects, and cross-module P&L. Replaces a legacy Google Sheets + Apps Script workflow with a single web app.

---

## Stack

| Layer | Tech | Lives in |
|-------|------|----------|
| Worker runtime | Cloudflare Workers + [Hono](https://hono.dev) | `backend/src/index.ts` |
| Data store | **Supabase Postgres via Cloudflare Hyperdrive.** D1 is test-only — prod has no D1 binding | `backend/src/db/` |
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

**Not listed here on purpose.** This section used to carry a hand-written table of
every module, its route and its permission. It went stale — it still advertised
`/orders`, `/po` and `/delivery-orders`, none of which are mounted any more — and
it was the third place in the repo claiming to know where routes live. A fact with
three homes is a fact that will disagree with itself.

The routes live in exactly two places now, both derived from the tree, so neither
can drift:

| Question | Read |
|---|---|
| Every desktop route and the page module it renders | [`docs/generated/codebase-map-facts.md`](docs/generated/codebase-map-facts.md) §4 |
| Every API endpoint with its file, line, mount path and permission gate | [`docs/generated/route-locator.md`](docs/generated/route-locator.md) + [`route-capability-matrix.csv`](docs/generated/route-capability-matrix.csv) |
| What a module is FOR and how to work in it | [`docs/modules/<module>.md`](docs/modules/) |
| What each area is for, what is vendored, what is dead | [`docs/CODEBASE-MAP.md`](docs/CODEBASE-MAP.md) |

Regenerate the first two with `node backend/scripts/gen-codebase-map.mjs` and
`npm --prefix backend run gen:route-locator`.

### Driver sub-app

Driver-only users (holding `trips.read.own` without `trips.read.all` or
`sales_orders.read`) are auto-redirected from `/` into the mobile shell at
`/driver`. Pages: `DriverHome` (today's trip), `DriverTrip` (stop-by-stop POD
capture), `DriverProfile` (clock-in, earnings, salary).

### Public (no login) surfaces

| Path | Token source | Purpose |
|------|--------------|---------|
| `/track` and `/portal/case/:token` | `assr_cases.public_token` | Customer-facing case status page. |
| `/survey/:token` | `assr_surveys.token` | Post-close satisfaction survey emailed on case closure. |

---

## Repository layout

```
ERP-Houzs/
├── backend/                        # Cloudflare Worker (Hono + Postgres/Hyperdrive + R2)
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
│   │       ├── schema.pg.ts            # Drizzle schema
│   │       ├── migrations-pg/          # THE LIVE TREE — deploy.yml applies these to prod
│   │       └── migrations/             # D1/SQLite tree, test parity only — never reaches prod
│   ├── package.json                  # wrangler, hono
│   ├── tsconfig.json
│   └── wrangler.toml                 # Hyperdrive/R2/KV/Queue bindings, crons, vars
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

# Migrations reach PRODUCTION automatically: deploy.yml runs pg-migrate.mjs on every
# push to main. There is no manual prod migrate step.

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
| `npm run db:migrate` | Legacy D1 tree only. **Production migrations are `backend/src/db/migrations-pg/`, applied by `deploy.yml` via `scripts/pg-migrate.mjs` on every push to main** |
| `npm run db:reset` | Disabled guard — prints why and exits 1 (it used to wipe the remote D1 cold-backup with no confirmation) |
| `npm run db:reset:remote:DANGER` | Re-applies `schema.sql` to the **remote D1 cold backup** — not to prod Postgres. Still destructive. Explicit name on purpose |
| `npm run db:reset:local` | Same but against the local D1 sandbox |
| `npm run install:all` | `npm install` in `backend/` + `frontend/` |

---

## Cron schedule

Three triggers, declared in `backend/wrangler.toml` under `[triggers] crons` and
dispatched by `scheduled(event, env, ctx)` in `backend/src/index.ts`.

**The per-job list is NOT reproduced here.** It used to be, and it rotted into
fiction: it advertised a `*/30` purchase-order pull and a daily `/Creditor/getAll`
resync run by `services/overdue.ts`, `services/po.ts` and `services/creditors.ts`
— three files that do not exist. `scheduled()` carries a commented branch per
slot and is the only copy that cannot lie; read it there.

| Trigger | Where to read what it does |
|---|---|
| `*/5 * * * *` | `backend/src/index.ts`, the `event.cron === "*/5 * * * *"` branch |
| `*/30 * * * *` | same file, the `*/30` branch |
| `0 2 * * *` | same file, the `0 2` branch |

Everything else runs on demand from user actions (Refresh buttons, panel
interactions, manual `Sync All`).

Every scheduled run writes one row to `execution_logs` (`type`, `status`,
`message`, `started_at`, `request_id`). The Activity Log tab in Settings is a
paginated view over that table.

---

## AutoCount integration

AutoCount is treated as the **system of record** for anything procurement- or finance-related. The Postgres tables `sales_orders`, `purchase_orders`, `purchase_order_lines`, `purchase_order_docs_raw`, `creditors`, and `stock_items` are mirrors — refreshed on cron, read-mostly from the SPA.

| AutoCount endpoint | Used by | Refreshed |
|-|-|-|
| `/SalesOrder/getSince` | Orders incremental pull | `*/5` cron |
| `/SalesOrder/getAll` | Settings → Sync → "Full Refresh" | Manual |
| `/SalesOrder/update` | Orders delivery-field edits (push back) | On save |
| `/PurchaseOrder/getAll` | PO documents pull | `*/30` cron |
| `/PurchaseOrder/getOutstanding` | Outstanding lines (dashboard counts) | `*/30` cron |
| `/PurchaseOrder/getDetail` | PO side-panel drill-down (on-demand) | Click |
| `/Creditor/getAll` | Creditors mirror | Daily + manual |
| `/Creditor/getSingle` | On-demand creditor refresh | Click |
| `/StockItem/getSingle` | Service cases' `item_code → main_supplier` lookup (cached) | Daily + case save |

The Worker's client (`backend/src/services/autocount.ts`) prefixes every request with `AUTOCOUNT_API_URL` (`wrangler.toml [vars]`) and authenticates with `AUTOCOUNT_API_KEY` (secret). On failure it writes a `FAILED` row to `execution_logs` and returns a 500; the SPA surfaces the error via toast.

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

All financial rollups (Sales P&L, PO Cost P&L, Service Cost P&L, Projects P&L, Overview) run against Postgres views or ad-hoc queries — no pre-computed aggregates at current data volumes.

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
- `execution_logs` table in Postgres for cron / sync history (also exposed in Settings → Activity Log).

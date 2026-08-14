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

### Drivers

There is no separate driver sub-app. An earlier section here described a
`/driver` shell with `DriverHome` / `DriverTrip` / `DriverProfile` pages —
none of those exist in the tree. Drivers use the same mobile shell as everyone
else (`frontend/src/mobile/`, mounted by `useIsMobile()`); their field tool is
`MobilePOD.tsx` (proof-of-delivery capture), which has no desktop twin. See
`docs/CODEBASE-MAP.md` §7.

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
| `npm run lint` | Type-aware ESLint across both sub-apps, gated by `scripts/lint-ratchet.mjs`. Every rule is a WARNING; the gate is a per-file ceiling in `<app>/eslint-ratchet.json` that may only FALL. A file with no ceiling entry has a ceiling of zero, so a new file — or a rule that is clean tree-wide — fails on its first violation. Rules and the bug-history entry behind each are in `scripts/eslint/houzs-lint-rules.mjs` |
| `npm run lint:update` | Rewrites the ceilings from the current tree. Run it after fixing findings, and commit the lower numbers. Never run it to make a build pass — raising a ceiling is the one thing it must not be used for |
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

Every claim below was verified against the code on 2026-08-12; where a table of
endpoints used to sit here, most of it described machinery that no longer runs.

**What is actually live:**

| Direction | What | Where | Gate |
|---|---|---|---|
| Inbound | Sales-order incremental pull (`/SalesOrder/getSince`, full `/getAll` fallback) | `services/pull.ts → runPull`, called from the `*/5` cron branch in `backend/src/index.ts` | `AUTOCOUNT_SYNC_DISABLED` in `wrangler.toml` — currently `"false"` (pull is ON) |
| Inbound | Delivery-order mirror (`/DeliveryOrder/getSince`, full-refresh fallback) | `services/doMirror.ts → runDoMirrorSync`, daily `0 2` cron branch | same kill switch |
| Outbound | ERP → AutoCount write-back via the outbox (migration `0277`) | `scm/lib/autocount-outbox.ts → drainAutoCountOutbox`, `*/5` cron | dark: `scm.app_config 'scm.autocount_writeback'` is `off`, and `AC_SYNC_KEY` is unset. See `docs/modules/autocount-writeback.md` |

**What exists in the client but has NO caller** (verified by grep — do not read
capability off `services/autocount.ts`'s method list): the purchase-order pulls
(`getOutstandingPOs`, `getAllPODocs`), the creditor pulls, and the stock-item
cache. The legacy sheet push (`pushSalesOrder` → `/SalesOrder/updateFromSheet`)
is additionally hard-disabled by `AUTOCOUNT_WRITES_DISABLED = true` in code.

The client (`backend/src/services/autocount.ts`) prefixes requests with
`AUTOCOUNT_API_URL` and authenticates with the `AUTOCOUNT_API_KEY` secret.
The modern write-back path does NOT go through it — it posts to `AC_SYNC_URL`
(the AcSyncService on the AutoCount host) from the outbox drain.

---

## Auth & permissions

- **Sessions** — `POST /api/auth/login` returns `{ token, user_id }` (`backend/src/routes/auth.ts`); the SPA stores it (localStorage with "remember", session-only otherwise — `frontend/src/auth/AuthContext.tsx`) and sends `Authorization: Bearer <token>`. The server resolves token → user → permission set on every request (`backend/src/middleware/auth.ts`), with a 60s KV cache (`services/sessionCache.ts`).
- **Roles** are rows in `roles`; permissions are a JSON array in the `permissions` text column. System roles are not fully immutable: `routes/roles.ts` allows editing their DESCRIPTION and refuses name/permission changes ("System roles cannot be renamed or have permissions changed").
- **Wildcard** — the Owner role holds `*`, granting every permission. Other roles list explicit keys like `sales_orders.read`, `trips.manage`, `fleet.read`.
- **Route guards** — `App.tsx` wraps every protected route in a `<Guard perm="…">` (or `anyPerm={[…]}`) that redirects to `/` when the current user is missing the permission. This is defense-in-depth; the sidebar already hides entries the user can't use.
- **Driver-only routing** — there is no `isDriverOnly` and no `/driver` route (both were described here and neither exists). Phones mount the mobile shell via `useIsMobile()` in `frontend/src/auth/AuthScreens.tsx`; what a user can reach inside it is decided by the same backend capabilities as desktop.
- **Public surfaces** (`/track`, `/survey/:token`) — gated by opaque row-scoped tokens in the DB, not session auth. Middleware in `backend/src/middleware/caseTrack.ts`.

---

## Configuration

The single source of truth is [`backend/wrangler.toml`](backend/wrangler.toml)
itself — it is heavily commented, each var carries its history, and a sample
here WILL rot (the previous sample still showed a `[[d1_databases]]` binding
that was removed 2026-06-13, and an `EMAIL_FROM` on a domain retired in June).
Read the file. What you will find there, as of 2026-08-12:

- **Bindings**: Hyperdrive (Supabase Postgres), four R2 bindings on the
  `houzs-erp` bucket, the `houzs-scan-ocr` queue pair, a `SESSION_CACHE` KV,
  Analytics Engine. There is NO D1 binding.
- **Vars**: `AUTOCOUNT_API_URL`, `AUTOCOUNT_SYNC_DISABLED`, `AC_SYNC_URL`,
  `COSTING_DISPLAY_ENABLED`, `SESSION_FALLBACK_ENABLED` (+ TTL),
  `HOUZS_OWNS_2990`, `PUBLIC_APP_URL`, `EMAIL_FROM` / `EMAIL_REPLY_TO`,
  `SO_ITEM_PHOTOS_BUCKET_NAME`.
- **Secrets** (set with `wrangler secret put`; the full annotated list lives in
  the toml comments): `AUTOCOUNT_API_KEY`, `DASHBOARD_API_KEY`,
  `GOOGLE_MAPS_API_KEY`, `RESEND_API_KEY` (email silently no-ops if unset),
  `AC_SYNC_KEY`, `CONNECT_SERVICE_TOKEN`, `AE_QUERY_TOKEN` + `CF_ACCOUNT_ID`,
  `SENTRY_DSN` (deliberately unset).
- **`[env.staging]`**: a full parallel stack — own Supabase, own queues, own KV,
  `crons = []`. Bindings do not inherit into named envs.

### `frontend/.env.production`

```
VITE_API_URL=<the Worker origin>
```

The SPA prepends this to every API call. In dev the fallback is
`http://localhost:8787`.

---

## Data model

**The schema's source of truth is `backend/src/db/schema.pg.ts` (Drizzle) plus
the applied tree `backend/src/db/migrations-pg/`** — not this file. The
"highlights" list that used to sit here was written before the Postgres cutover
and had rotted badly: it described `d1_migrations` as the tracking table (the
live one is `_pg_migrations`; `d1_migrations` has zero references in the tree),
pointed at `001_auth.sql` for role seeds (a test-tree file; production seeds
live in `0000_baseline.sql`), and highlighted a `finance_ledger` table that
exists only in the retired D1 tree, never in Postgres.

Three facts worth keeping here because they are structural, verified 2026-08-12:

- **Two migration trees, one real.** `migrations-pg/` is applied to production
  by `deploy.yml` on every push to `main`, tracked by full filename in
  `_pg_migrations`. `migrations/` is the D1 tree, read only by backend vitest.
- **`execution_logs`** records cron and sync runs; the Settings → Activity Log
  tab is a paginated view over it.
- **Native tables vs `scm.*`.** The native Houzs modules (projects, ASSR, mail,
  users/roles) live in the public schema and are reached through the d1-compat
  shim; the vendored supply chain lives in the `scm` schema and is reached
  through supabase-js. `docs/CODEBASE-MAP.md` §4 carries the traps.

All financial rollups run against Postgres views or ad-hoc queries — no
pre-computed aggregates at current data volumes.

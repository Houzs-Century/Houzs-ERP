# Houzs ERP — Codebase Map

Orientation for anyone (human or agent) opening this repo cold: what each area is
FOR, how the areas relate, and which parts will mislead you if you trust your
instincts. Read this before your first grep.

**This file carries judgement only.** Every count, inventory and file size lives in
[`docs/generated/codebase-map-facts.md`](./generated/codebase-map-facts.md), which is
computed from the tree by `backend/scripts/gen-codebase-map.mjs`. Go there for:
route modules and their endpoint counts, the two migration trees and their highest
numbers, the largest source files, the desktop route table, the mobile screen list,
and the derived desktop/mobile destination pairing.

> The previous version of this file was hand-written end to end, including the
> numbers. It rotted invisibly: by 2026-07-21 it claimed 82 backend route modules
> against a real 122, described route modules that had been deleted months earlier,
> and returned zero hits for "Sales Report", "scan-so", "Announcement" and
> "fulfillment". That is why the split exists. **Do not copy generated numbers back
> into this file** — a number typed here is a number that will be wrong.

Regenerate: `node backend/scripts/gen-codebase-map.mjs`.
Check for drift: `npm --prefix backend run audit:map`. That check is deliberately
NOT a CI or deploy gate — a stale doc must never stop a deploy (the sibling
`audit:routes` gate is a gate, and it jammed prod twice in one day; see BUG-HISTORY).

---

## 1. What ships

Two independently deployed apps in one repo, plus two small side services.

| Path | What it is | Deploy |
|---|---|---|
| `backend/` | Cloudflare Worker (`autocount-sync-api`), Hono. The ONLY writer of business data. | `.github/workflows/deploy.yml` on push to `main` |
| `frontend/` | React + Vite SPA on Cloudflare Pages, served at `erp.houzscentury.com`. | same workflow, separate job |
| `e2e/` | Playwright specs run against STAGING, not prod. | `staging-e2e.yml` |
| `mail-sync/` | Standalone IMAP poller that POSTs received mail into the Mail Center ingest. | `mail-sync.yml` |
| `reference/` | Non-code: the legacy Google Apps Script exports and brand assets. Never imported. | — |

`deploy.yml` splits by changed path, so a frontend-only push does not redeploy the
Worker. The backend job runs `audit:routes`, `typecheck`, `test`, then
`pg-migrate.mjs` against production, then deploys, then smoke-checks. **Migrations
run before the Worker goes live and on every deploy** — which is why a single broken
migration file blocks all deploys, not just its own.

## 2. Backend — what each area is for

- `src/index.ts` — the whole mount order in one file. Public/pre-auth routers are
  mounted BEFORE `app.use("/api/*", auth)`; everything after it requires a bearer
  session, then `companyContext`, then opt-in `idempotency`. If you add a route that
  must work without a session, mount order is the control, not the handler.
  It also owns the cron `scheduled()` handler and the Queue `queue()` consumer.
- `src/routes/` — the NATIVE Houzs modules: auth/users/roles/positions/departments,
  projects (the events ERP), ASSR (after-sales service) plus its customer/supplier
  portals, mail center, announcements, agent console, assistant, search, audit.
- `src/scm/` — the furniture supply chain, **vendored from the 2990 codebase**
  (see §4). Mounted at `/api/scm/*` behind `requireScmAccess`, with its own
  `routes/`, `lib/`, `middleware/` and `shared/`. It talks to the Postgres `scm`
  schema through supabase-js, not through the d1-compat shim the native routes use.
  Two subsystems living in one Worker with two different data-access styles is the
  single most confusing thing about this codebase; check which half you are in
  before copying a pattern.
- `src/services/` — cross-cutting logic the routes call: permissions, page access,
  position policy, capabilities, org scope, email, AutoCount, agent scheduling.
  `capabilities.ts` is the one to know: it resolves server-side booleans that both
  the desktop and the mobile shell consume, so a gate is decided once.
- `src/middleware/` — `auth`, `companyContext`, `idempotency`, `rateLimit`,
  `requestLog`, the two portal-token guards, and `db` (the D1-shaped shim over
  Postgres, see §4).
- `src/db/` — `schema.pg.ts` (Drizzle), `pg.ts` (the connection settings that were
  bought with an outage — do not "tidy" them), and the two migration trees.
- `src/scm/lib/` — the pure, testable half of the SCM rules: pricing, FIFO costing,
  document numbering, sales scope, fair-report access, amendment/revision logic. If
  a rule could be wrong about money or about who may read something, it belongs here
  with a test beside it, not inline in a route.

## 3. Frontend — what each area is for

- `src/main.tsx` — forks by URL prefix BEFORE React mounts: `/survey`, `/track`,
  `/portal`, `/reset` and `/invite` bypass the staff `AuthGate` entirely, so public
  pages never download the dashboard bundle. Also the canonical-domain redirect and
  the view-as token hand-off.
- `src/auth/AuthScreens.tsx` — where the two surfaces split: `useIsMobile()` decides
  whether the desktop `<App/>` route tree mounts or the mobile shell does. Read §7
  before assuming a page exists on both.
- `src/App.tsx` — the entire desktop route table plus the guard components
  (`Guard`, `PageGuard`, `ScmGuard`, and the purpose-built ones). Every page is
  `React.lazy`. Guards are documented in place; the docblocks explain WHY a cohort
  is admitted and are more authoritative than any summary here.
- `src/pages/` — native Houzs pages (Projects, ServiceCases, Team, Sales, Settings,
  Announcements, Mail Center, hubs).
- `src/pages/scm-v2/` — the VENDORED 2990 SCM pages. This is the canonical `/scm/*`
  surface; the older native `pages/scm/*` set was retired at the cutover.
- `src/vendor/` — wholesale copies of 2990's `scm`, `shared` and `design-system`
  packages, reached through the `@2990s/*` aliases declared in
  `frontend/vite.config.ts`. Data hooks for the whole SCM surface live in
  `vendor/scm/lib/*-queries.ts`.
- `src/mobile/` — the phone app (§7). A first-class surface, not a responsive tweak.
- `src/portal/` — the tokenised customer-facing case portal.
- `src/api/client.ts` — hand-rolled fetch client: bearer token, GET-only retry with
  backoff (this is what survives Hyperdrive cold starts), short in-memory SWR cache,
  cross-tab invalidation. Mutations are never retried.

## 4. Traps

**Two migration trees; only one reaches production.** `migrations-pg/` is applied to
prod by `deploy.yml` on every deploy. `migrations/` is the D1/SQLite tree — it is
NOT dead and must not be deleted, but nothing applies it to production: it exists so
backend vitest can build an in-process D1 with the same shape (`vitest.config.ts`
reads it with `readD1Migrations`). Prod has no D1 binding at all. A schema change
that must hold in prod goes in `migrations-pg/`; a mirror in `migrations/` only
buys test parity. The generated facts file states which is which, derived from the
workflow and the runner scripts rather than from anyone's memory.

**Migration numbers are labels, not identities.** `pg-migrate.mjs` keys
`_pg_migrations.filename`, so historical duplicate numbers are harmless and several
exist. `backend/tests/migrationNumbers.test.ts` freezes those and fails on any NEW
duplicate — including against a `.TEMPLATE` file, which owns its number from the day
it lands. Pick the number at merge time, not at branch time.

**`frontend/src/vendor/scm`, `frontend/src/vendor/shared`,
`frontend/src/pages/scm-v2` and `backend/src/scm` are VENDORED.** They were copied
from 2990 to stay diffable against their source. Do not casually rename, reformat or
"modernise" them, and do not fold their helpers into the native tree: the value is
that a 2990 file and its Houzs copy still look alike. Fix bugs in place, narrowly.

**The d1-compat shim.** `middleware/db.ts` swaps `env.DB` for a D1-shaped wrapper
over Postgres so legacy `env.DB.prepare(...)` call sites keep working — it rewrites
`?` placeholders, `datetime('now')`, and synthesises `meta.changes`. It is why
`sqlite`-looking code runs on Postgres. It also means a `timestamptz` column
compared against a shim-rewritten `datetime('now')` becomes `timestamptz < text` and
throws; write those predicates PG-native.

**`/api/scm/*` swaps the identity.** Inside the SCM subtree `c.get('user')` carries
an `scm.staff` UUID, while the native tree carries the Houzs bigint user id. Routers
that need the Houzs user (agent console, inbox busting) are deliberately mounted
OUTSIDE `/api/scm` for exactly this reason.

**Retired but still on disk.** `frontend/src/pages/scm-v2/Drivers.tsx` has no
importer and `/scm/drivers` is deliberately not mounted (the Drivers section lives
inside `/scm/fleet`). A file existing is not evidence a feature is live; check
`App.tsx` for the route. The house rule is "off, not hidden": a gated feature has no
nav entry, no mounted route and no query firing.

**Docs that are historical.** `docs/archive/MIGRATION-D1-TO-SUPABASE.md` and
`docs/archive/HANDOFF-supabase-cutover.md` describe the abandoned Supabase project
and a bound D1. They are records of a past cutover, not descriptions of today —
which is why they now live under `docs/archive/`. See `docs/README.md` for what is
authoritative for what.

## 5. Files that are too big to read whole

These files exceed what is worth loading into a context window, and reading them
whole is the most common way a session runs out of room before it starts working.
**Locate by grep, then read by line range.** The exact sizes are in the generated
facts file; the point here is the shape of each file so you can jump.

> Sizes were typed inline here until 2026-08-13 and had rotted exactly as this
> file's header warns: `Projects.tsx` was labelled "~12,400 lines" against a real
> 14,867, and `mfg-sales-orders.ts` "~10,400" against 12,094. They are gone rather
> than refreshed — a number typed here is a number that will be wrong again.

**These files may no longer grow.** `scripts/file-size-ceilings.json` records what
each one already is, and `npm run check:file-size` fails CI if any exceeds its
recorded ceiling — see [`docs/repo-hygiene.md`](./repo-hygiene.md). Nothing forces
them to be SPLIT; the ratchet only stops the problem getting worse, and a ceiling
may only fall. If you are adding to one of these, put the new code in its own
module: that is now the path of least resistance, by design.

- **`frontend/src/pages/Projects.tsx`** — the entire events ERP in
  one module, four view components plus a detail page. In order: pickers and small
  helpers, `Projects()` (the shell), `ProjectsListView`, `ProjectsFinancesView`,
  `ProjectsAnalyticsView`, `ProjectsCalendarView` (with its popovers and day modal),
  `CreateProjectPanel`, then `ProjectDetail` and everything under it — team, spec
  strip, stage stepper, tasklist sections, documents, checklist rows, stock
  transfers, and the logistics crew/schedule editors at the very bottom. Grep the
  component name, then read around it.
- **`backend/src/scm/routes/mfg-sales-orders.ts`** — the Sales Order
  module, and the pricing-critical one. Top third: the guards and gate helpers
  (`soHasDownstream`, `soProcessingLocked`, `soStatusTransitionError`,
  `gateSoFinance`) and the validation helpers. Middle: `createSalesOrderCore` and the
  exported `createDraftSalesOrder` — the factored create path that scan-to-SO also
  calls, so never reimplement a create beside it. Then header PATCH and delivery-fee
  re-derivation, then item CRUD with `recomputeTotals`, then per-line photos, then
  payments (`recordSoPaymentRow`), then the debtor lookup at the end.
- **`frontend/src/pages/ServiceCases.tsx`** — ASSR. `ServiceCases()`
  and the list/board/calendar views first, then `CreatePanel`, then `DetailContent`
  and the exported `ServiceCaseDetail`, then the detail's parts: stage rows,
  inspection and verification cards, logistics, print and portal-link menus, cost
  tracking, customer history, and the per-item editors last.
- **`frontend/src/pages/scm-v2/Products.tsx`** — tabbed: `SkuMasterTab`
  (with its virtualised row list and inline price editors) occupies the first half,
  `MaintenanceTab` and its left-rail sub-tabs the second, CSV import/export helpers
  at the end. The `/scm/maintenance` route renders this same file.
- **`frontend/src/pages/Team.tsx`** — user management. `Team()` shell,
  `MembersTab`, `MemberDetail` / `MemberCard` / `EditMemberPanel`, brands panel, then
  `OrgChartTab` and its drag-and-drop machinery at the bottom.
- **`backend/src/scm/routes/scan-so.ts`** — see §6. Anthropic plumbing
  and catalog loading first, then prompt construction and cache warming, then slip
  normalisation and validation, then the sample/rule distillation layer, then the
  route handlers.

Anything else near the top of the generated list (`delivery-orders-mfg.ts`,
`SupplierDetail.tsx`, `backend/src/routes/projects.ts`, `MobileNewSO.tsx`,
`MobilePMS.tsx`) deserves the same treatment. `backend/src/routes/projects.ts` is
the friendliest of them: it carries `// ──` section banners you can grep for.

## 6. Subsystems that are easy to miss

**Sales Report (the code says "Fair Report").** Route `/reports/fair-report`, page
`frontend/src/pages/scm-v2/FairReport.tsx`, sidebar label "Sales Report". Exhibition
performance across four document stages (SO / DO / Invoice / P&L). The access matrix
is owner-ruled and per-stage: `backend/src/scm/lib/fair-report.ts` holds it as pure
functions with tests, and `frontend/src/auth/salesAccess.ts` mirrors the same cohort
so the nav entry, the route guard and the API agree. If you search for "Sales
Report" in the source you will find almost nothing — search `fairReport`.

**Scan-to-SO (handwritten slip OCR).** `backend/src/scm/routes/scan-so.ts` turns
phone photos of carbon-copy showroom order slips into a draft Sales Order via Claude
vision. Two paths: `/scan-so/extract` (synchronous, feeds the desktop
`vendor/scm/components/ScanOrderModal.tsx`) and `/scan-so/enqueue` (a Cloudflare
Queue job — `SCAN_QUEUE`, consumed by `queue()` in `backend/src/index.ts` — which
creates a DRAFT SO through `createDraftSalesOrder` and notifies the operator). It
learns: operator-confirmed corrections are distilled into per-salesperson rules plus
a shared `__GLOBAL__` alias dictionary, refreshed on confirm and again by a
Sunday-gated weekly cron. A sibling, `scan-payment.ts`, OCRs card-terminal receipts
and doubles as the payment slip upload. `MobileScan.tsx` is the phone front end.

**Announcements.** Office notices with acknowledgement receipts.
`backend/src/routes/announcements.ts` (reading is open to every signed-in user and
audience-filtered server-side; `announcements.write` gates every write), desktop
`pages/Announcements.tsx` plus the `components/AnnouncementBanner.tsx` pop-up over
the shared `useAnnouncementBanner.ts` hook, and on mobile `MobileAnnouncements.tsx`
+ `MobileAnnouncementPopup.tsx` + `MobileAnnouncementMedia.tsx` with
`useAnnouncementUnread.ts` for the badge. Both pop-ups render the same hook — that
symmetry was bought by a bug and should not be undone.

**Mail Center.** An in-ERP shared inbox: `routes/mail-inbound.ts` is the pre-auth,
secret-guarded ingest fed by the standalone `mail-sync/` poller;
`routes/mail-center.ts` is the authed read/reply/compose surface; the pages are
`pages/MailCenter/*` and `mobile/MobileMailCenter.tsx`.

**The 2990 mirrors.** `/api/sync/{so,amendment,customer,staff,warehouse}-mirror` are
pre-auth, secret-guarded receivers called by the 2990 database itself. They are
mounted at the top level, outside `/api/scm`, and are separate routes on purpose so
one mirror stalling cannot wedge the others.

**Fleet Maintenance & Compliance (Phase 1).** Route `/api/fleet-maintenance`
(`backend/src/scm/routes/fleet-maintenance.ts`), page
`frontend/src/pages/FleetHealth.tsx` at `/fleet-health`, gated by the flat
`fleet.read` / `fleet.write` permissions (via `requireHouzsPerm`). It BUILDS ON
the existing SCM fleet master — `scm.lorries` IS the vehicle master; it reuses
`scm.lorry_maintenance` (out-of-service windows), `scm.lorry_service_records`
(mileage / next service / repair cost), `scm.drivers` (`drivers.vehicle` = plate)
and `scm.warehouses` (region). The ONE new table is `scm.lorry_compliance_documents`
(mig 0202): the compliance vault with append-only renewal history + the doc types
the flat columns can't hold (APAD, cross-border, PUSPAKOM result). It syncs the
existing flat `road_tax_expiry`/`insurance_expiry`/`puspakom_expiry` columns on
`scm.lorries` as the denormalized "current" value so the old Fleet strip keeps
working. Mounted OUTSIDE `/api/scm` (top-level) with `supabaseAuth`, so the gate is
`fleet.read/write` alone, not `scm.access`. Vehicle status is DERIVED, never stored
— the state machine + expiry-reminder ladder are pure functions in
`backend/src/services/fleet-status.ts` (tests: `backend/tests/fleetStatus.test.ts`),
run server-side so the frontend never re-derives them. `mig 0055` already dropped a
duplicate `public.lorries` once; this module does NOT repeat that.

## 7. Desktop and mobile are two surfaces over one logic layer

The phone does not render the desktop tree. `useIsMobile()` in
`auth/AuthScreens.tsx` mounts `mobile/MobileApp.tsx` INSTEAD of `<App/>`, and
`MobileApp` is a `useState` screen machine, not a router — `mobile/mobileRoute.ts`
is what maps a URL onto a mobile destination, and its header explains what happens
when that mapping is missing (every URL used to render the Sales Orders list under
someone else's title). Consequences you must respect:

- A new desktop route is invisible on phones until `mobileRoute.ts` /
  `MobileApp.tsx` know about it. It will not 404 — it will land somewhere.
- Every mobile menu row must declare its gate (a matching desktop nav entry,
  `gateVia`, a backend `capability`, or an explicit `alwaysShow` justified in
  `mobileMenuGates.test.ts`). CI fails a row that declares none.

**The standing owner rule: ONE shared logic layer. Desktop and mobile must not fork
behaviour.** Permission decisions belong in the backend capability
(`services/capabilities.ts` → `/auth/me`), consumed identically by both surfaces —
not re-derived in the frontend, which is how the two ended up admitting different
cohorts before. Anything one surface can do that the other cannot is a divergence to
be reported, not a feature to be preserved: mobile POD once carried a
money-collection panel the desktop DO detail had no equivalent for, and the ruling
was to delete it.

The full derived pairing — every mobile destination, the desktop page module for the
same path, and the mobile screen that answers it — is table 6 of the generated facts
file. The pairs that are hand-written on BOTH sides, and therefore must be changed
together, are:

| Feature | Desktop | Mobile |
|---|---|---|
| New Sales Order | `pages/scm-v2/SalesOrderNew.tsx` | `mobile/MobileNewSO.tsx` |
| SO list / detail | `pages/scm-v2/MfgSalesOrdersListV2.tsx`, `SalesOrderDetailV2.tsx` | `mobile/MobileSalesOrders.tsx`, `MobileSODetail.tsx` |
| SO amendments | `pages/scm-v2/Amendments.tsx` | `mobile/MobileAmendments.tsx` |
| Service cases (ASSR) | `pages/ServiceCases.tsx` | `mobile/MobileServiceCase.tsx` |
| Projects / PMS | `pages/Projects.tsx` | `mobile/MobilePMS.tsx` (+ `MobileGantt.tsx`) |
| Announcements | `pages/Announcements.tsx`, `components/AnnouncementBanner.tsx` | `mobile/MobileAnnouncements.tsx`, `MobileAnnouncementPopup.tsx` |
| Sales Report | `pages/scm-v2/FairReport.tsx` | `mobile/MobileFairReport.tsx` |
| Delivery planning | `pages/scm-v2/DeliveryPlanning.tsx` | `mobile/MobileDeliveryPlanning.tsx` |
| Stock card | `pages/scm-v2/StockCard.tsx` | `mobile/MobileStockCard.tsx` |
| Stock transfer (new) | `pages/scm-v2/StockTransferNew.tsx` | `mobile/MobileStockTransferNew.tsx` |
| Mail Center | `pages/MailCenter/Inbox.tsx` | `mobile/MobileMailCenter.tsx` |
| Notifications / inbox | `pages/Notifications.tsx` | `mobile/MobileInbox.tsx` |
| Global search | `components/GlobalSearch.tsx` | `mobile/MobileSearch.tsx` |
| Calendar | Projects calendar view (in `pages/Projects.tsx`) | `mobile/MobileCalendar.tsx` |
| Convert-to-DO/SI/GRN/PO | the `*From*` pages under `pages/scm-v2/` | `mobile/MobileConvertWizard.tsx` |

Everything else on the phone is served by ONE generic engine —
`MobileModuleList` / `MobileModuleDetail` / `MobileModuleForm`, driven by a
`MODULE_CONFIGS` entry. Adding a list-shaped SCM module to mobile is a config entry,
not a new screen; check that before writing one.

Mobile-only, with no desktop twin: `MobilePOD.tsx` (driver proof-of-delivery) and
`MobileScan.tsx` (slip capture). Both are field tools; the desktop equivalents are
the DO detail page and the scan modal respectively, which is close but not the same
screen.

## 8. Switches and states worth knowing before you debug

Each verified against the tree; if you are reading this long after 2026-07-21,
re-check the cited file rather than trusting the line.

- **SCM writes are FROZEN for Houzs right now.** `scm.app_config` key
  `scm.write_freeze` holds `'1'`, and `scm/lib/write-freeze.ts` (mounted ahead of
  every SCM sub-router) refuses every non-GET on `/api/scm/*` for company 1.
  Company 2 (2990) is unaffected — the value is a company id list, not a boolean.
  If an SCM write "mysteriously" 503s with `error: write_frozen`, this is why,
  and it is deliberate. The value also takes a per-module exception clause
  (`'1 - scm.sales.orders'`) for the staged go-live lift. Read the current state
  with the **SCM write freeze — status (read-only)** workflow or
  `GET /api/scm/write-freeze`; grammar, the staged sequence and the one-command
  rollback are in `docs/write-freeze-staged-lift.md`. Do not change the value to
  test something — it gates a live business.
- **AutoCount has TWO channels and this bullet used to describe only one.** The
  LEGACY relay's writes are hard-off in code — `AUTOCOUNT_WRITES_DISABLED = true`
  in `backend/src/services/autocount.ts`, a code edit to flip — while its inbound
  pulls are env-gated (`AUTOCOUNT_SYNC_DISABLED` in `wrangler.toml`) and are ON.
  That constant does **not** gate the ERP -> AutoCount WRITE-BACK, which is a
  different service (`AcSyncService` on the AutoCount host) reached through
  `AC_SYNC_URL` — set since PR #2030 — and gated instead by the DB toggle
  `scm.app_config` -> `scm.autocount_writeback`, still `'off'`. Reading the
  constant alone and concluding "nothing can reach AutoCount" is the mistake this
  wording invited; `docs/autocount-integration-map.md` is the map.
- **Cost/margin display** is env-gated by `COSTING_DISPLAY_ENABLED`, parsed by
  `scm/lib/costing-enabled.ts`. Set false and every sales document strips cost from
  the wire, not just from the UI.
- **Session-revocation fallback is OFF** (`SESSION_FALLBACK_ENABLED = "false"` in
  `backend/wrangler.toml`, parsed by `services/sessionCache.ts`). While off, an
  authenticated request whose authoritative session read FAILS is rejected — a DB
  blip logs everyone out until it clears, and revocation is never delayed. Set it
  to `"true"` and, during a DB read failure only, `getUserBySession` may re-serve a
  session the DB most recently confirmed active for up to `SESSION_FALLBACK_TTL_MS`
  (default 60000, clamped 1000..300000) — availability across blips, in exchange
  for a bounded revocation delay *while the DB is down*. With a reachable DB,
  revocation is immediate either way. Operator commands:

  ```sh
  # Turn it OFF (the shipped default) or back ON: edit backend/wrangler.toml [vars]
  #   SESSION_FALLBACK_ENABLED = "false"   # off — strict fail-closed revocation
  #   SESSION_FALLBACK_ENABLED = "true"    # on  — bounded outage fallback
  # then deploy from a branch rebased on origin/main:
  cd backend && npx wrangler deploy

  # Emergency, without editing the tree (overrides the var for this deploy only;
  # the next deploy from main reverts to whatever wrangler.toml says):
  cd backend && npx wrangler deploy --var SESSION_FALLBACK_ENABLED:false
  ```

  Off means the code path is not taken: with the var off, neither the fallback
  lookup nor the liveness recording runs at all (pinned by
  `backend/tests/sessionFallback.test.ts`).
- **`HOUZS_OWNS_2990`** is the cutover flip. While false, Houzs holds a read-only
  mirror of the `2990-` document namespace and the mirror guards refuse Houzs-side
  creates/edits of those documents.
- **Staging is not a copy of prod**: its own Supabase project, its own queues and KV,
  no Analytics Engine binding, and `crons = []`. Bindings do not inherit into named
  wrangler envs — adding one to prod does not add it to staging.
- The Worker is stateless per request by necessity: `db/client.ts` builds a fresh
  postgres.js client per request because sockets cannot cross the request boundary.

## 9. Where to look next

- `BUG-HISTORY.md` — read the entries for a subsystem before changing it. It is the
  record of what has already been tried and why it failed.
- `docs/generated/route-capability-matrix.csv` — every mounted route with its full
  path, auth boundary, company boundary and gate. The `source` column is the
  declaring FILE only; run
  `node backend/scripts/generate-route-capability-matrix.mjs --locations` when you
  need the line number (line numbers are deliberately kept out of the compared
  artifact — see the script header).
- `docs/PERMISSION-MATRIX.md`, `docs/ARCHITECTURE.md`, `docs/agents/operating-spec.md`.
- `docs/modules/sales-order.md` for the SO document flow in depth.
- **`docs/autocount-integration-map.md` — START HERE for anything touching AutoCount.**
  There is not one connection, there are **four channels** with different directions,
  different credentials and different jobs, and treating them as one is how sessions
  conclude the wrong thing. It carries: which hostname writes and why the ZeroTier IP
  is refused by design; which of the six document types are CREATED versus CONVERTED
  and why DO/GR/IV/PI can never be created standalone; how a SKU crosses (translation,
  sofa decomposition, and `Desc2` as the only place a specification lives); what the
  5-minute drain does automatically and the four cases that will **never** be automatic;
  and a table of beliefs that were acted on and turned out false.
- `docs/autocount-writeback-golive-coe.md` — 2026-08-13, the write-back was switched on
  and NOTHING reached the account book. Seven faults in one chain, each hiding the next,
  and the finding worth carrying: three of them are one shape — a fact the ERP holds in
  two columns, the UI reads both, the write-back reads one (`supplier_sku`, the stock
  location, the salesperson). Also records what was ruled out, including two theories
  that were stated and then refuted.
- `docs/autocount-read-relay-exposure-coe.md` — the legacy `it-houzs.dev` relay answers
  the public internet with **no key** on two routes, one of them ~52 MB of purchase
  history. OPEN, needs an owner action. Do not build on that relay.
- `docs/autocount-cutover-ledger.md` — the permanent record of every row the AutoCount
  go-live pushed into company 1: how to tell a migrated row from a real one (the exact
  SQL predicates), what each import wave wrote with its run id, and — the ones that bite —
  which imported documents carry `received_qty` but deliberately no GRN, and which
  migrated GRNs and DOs carry `migrated_no_stock = true` and deliberately no inventory
  movement at all. Posting either would count the same stock twice. Its section 9 records
  the owner's own cutover decisions in his words — historical documents are NOT imported,
  whole-sofa stock is NOT imported, and one AutoCount order whose header disagrees with
  its own lines is recorded rather than corrected. **Read section 9 before "fixing" any
  gap between AutoCount and the ERP**: most of those gaps are decisions.
- `docs/archive/scm-v2-vendoring-progress.md` for what was vendored, when, and with
  what caveats. Archived — the vendoring finished, so read it as history: it still
  describes temporary `/scm/<x>-v2` routes and an intact native `pages/scm/` tree,
  and neither exists any more.

# Module: Projects / PMS

Per-module technical doc — the exhibitions-and-events ERP: the project list, the
calendar, venues, the checklist workflow, project finance, and the hard link
from a Sales Order back to the fair it was written at. Same structure as
[`sales-order.md`](./sales-order.md).

> Verified against `main` @ `8f8427ed`.

> Convention: a **project** is an event (a fair, an exhibition, a campaign).
> Money on projects is stored in whole units on `project_finance` /
> `project_finance_lines`, not sen — this module predates the SCM clone's
> integer-minor-unit rule. Dates are text, displayed DD/MM/YYYY.

> `frontend/src/pages/Projects.tsx` is **12,404 lines**. Do not open it whole.
> §1 maps it so you can grep to a range.

---

## 1. Frontend

### Screens

| Surface | File | Lines |
|---|---|---|
| Every desktop PMS view except maintenance | `frontend/src/pages/Projects.tsx` | 12,404 |
| Lookup masters (brands, event types, organizers, venues, default checklist) | `frontend/src/pages/ProjectMaintenance.tsx` | 2,099 |
| Activity / chat panel | `frontend/src/components/ProjectChat.tsx` | 472 |
| Gantt sub-view | `frontend/src/components/ProjectGantt.tsx` | 474 |
| P&L calendar (Finances tab) | `frontend/src/components/PnlCalendar.tsx` | 709 |

There is **no `ProjectDetail.tsx`** — `ProjectDetail` is exported from
`Projects.tsx:5919` and lazily re-imported by `frontend/src/App.tsx:34`.

Routes: `/projects` under `<PageGuard page="projects">` (`App.tsx:419-422`),
`/projects/:id` under `<PageGuard page="projects.list">` (`App.tsx:427-430`).

### Navigating `Projects.tsx`

`Projects()` at `:788` is a **URL-driven view switch**, not a tab strip — the
sidebar's Project Management group has one entry per view and the page reads
`?view=` (`:781-786`, `:791`, dispatch `:909-922`). Views are
`list | calendar | finances | maintenance` (plus a `hub`, deliberately excluded
from the switchable set).

Landmarks worth grepping to:

| Line | Symbol | Line | Symbol |
|---|---|---|---|
| 480 | `OrganizerPicker` | 5150 | `ProjectTeamSection` |
| 554 | `VenuePicker` | 5506 | `ProjectSpecStrip` |
| 740 | `ProjectStatusSelect` | 5919 | `ProjectDetail` (exported) |
| 949 | `ProjectsListView` | 6143 | `ProjectStageStepper` |
| 1969 | `ProjectsFinancesView` | 6355 | `TasklistSections` |
| 2083 | `FinanceListView` | 6944 | `DocumentTable` |
| 2635 | `ProjectsAnalyticsView` | 7380 | `ThreeDApprovalBlock` |
| 3034 | `ProjectsCalendarView` | 7600 | `ChecklistRow` |
| 4012 | `CalendarBarPopover` | 8340 | `StockTransferSection` |
| 4092 | `CalendarTaskPopover` | 8793 | `PhaseCrewEditor` |
| 4171 | `CalendarDayModal` | 9040 | `LogisticsScheduleSection` |
| 4424 | `CreateProjectPanel` | 9398 | `PhasePhotosSection` |
| 4756 | `ProjectDetailContent` | 9691 | `DefectsSection` |
| 9996 | `ProjectSalesEntriesSection` | 10651 | `FinanceLedgerSection` |
| 11530 | `AddFinanceLineForm` | 11891 | `AttachmentsSection` |
| 12263 | `ImportCsvPanel` | | |

Per-view access is resolved at `:811-816` with `usePageAccess("projects.list" |
".calendar" | ".finances" | ".maintenance")`, ANDed with
`user.project_finance_viewer` for Finances (`:802`). Maintenance is
**full-or-none** (`:826`) — the generic `!== "none"` test admitted `view`/`edit`,
levels the page does not support, so the hub card offered a page the nav hid
(`:817-826`).

### Calendar

Desktop `ProjectsCalendarView` (`:3034`) makes **one** data call —
`GET /api/projects/calendar/events?from=&to=` (`:3243-3246`) — and filters by
brand / section / organizer **client-side**, deliberately, so the server call
stays cacheable at month granularity (`:3259-3261`). Mobile
`MobileCalendar.tsx:260` hits the same endpoint.

Both surfaces sort with the shared `compareCalendarEvents` (state → venue →
organizer → brand). Mobile expands a multi-day fair to one event *per in-range
day* so tapping any covered day opens the day sheet, which means the week bar
list has to de-duplicate — two owner-visible bugs came from that
(`BUG-HISTORY.md`, `fix/mobile-calendar-dedupe` and
`fix/mobile-calendar-state-sort`, both 2026-07-21). If you touch either calendar,
read those entries first.

### Venues

| Surface | File |
|---|---|
| Master CRUD | `frontend/src/pages/ProjectMaintenance.tsx:326` `VenueManager` → `/api/projects/venues` |
| Picker + inline create (project form) | `frontend/src/pages/Projects.tsx:554` `VenuePicker` |
| SCM-side read | `frontend/src/vendor/scm/lib/venues-queries.ts:116` → `/api/projects/venues?includeShowrooms=1` |

The showroom merge is **opt-in** (`backend/src/routes/projects.ts:960-962`):
showroom rows get synthetic ids `showroom:<uuid>` (`:987`) and are de-duplicated
case-insensitively against the project venues (`:972-978`, `:996`). There is no
mobile venue-management screen; the mobile venue surface is the SO form.

**Venue writes are company-scoped** (fix `fix/venue-save-company-scope`,
2026-07-24), the same lock the sibling `/brands` handlers already carry.
`GET /venues` filters by the active company (`company_id`, PG mig 0093), so every
write must stay inside it too: `POST /venues` resolves the active company via
`requireActiveCompanyId(c)` and **refuses with `company_unresolved` (409)** rather
than falling back to the `NOT NULL DEFAULT <HOUZS>` column default (the bug that
made a 2990 venue save then vanish), stamps `company_id` on the INSERT, and scopes
its existing-by-name upsert to the caller's company so it can't hijack another
company's same-named row. `PATCH`/`DELETE /venues/:id` carry the same
`activeCompanySql(c)` guard on their WHERE; PATCH returns **404** on a scoped miss.

A venue carries an optional free-text `size` column (PG mig 0222) — the owner
writes a physical area (`"12,000 sqft"`) or a hall label (`"Hall 3"`), so it is
`text`, not a number. It is read in `GET /venues`, and accepted on `POST`
(INSERT + reactivate upsert) and `PATCH`. `VenueManager` edits it inline (add-row
column + a per-row input committed on blur). Synthetic showroom rows report
`size: null`. The country/city/postcode columns the add-form also posts (mig
0178/0182) are NOT yet read or written by these handlers — only `name`, `state`,
`size`, `notes` are persisted.

### Data hooks and caching

The desktop page sets **no per-callsite `staleTime`, `gcTime` or
`refetchInterval`** — it inherits the app defaults from
`frontend/src/lib/queryClient.ts:64-71`: `staleTime 30s`, `gcTime 30min`,
`refetchOnWindowFocus: false`, one retry except on 4xx (`retryUnlessClientError`,
`:47-54`), and a `MutationCache.onSuccess → broadcastDataChanged()` hook for
cross-tab invalidation (`:59-63`). Queries go through the app's own
`useQuery` wrapper (`frontend/src/hooks/useQuery.ts`), whose keys are namespaced
under `["uq", ...]` (`:56`).

The only two explicit options on the desktop page:

- `Projects.tsx:1083` — `{ keepPreviousData: true }` on the main list query
  (`:1054`), so a filter or page switch keeps the current rows on screen instead
  of flashing an empty table.
- `Projects.tsx:2159` — `{ keepPreviousData: true, enabled: canProjectFinance }`
  on the finance-by-project query.

Mobile sets its own, deliberately shorter windows (`MobilePMS.tsx`):
list `staleTime 30s` + `placeholderData: prev` (`:459-467`, an **infinite**
query), detail `15s` (`:657-659`), phase photos `15s` (`:689-691`), the
PIC/rep/fleet/lorry lookups `5min` (`:701-737`). Every detail mutation
invalidates detail + list + photos (`:750-756`).

### Polling

Two real pollers touch this module:

1. **Notifications** — `frontend/src/hooks/useNotifications.tsx:108`,
   `POLL_INTERVAL_MS = 30_000`, `GET /api/notifications?unread=1&limit=20`
   (`:134`). A payload-signature short-circuit (`:146-162`) means an unchanged
   poll causes no re-render, and it backs off when the tab is hidden.
2. **Project chat / activity** — `frontend/src/components/ProjectChat.tsx:168`,
   a **3-second** interval that skips while `document.hidden` (`:145`) and uses a
   `?since=<max created_at>` cursor (`:149-151`). Its *initial* self-fetch
   (`:91-96`) is unbounded — no `?limit` — which is open item **B8** in
   `docs/perf-optimization-plan.md:119`.

---

## 2. API surface

Mounted at `/api/projects` (`backend/src/index.ts:257`), `/api/projects-print`
(`:281`), `/api/events` (`:256`), `/api/notifications` (`:254`).
`app.use("/api/projects/*", inboxBustAfterWrite)` at `index.ts:235`.

`backend/src/routes/projects.ts` is 4,094 lines and registers ~90 routes. The
exhaustive machine-generated inventory (method, path, auth boundary, company
boundary, gate, source line) is
[`docs/generated/route-capability-matrix.csv`](../generated/route-capability-matrix.csv)
— use that rather than a hand list that will drift. **The shape is what matters
here, and it is highly regular:**

| Class | Gate | Examples |
|---|---|---|
| Reads of project data | `requirePageAccess("projects.list")` | `GET /` `:722`, `GET /summary` `:670`, `GET /:id` `:1497`, `GET /:id/activity` `:1848`, `GET /checklist-templates` `:1094` |
| Reads of lookups | `requirePageAccess("projects")` | `GET /organizers` `:887`, `GET /venues` `:939`, `GET /sections-distinct` `:869` |
| Calendar | `requirePageAccess("projects.calendar")` | `GET /calendar/events` `:3756` |
| Money reads | `requirePageAccess("projects.finances")` | `GET /cost-rates` `:559`, `GET /finance/by-project` `:2001`, `GET /finance/lines` `:2209`, `GET /analytics/profitability` `:1309` |
| Ordinary writes | `requirePermission("projects.write")` | ~61 routes — finance lines, payments, stock transfers, defects, team, sales attendees, attachments, sections |
| Admin writes | `requirePermission("projects.manage")` | ~29 routes — event types, brands, cost rates, archive/unarchive, checklist templates, CSV import |
| Checklist ticking | `requireAnyPermission(["projects.write","projects.checklist.tick"])` | `PATCH /checklist/:itemId` `:2792`, `/status` `:2843`, `/review` `:2887`, attachments `:3071`, `:3170`, `:3215` |
| Chat | `requireAnyPermission(["projects.write","projects.chat"])` | `POST /:id/notes` `:1832` |
| Unguarded by middleware | — | small public lookups (`/states` `:858`, `/payment-statuses` `:859`, `/brands` `:204`, `/event-types` `:104`, `/finance/categories` `:1987`), the attachment stream `:3690`, and the **phase-photo** routes `:2427`, `:2472`, `:2507`, `:2539`, which carry an inline permission-OR-crew check instead |

### Roadshow PMS Agent — Job E: setup-invoice OCR into project setup COGS

Page `frontend/src/pages/SetupInvoiceFill.tsx` (route `/setup-invoice`, nav "Setup
Invoice" under Projects, gated `projects.finances`) uploads a scanned setup/booth
invoice. `POST /projects/setup-invoice/scan` (`projects.write`) OCRs it with Claude
vision (same `vision-blocks.ts` pattern; needs `ANTHROPIC_API_KEY`), returning
`{vendor, currency, totalRM, items[]}` plus a recent-projects list (so the picker
needs no extra call). Vendor + total are editable, then `POST /:id/setup-invoice/apply`
(`projects.write`) writes a `project_finance_lines` row `kind='cost'
category='setup' amount=<whole RM>` via `createLedgerLine`, dated to the project
`start_date`, `description = "Setup - <vendor>"`. A project may have several setup
invoices, so this ALWAYS adds (no skip-if-present, unlike the fair report).

### Roadshow PMS Agent — Job A: reconcile an organizer's schedule photo

Page `frontend/src/pages/ScheduleReconcile.tsx` (route `/schedule-reconcile`, nav
"Schedule Reconcile" under Projects, gated `projects`) uploads an organizer's
latest itinerary photo. `POST /projects/schedule-reconcile/scan` (`projects.write`)
OCRs it with Claude vision (`claude-sonnet-4-6`, the `vision-blocks.ts` /
`scan-payment.ts` pattern; requires `ANTHROPIC_API_KEY`), extracts
`{organizer, events[]}`, loads that organizer's projects (name-scoped), and returns
the pure **unit-tested `backend/src/services/agents/schedule-reconcile.ts`** diff:
per row `MATCH | DATE_CHANGED | NEW | MISSING`. Dates normalise DD/MM/YYYY and
YYYY-MM-DD before comparison. Writes nothing — a moved event's new dates are applied
via the normal `PATCH /projects/:id {start_date,end_date}`; `MISSING` (a live
project the schedule dropped) is flagged as a possible postpone/cancel to check.

### Roadshow PMS Agent — Job B: fill a project's P&L from a FAIR REPORT

The owner's FAIR REPORT is one `.xlsx` worksheet PER EVENT (`<date><BRAND>@<VENUE>`,
per-order rows). Page `frontend/src/pages/FairReportFill.tsx` (route
`/fair-report-fill`, nav "Fair Report Fill" under Projects, gated `projects.finances`
+ finance-viewer) reads it in-browser with SheetJS and calls:
- `POST /projects/fair-report/match` (`projects.read`) — parses each sheet via the
  **unit-tested pure `backend/src/services/agents/fair-report-parse.ts`** (revenue =
  SELLING, `cogs_matt_sofa` = MATTRESS, `cogs_bedframe` = BEDFRAME, `cogs_accessories`
  = first ACCESSORIES col; salesperson from SALES PERSON — column semantics VERIFIED
  against the report's own MARGIN column), aggregates per event, and returns candidate
  projects matched by brand + venue (sheet names truncate, so venue matches by mutual
  prefix/contains). Writes nothing.
- `POST /:id/fair-report/apply` (`projects.write`) — writes the finance lines via
  `createLedgerLine`, dated to the project `start_date`, SKIPPING any `(kind, category)`
  that already has a non-archived line (fills what is missing, never double-counts).
  `recomputeAutoCostLines` then derives transport/commission/merchandise as before.

Autonomy: this is the human-in-loop path (owner uploads → picks project → applies). A
scheduled auto-fill gated by the PMS agent's `agent_controls.stage` is the planned
follow-up. Only these three product-COGS categories + `sales` come from the detail
sheets; `rental`/`setup` come from the setup invoice (Job E, not built).

**That split is the module's central rule and it is exact: every read is gated by
a POSITION-derived page-access level; every write is gated by a ROLE permission
string.** See §5.

Related routes elsewhere:
- `backend/src/routes/projects_print.ts:124` `GET /:id` — **no middleware gate**;
  the ACL is inline at `:146` (`canSeeProject` OR attendee). The comment at
  `:133-137` records that this path previously bypassed the ACL entirely.
- `backend/src/routes/finance.ts:220`, `:390` — `GET /api/finance/pnl` and
  `/pnl/bucket`, gated on `projects.read`. `finance.ts:10` flags that
  `projects.read` alone gates a route that reads `project_finance_lines` cost.
- `backend/src/routes/notifications.ts:56` `GET /` — **no permission gate at
  all**, deliberately (`:45-55`: a Sales user who lacks the `projects.read`
  matrix permission still needs a bell). Scoped by `getProjectScope` at `:63`
  with an early empty return at `:64-71`.
- `backend/src/routes/events.ts` — the manual setup/dismantle calendar, gated on
  `trips.read.all` / `trips.manage`. **Not** the PMS calendar (`events.ts:13-24`).
- `backend/src/scm/routes/reports.ts:1112`, `:1199` — the Fair / Sales Report.

---

## 3. Backend

### The list handler

`backend/src/routes/projects.ts:722` → `listProjects` in
`backend/src/services/projects.ts`. It resolves `getProjectScope(user)` (`:727`),
maps ~25 query params, and passes the scope down as `pic_scope` / `brand_scope` /
`attendee_user_id` (`:820-823`). `per_page` defaults to 50, capped at 200
(`services/projects.ts:1628`).

Two things happen here that are easy to miss:

1. **Crew forcing.** For a crew-scoped caller, `assigned_to_me` is not a filter
   the client may choose — it is forced on (`:837-841`): a helper or storekeeper
   only ever sees the events they are crewed on.
2. **Server-side finance stripping.** The list SELECTs `pf.rental`,
   `total_sales`, `contractor_cost` per row; for any non-director sales user
   those three are blanked **before the response is written**
   (`:845-853`, via `financeHiddenForUser`). The money never reaches the client,
   rather than being hidden in the UI.
3. **`my_pending_titles` — the caller's own pending work, per row.** Crew
   callers always get their open DRIVER-badged task titles (`'|'`-joined)
   attached to each row; with `my_pending=1` every role-label lane caller gets
   their own label's titles, and a logistic caller gets a derived arrangement
   step (`Arrange Setup Time and Crew` / `Arrange Dismantle Time and Crew`
   from stock-out state + `setup_*`/`dismantle_*` fields — it is not a
   checklist item). With the desktop My Pending checkbox on, the desktop card
   tags the card with these titles INSTEAD of the project's section chip, so a
   logistic caller is not shown someone else's `CONTRACT` stage (owner report
   2026-07-22, Syu). Mobile has its own My Pending mode since 2026-07-23: a
   "My pending" chip on the MobilePMS list (every role) wires the same
   `my_pending=1` lanes, and the card keeps the title chips below the meta
   line. Director rows tag their duties the same
   way (`Approve Stock Out Transfer` / `Set Sales PIC` / `Set Sales Attending`,
   owner report 2026-07-23, Peter — each chip's predicate mirrors its lane
   exactly), and a SALES PIC caller's attending-lane rows append
   `Set Sales Attending` after their label titles. Only the
   `projects.approve`-holder and standalone agreement lanes still fall back to
   the section chip.
4. **Sales Director "My Pending" is exactly three duties** (owner 2026-07-23):
   approve submitted Stock Out Transfer Records (`STOCK_OUT_AWAITING_APPROVAL`),
   set the Sales PIC (`SALES_PIC_EMPTY` — `pic_id` NULL, dangling, or the
   HOUZS CENTURY house login id 1 that imports stamp as a placeholder), and set
   the Sales Attending reps (`SALES_ATTENDING_EMPTY`). The two staffing lanes
   are gated on `CONTRACT_CLEAR` — the project's CONTRACT section has no open
   item — so contract-stage projects stay the BD's pending, not the directors'
   (before the gate, every far-future imported event flooded their list; 110
   rows on 2026-07-23). The same CONTRACT gate applies to the Sales PIC's own
   attending lane. All in the `pendingOr` block, `services/projects.ts` around
   `:1447`.
5. **My Pending follows the timeline** (owner 2026-07-23): when any pending
   lane is active and no explicit `sort_by` is given, the list orders
   soonest event first (`start_date ASC`, nulls last) instead of the
   newest-first dashboard default — it is a work queue. A completed,
   N/A'd, or submitted-for-review task drops its row server-side the
   moment it changes state; nothing "done" ever lingers in My Pending.

### Setup & Dismantle crew editor — outsourced providers

`PhaseCrewEditor` (`Projects.tsx`, around `:8994`) edits the `setup_crew` /
`dismantle_crew` / `service_crew` JSON blobs (stored verbatim in TEXT columns;
the backend never reshapes them). Below the per-lorry crew grid, an **Outsourced
trips** row (owner 2026-07-23) offers three provider buttons on Setup &
Dismantle: **Outsource** and **Lalamove** both open a name·phone·plate box;
**Grab** opens a Helper 1 / Helper 2 picker drawn from the full staff helper
list (`/api/fleet/staff`, role/type `helper`). Each add appends an
`OutsourcedEntry` to `outsourced.entries` carrying a `provider`
(`outsource` | `lalamove` | `grab`); Grab entries store `helper1` / `helper2`
instead of name/phone/plate (a legacy Grab row with name/phone/plate still
renders — the chip falls back). Service / Exchange keeps the older single
**Outsourced** checkbox (it has its own per-lorry Grab/Lalamove `provider`
dropdown). Because the picked helper names land in the crew JSON, a Grab-assigned
helper still matches the `assigned_to_me` / calendar `setup_crew` name arm.

### The calendar handler

`:3756`. `seeAll` is the whole rule (`:3795-3798`):

```
const seeAll =
  !!user && !crewScoped &&
  (isAdmin || getPmsRole(user, { pic_id: null }) === "DIRECTOR" || scope === null);
```

- `isAdmin` = holds `*`.
- **DIRECTOR** sees the whole calendar — owner ruling 2026-07-05, reusing the PMS
  role classification so it stays position-driven rather than a hardcoded string
  here (`:3779-3784`).
- `scope === null` (an unscoped non-admin: logistics, ops, purchasing) also sees
  everything — owner ruling 2026-07-06, restoring behaviour that the
  2026-07-05 assignment-scoping had removed (`:3785-3790`).
- `crewScoped` (helpers, storekeepers) **drops out of the see-all lane** and gets
  a crew-assignment arm instead — owner ruling 2026-07-21 (`:3791-3793`).

Non-see-all callers get OR'd arms: crew (6 FK columns plus a
`setup_crew`/`dismantle_crew` JSON name match, `:3805-3817`), scoped PIC + brand
(`:3822-3828`), unscoped-non-admin PIC-self (`:3832`), and the attendee arm
(`project_sales_attendees → sales_reps.user_id`, `:3836-3841`). With no arms it
fails closed on ` AND 1 = 0` (`:3849`).

> Divergence worth knowing: the **calendar's scoped arm has no grace-window
> predicate**, while the list's does. See `PIC_GRACE_DAYS` below.

---

## 4. The project access model

The claim "page authorization is by POSITION, data visibility by the permission
MATRIX" is **half right**. Verified, there are **three** axes, and the second one
is not the permission matrix.

### Axis 1 — page entry: by POSITION, resolved in CODE

`backend/src/services/auth.ts:328-344`:

```ts
if (permissionsSet.has("*"))       pageAccess = fullAccessMap();
else if (row.position_id != null)  pageAccess = resolvePositionPolicy({...}).pageAccess;
else                               pageAccess = await loadPageAccessForRole(...);
```

For a positioned user **neither `position_page_access` nor `role_page_access` is
read**. `backend/src/services/positionPolicy.ts` is the authority, keyed on
`position_name` + `department_name` strings — an owner-directed architecture
change of 2026-07-18 (`positionPolicy.ts:1-11`). The matrix table still exists,
its editor and export are untouched, but it no longer resolves access for
covered positions. `loadPageAccessForRole` survives as the **positionless**
fallback only.

The policy is **default-FULL**: except Driver, Helper, Storekeeper, Storekeeper
Supervisor and the four Sales tiers, a position resolves to `fullAccessMap()`,
and a position the module cannot classify falls to FULL, never to none — the
anti-lockout guarantee (`positionPolicy.ts:12-19`). Project rows for the
restricted cohorts are `projects: view`, `projects.finances: none`,
`projects.maintenance: none` (`:241-243`, `:253-255`, `:273-275`).

Enforcement: `requirePageAccess` (`backend/src/middleware/auth.ts:414-437`) reads
`user.page_access?.[pageKey] ?? "none"` (`:427`), `*` short-circuits to `full`
(`:422-426`), default `minLevel = "partial"` (`:416`). Ranks are
`full=3, edit=2, view=1, partial=1, none=0`
(`backend/src/services/pageAccess.ts:703-716`). Frontend mirror:
`frontend/src/auth/PageGuard.tsx:35-75`, which renders `<Forbidden>` inline and
preserves the URL (`:72`).

**A page-access level of `edit` grants no write.** Every `requirePageAccess(...)`
in `routes/projects.ts` uses the default `minLevel="partial"` (rank 1) and
appears **only on GET routes**; every mutating route uses `requirePermission` /
`requireAnyPermission` against the role permission set. So
`projects.list = edit` lets you read, and nothing more. (There is no permission
key spelled `projects:edit`; the colon form is a page-access *level*, not a key.)

### Axis 2 — row visibility: org fields + a role flag + brands, NOT the matrix

`backend/src/services/projectAcl.ts` is the single source, and every read-ACL
below keys off the same predicate.

`isScopedProjectUser(user)` (`:30-34`) — two ways to be scoped:
1. the role carries `scope_to_pic`;
2. `isSalesUser(user) && !isDirectorUser(user)` — added 2026-07-15 because some
   Sales positions have roles *without* `scope_to_pic`, so `getProjectScope`
   returned `null` and the list applied no ACL at all, **fail-OPENing a non-PIC,
   non-director rep to every project** (`:21-28`).

`getProjectScope(user)` (`:56-63`) returns `{ pic_ids, brands }` or `null`.
`null` means **unfiltered** — admins, ops and finance run unscoped queries
(`:49-51`). `pic_ids` is `[user.id, user.manager_id]` (the one-hop PIC rule);
`brands` is `user.brand_scope`, the union of the user's own and their manager's
`user_brands` rows (`services/auth.ts:280-298`).

`canSeeProject` (`:122-146`) is the hard gate, and it fails closed five ways:
outside the grace window (`:133`), null effective PIC (`:135`), PIC outside the
one-hop line (`:137`), **empty brand list** (`:143`), **project with no brand**
(`:144`). The last two are deliberate: a scoped user whose department has no
brands sees nothing, which forces admins to configure department brands
explicitly.

`PIC_GRACE_DAYS = 4` (`:86`) — a scoped PIC keeps a project until 4 days after it
ends, then it drops out of their list and detail. The predicate is
`scopeNotExpiredSql` (`:91`); unscoped roles are unaffected.

`effectivePicId` (`:78-81`) falls back to `created_by`, so projects created
before migration 039 stay visible to their creator's team without a backfill.

### Axis 3 — write authority: the ROLE permission matrix

Flat strings from `roles.permissions`. The catalogue is
`backend/src/services/permissions.ts:27-34`:

| Line | Key | Verb |
|---|---|---|
| 27 | `projects.read` | read |
| 28 | `projects.chat` | write |
| 29 | `projects.checklist.tick` | write |
| 30 | `projects.write` | write |
| 31 | `projects.approve` | manage |
| 32 | `stock_transfer.approve` | manage |
| 33 | `agreement.approve` | manage |
| 34 | `projects.manage` | manage |

### Within a project — a fourth, finer layer

`backend/src/services/pmsAccess.ts` decides what a person sees *inside* a project
they can already see. `getPmsRole(user, project)` (`:212-231`) returns
`DIRECTOR | PIC | SALES | …` by dispatching on `position_name` regexes and
`pic_id === user.id`; `getPmsAccess` (`:251`) turns that into a capability set
that strips sections. `financeHiddenForUser` (`:330`) and `isFinanceViewer`
(`:319`) are DIRECTOR-only tests.

`DIRECTOR_POSITION_NAMES` (`:93`) is `{Super Admin, Sales Director, Finance
Manager}` plus `*`, matched on **exact normalised names**. It used to be a
`\b…\b` regex; the comment at `:82-92` records that it was tightened to exact
match because a position rename could otherwise silently grant director access.
The frontend copies in `frontend/src/auth/salesAccess.ts` must stay in lockstep
and are pinned by tests.

### Permission keys that do not mean what their labels say

- **`stock_transfer.approve` and `agreement.approve` are dead.** Zero non-declaration
  references in `backend/src`. `routes/projects.ts:747-757` explains it:
  `projects.approve` is the only value ever written to
  `project_checklist.required_perm`. Worse, granting one used to **break** the
  holder — a live incident on 2026-07-16 where taking the approver branch
  replaced the role fallback and emptied "My Pending" instead of filling it. The
  fix was to hard-code `GATING_APPROVE_PERMS = ["projects.approve"]` (`:764`).
  Both keys remain toggleable switches in Team > Positions.
- **`projects.read` is labelled "See the Projects tab and open project detail
  pages" and does neither.** No route in `routes/projects.ts` is gated on it —
  reading the Projects tab is `requirePageAccess("projects.list")`, a
  position-derived level. What `projects.read` actually gates is
  `/api/finance/pnl` + `/pnl/bucket` (`finance.ts:220`, `:390`), inbox filtering
  (`inbox.ts:192`, `:386`, `:484`), the phase-photo read (`projects.ts:2515`) and
  some frontend nav. It is a finance-P&L + inbox key wearing a view-projects
  label.
- **`projects.write` also widens row scope.** `isCrewScopedUser`
  (`routes/projects.ts:2817-2822`) treats holding `projects.write` as an escape
  from crew scoping, so granting the write permission silently widens a
  helper's or storekeeper's calendar and list from "my crewed events" to
  everything unscoped.

---

## 5. Venue binding — the precedence, and why it is a default and not a lock

One resolver, `backend/src/scm/lib/venue-binding.ts`. Before it, the same query
was written out three times in `mfg-sales-orders.ts` — the `/active-venue`
endpoint, the create-time venue text fallback, and the create-time `project_id`
link — and they had already begun to differ (`venue-binding.ts:1-16`). Desktop
and mobile share it by construction: both hit the same HTTP endpoints, neither
client re-implements it.

`resolveVenueBinding()` (`:176`), owner rule of 2026-07-19:

1. **PMS / exhibition** (`:184-197`) — the rep is the PIC **or** on the project's
   Sales Attending list, and the project's **period contains the ORDER's date**.
   → that project's venue, and its `projectId`.
2. **Showroom** (`:199-212`) — the rep is "parked under" a showroom on the
   Members page (`scm.staff.showroom_warehouse_id` → a `scm.warehouses` row
   flagged `is_showroom`). → that showroom's `venue_name`.
3. **Nothing** (`:214-215`).

Rule 3 is the important one. There is **no company default, no first-venue
fallback, no `?? ''`**. Venue feeds exhibition P&L and commission, so a guessed
venue is a wrong profit figure attributed to a real person; empty is honest and
visibly incomplete (`:26-31`).

Details that bite:

- A flagged showroom with a NULL `venue_name` resolves to **nothing**, not to the
  warehouse's name — a stock code (`KL-WH-02`) is not a venue and must never
  reach exhibition P&L (`:200-202`). `is_showroom` is re-checked at resolve time,
  not trusted from the parking row, so un-flagging a warehouse immediately stops
  it supplying venues without anyone having to unpark the staff under it
  (`:347-351`).
- The two bindings are deliberately **not** mutually exclusive. The owner
  considered forbidding a showroom-parked rep from being picked in PMS and chose
  the opposite: a showroom salesperson sent to an exhibition is normal and
  frequent, and exclusion would make the venue wrong precisely *during* the
  exhibition (`:33-38`).
- Ranking among overlapping projects is done **in TypeScript, not SQL**, so it is
  covered by tests: latest `start_date` → shortest period (open-ended sorts last)
  → lowest id (`compareCandidates` `:151-163`). `loadPmsCandidates` (`:281`)
  therefore issues **no date predicate and no LIMIT** — the old
  `ORDER BY start_date DESC LIMIT 1` hid a missing `end_date` check for a month
  (`:283-287`). The row count is bounded by "projects this one person is assigned
  to".
- Both halves are loaded **independently best-effort** (`:266-278`): a failing
  showroom lookup must not cost the rep their exhibition venue, and vice versa. A
  failure yields no candidates, which resolves to empty — never to a guess.
- `mfg_sales_orders.venue_source` (`'PMS' | 'SHOWROOM' | 'MANUAL' | NULL`) is what
  **protects a human's choice**. Once a person edits the venue the row is
  `MANUAL` and `canAutoResolveVenue()` (`:231-233`) refuses to let any later
  automatic re-resolve overwrite it. Without that marker a re-resolve could not
  tell "the resolver put this here" from "a human corrected this". NULL on a
  legacy row is *unknown provenance*, deliberately not read as MANUAL
  (`0148_venue_binding.sql`).

Migration `0148_venue_binding.sql` adds all three columns
(`scm.warehouses.is_showroom` + `venue_name`, `scm.staff.showroom_warehouse_id`,
`scm.mfg_sales_orders.venue_source`), all additive and nullable. Note
`showroom_warehouse_id` points at `scm.warehouses`, **not** at the vendored,
empty, POS-specific `scm.showrooms` table — one showroom vocabulary.

---

## 6. Exhibitions / fairs — the SO → project hard link

**Verified.** `scm.mfg_sales_orders.project_id integer` is added by
`backend/src/db/migrations-pg/0146_scm_so_project_id.sql` — nullable, no default,
no backfill, plus `idx_mfg_sales_orders_project_id`. **No foreign key**,
deliberately: `projects` lives in `public` and this table in `scm`, and a
cross-schema FK would couple a hot money-table insert to a public-schema
constraint check for a column whose job is to label rows for a report. The file
auto-applies to prod on deploy and a failed file blocks every later migration, so
an `ADD COLUMN` + `CREATE INDEX` that cannot fail on existing data was preferred
to an FK that could ever meet an orphan.

The migration header names the resolver as "the active-fair resolver in
routes/mfg-sales-orders.ts (createSalesOrderCore)". There is no function called
`resolveActiveFair` — it is `resolveVenueBinding` (§5). The route that surfaces it
is still *named* `/active-venue` (`mfg-sales-orders.ts:2215`), a name kept for
client compatibility (`:2200-2204`).

The stamp, inside `createSalesOrderCore` (`mfg-sales-orders.ts:2858`):

| Step | Line |
|---|---|
| `let projectIdToStamp: number \| null = null;` | `:3156` |
| `loadVenueBindingInputs({ db, sb, userId, staffId })` | `:3168-3172` |
| `resolveVenueBinding({ soDate: soDateForVenue, pmsCandidates, showroom })` | `:3179` |
| `projectIdToStamp = binding.projectId` | `:3180` |
| `project_id: projectIdToStamp` in the insert payload | `:4550` |

Three details that are load-bearing:

- The date used is **the ORDER's date, not today's** (`:3164-3167`) — a backdated
  slip must resolve against the fair that was running the day it was written,
  in MYT.
- `staffId` is the **salesperson the order is attributed to**, not the caller
  (`:3173-3177`): an admin keying an order in for a showroom rep must stamp the
  rep's showroom.
- `project_id` is resolved **even when the venue came from the client**
  (`:3151-3155`). The New-SO form pre-fills `body.venue` from `/active-venue`,
  which marks the row `MANUAL` — hanging the fair link off the venue branch would
  leave `project_id` NULL for exactly the flow the Fair Report needs.

The whole block is **non-fatal** (`:3185-3187`): no lookup failure may ever block
a sale.

**Consumer** — the Fair / Sales Report, `backend/src/scm/routes/reports.ts`.
Three stages (`stage=so | do | invoice`, `:590-592`), every stage anchored on the
fair via `project_id` (`:595`, filter `:673`), with `resolveProjects` reading
`public.projects` for name and period (`:702-713`) and `resolveFairRate` walking
fair → brand → `project_cost_rates` (`:770-773`). Access is enforced **per stage**
by `fairReportAccess` (`backend/src/scm/lib/fair-report.ts:79`, called
`reports.ts:800`, `:1123`):

- ordinary salespeople → 403 on every stage;
- **Sales Director → `stage=so` only** (403 on do + invoice);
- **management** → all stages, where management is `isFinanceViewer AND NOT a
  Sales Director` = `{*, Super Admin, Finance Manager}`. Deliberately not
  `canViewScmFinance` raw, because that cohort *includes* the Sales Director and
  would hand him the two stages the owner reserved (`reports.ts:600-606`).

No salesperson row-scope is applied, because both admitted tiers already see all
sales; widening the gate would require adding `resolveSalesScopeIds` here
(`reports.ts:607-611`).

Surfaces: `frontend/src/pages/scm-v2/FairReport.tsx` and
`frontend/src/mobile/MobileFairReport.tsx`. The module was renamed
**Fair Report → Sales Report** in the nav by #846 (`46e2ec29`); the files, routes
and handler names still say `fair`.

---

## 7. Database

### `projects` — and a schema-truth warning

`backend/src/db/schema.pg.ts:122-156` and
`backend/src/db/migrations-pg/0000_baseline.sql:389-420` both declare:
`company_id, id, code, name, stage, status, start_date, end_date, venue,
venue_address, brand, pic_id, created_by, created_at, updated_at, archived_at`,
the four setup/dismantle timestamps, the driver/lorry/helper FK columns, plus
`setup_crew` / `dismantle_crew` from `0015_checklist_amendments_schema.sql:24-25`.

**But live SQL selects columns that appear in neither.** `p.organizer`,
`p.state`, `p.event_type_id` and `p.payment_status` are read by the calendar and
list handlers (e.g. `routes/projects.ts:3860-3861`), and
`migrations-pg/0002_indexes.sql:124` creates `idx_projects_payment ON
projects(payment_status)`.

> **State vocabulary (mig 0175, owner 2026-07-22).** `projects.state` and
> `project_venues.state` are now canonicalised to the `scm.my_localities`
> Title Case spelling (`Johor` / `Kuala Lumpur` / `Pulau Pinang` — not the
> old PMS UPPERCASE `JOHOR` / `KL` / `PENANG`). Backend `createProject`,
> `patchProject`, and `POST/PATCH /api/scm/venues` all run every incoming
> `state` through `canonicalizeMyState()` (`backend/src/scm/lib/canonical-state.ts`);
> the SQL function `scm.canonicalize_my_state()` in mig 0175 is the same
> mapping for future migrations. Cross-module Sales-by-state and
> delivery-region reports can now bucket on the raw column without a
> normalisation step in the query. Those columns exist only in the D1-era definition
(`backend/src/db/d1-schema-dump.sql:988-1029`, added by `migrations/024`, `026`,
`039`, `083`, `088`, `101`), which also carries `booth_no`, `size_sqm`,
`notion_url`, `notes`, `archived_by`, `banner_message`, `banner_tone`, and the
`payment_proof_*` / `payment_notes` / `payment_updated_*` set.

> **UNVERIFIED: how those columns come to exist on the production Postgres.**
> A grep of `backend/src/db/migrations-pg/` for `ALTER TABLE projects` returns
> only `0015` (crew columns) and `0098` (a default change). They are presumably
> part of the D1 → Supabase data import rather than a tracked migration, but no
> file in the tree proves it. Treat `schema.pg.ts` as *incomplete* for this
> table, not authoritative.

### `project_*` tables (`backend/src/db/schema.pg.ts`)

| Line | Table | Notable columns |
|---|---|---|
| 159 | `project_phase_photos` | project_id, phase, r2_key, caption, uploaded_by |
| 171 | `project_brands` | name (unique), color, sort_order, active |
| 206 | `project_activity` | project_id, user_id, action, from_value, to_value, note, created_at |
| 219 | `project_reads` | PK (project_id, user_id), last_read_at |
| 500 | `project_finance` | project_id PK, rental, total_sales, contractor_cost, license_fee |
| 510 | `project_checklist_sections` | project_id, name, sort_order, display_mode |
| 533 | `project_checklist_attachments` | item_id, r2_key, uploaded_by, archived_at, caption |
| 552 | `project_checklist` | project_id, section_id, seq, title, **required_perm**, role_label, crew_visible, due_date, due_offset_days, owner_user_id, status, review_status, rejection_reason |
| 577/586 | `project_checklist_templates` / `_template_items` | + `requires_review` |
| 678 | `project_finance_lines` | project_id, kind, category, amount, occurred_at, r2_key, archived_at, auto_source |
| 696 | `project_cost_rates` | brand (unique), transport_pct, merchandise_pct, commission_normal_pct, commission_boost_pct, boost_min_gp_pct, boost_min_sales |
| 786 | `project_sales_attendees` | PK (project_id, sales_rep_id) — **the table the venue resolver and the calendar attendee arm both join through** |

`user_brands` (`schema.pg.ts:181-189`) feeds `brand_scope`.

Referenced in SQL but **absent from `schema.pg.ts`**: `project_venues`,
`project_organizers`, `project_event_types`, `project_attachments`,
`project_defects`, `project_team`, `project_stock_transfers`,
`project_sales_reports`, `project_checklist_comments`. They exist in
`0002_indexes.sql` and `d1-schema-dump.sql`.

`project_venues` itself is defined in `backend/src/db/migrations/038_venues.sql:8-16`
(`id, name UNIQUE, state, notes, active, created_by, created_at`), seeded from
distinct `projects.venue` values (`:20-25`); `company_id` was added by
`migrations-pg/0093_native_tables_company_id.sql:66-67`.

### Indexes (`migrations-pg/0002_indexes.sql`)

On `projects`: `archived_at` `:122`, `brand` `:123`, `payment_status` `:124`,
`pic_id` `:125`, `stage` `:126`, `start_date` `:127`, `status` `:128` — **all
single-column**. Children get `idx_pc_project(project_id, seq)` `:95`,
`idx_pc_due(due_date)` `:93`, `idx_pc_owner(owner_user_id, status)` `:94`,
`idx_project_activity_project_created` `:117`,
`idx_project_checklist_project_due` `:118`,
`idx_project_phase_photos_proj_phase` `:119`, `idx_project_reads_user` `:120`,
`idx_project_sales_attendees_rep` `:121`, plus `idx_pfl_*` `:105-107`.

There is **no index on `projects(company_id)` and no composite covering the hot
list predicate** (`archived_at IS NULL` + company + brand + start_date), so the
list's `SELECT COUNT(*)` (`services/projects.ts:1631`) leans on single-column
indexes only.

---

## 8. Who can see / do what — summary

| Actor | Projects list & detail | Calendar | Finances | Writes |
|---|---|---|---|---|
| `*` (owner / IT) | everything | whole calendar | yes | everything |
| DIRECTOR positions (`Super Admin`, `Sales Director`, `Finance Manager`) | **every** project's full detail (`projectAcl.ts:5-11`) | whole calendar (`projects.ts:3779-3784`) | yes, if `projects.finances` level allows | per their role permissions |
| Unscoped non-admin staff (logistics, ops, purchasing) | unfiltered | whole calendar (`:3785-3790`) | per page level | per role |
| Scoped Sales rep | PIC one-hop **AND** department brand **AND** within `PIC_GRACE_DAYS` of the end date, OR on the Sales Attending list | their assigned venues/projects only — **no grace predicate here** | money columns are blanked server-side (`projects.ts:845-853`) | per role |
| Crew (Driver, Helper, Storekeeper, Storekeeper Supervisor) | forced to `assigned_to_me` (`:837-841`) | only events they are crewed on (`:3791-3793`) | `projects.finances: none` | phase photos on their assigned phase; checklist ticks |
| Anyone holding `projects.write` | escapes crew scoping entirely (`:2820`) | | | |

Enforcement points, in one place:

- **Page entry** — `requirePageAccess(...)` on every read route
  (`middleware/auth.ts:414-437`), resolved from POSITION by
  `services/positionPolicy.ts` via `services/auth.ts:328-344`. Frontend mirror:
  `PageGuard` (`frontend/src/auth/PageGuard.tsx:35-75`).
- **Row visibility** — `services/projectAcl.ts`: `getProjectScope` (list,
  calendar, notifications), `canSeeProject` (detail, print),
  `projectAccessLevel` (render tier).
- **Within-project sections** — `services/pmsAccess.ts` `getPmsAccess`.
- **Writes** — `requirePermission` / `requireAnyPermission` against
  `roles.permissions`.

### Desktop and mobile files that must change together

| Change | Desktop | Mobile |
|---|---|---|
| Project list, cards, filters | `pages/Projects.tsx:949` `ProjectsListView` | `mobile/MobilePMS.tsx` |
| Project detail, checklist, crew, photos, defects | `pages/Projects.tsx:4756` / `:5919` | `mobile/MobilePMS.tsx` (same file) |
| Calendar | `pages/Projects.tsx:3034` | `mobile/MobileCalendar.tsx` |
| Gantt | `components/ProjectGantt.tsx` | `mobile/MobileGantt.tsx` (rendered from `MobilePMS.tsx:1603`) |
| Fair / Sales Report | `pages/scm-v2/FairReport.tsx` | `mobile/MobileFairReport.tsx` |
| Activity / read-marking | `components/ProjectChat.tsx` | `mobile/MobileInbox.tsx` (`POST /:id/read` at `:115`) |
| Maintenance masters (brands, event types, organizers, venues) | `pages/ProjectMaintenance.tsx` | **no mobile counterpart** |
| Venue resolution | — | — shared server-side in `backend/src/scm/lib/venue-binding.ts`; neither client re-implements it |
| Director / sales cohort names | `backend/src/services/pmsAccess.ts` | `frontend/src/auth/salesAccess.ts` — must stay in lockstep, test-pinned |

---

## 9. Performance summary

Optimized:
- Desktop list windows past 30 rows via the shared `DataTable`
  (`frontend/src/components/DataTable.tsx:244-250` — `VIRTUAL_ROW_THRESHOLD 30`,
  `VIRTUAL_OVERSCAN 12`, runtime-corrected row height; effect at `:974`). No-op
  for grouped/expandable tables and short lists.
- Mobile screens are all `React.lazy` (PR #426, `MobileApp.tsx:34/38/55`).
- The mobile project list is **both** windowed and paged: `MobileVirtualList`
  (`MobilePMS.tsx:5`, used `:544`) plus an `useInfiniteQuery`
  (`:458-468`) fed by an IntersectionObserver sentinel with a 600px pre-load
  margin (`:472-480`).
- `ProjectGantt.tsx:320` — holiday-day list hoisted to a `useMemo` keyed on
  range, O(lanes × days) → O(days) (PR #429).
- **The status filter is server-side now.** `docs/perf-optimization-plan.md:101-103`
  still lists **B1** as a P0 — "`Projects.tsx:999` fetches `per_page:1000` to
  filter client-side". **That item is stale**: no `per_page: 1000` exists in
  `Projects.tsx` at this commit, and `:1069-1075` documents the server-side
  `status` param with `per_page` staying at `perPage`. Do not act on B1 without
  re-checking.
- The main list keeps rows on screen across filter/page switches
  (`keepPreviousData`, `:1083`).
- Money is stripped server-side rather than hidden client-side
  (`routes/projects.ts:845-853`).

Watch, in rough order of size:

- **`getProjectDetail` (`backend/src/services/projects.ts:655`) issues ~16
  fully sequential awaited queries — there is no `Promise.all` in the function.**
  Project, finance, checklist, sections, attachments, activity, team, trips,
  defects, sales reports, ledger lines (itself a nested call), sales entry lines,
  stock transfers, sales attendees. That is ~16 serial round-trips on every
  detail open, and mobile refetches detail on a 15s `staleTime`
  (`MobilePMS.tsx:659`). This is the single largest backend hotspot in the module
  and it is **not** in `docs/perf-optimization-plan.md`. The SO list's
  concurrent-enrichment-wave pattern (PR #416, see
  [`sales-order.md`](./sales-order.md) §3) is the fix shape.
- The calendar handler runs two queries sequentially (`:3859`, `:3884`), the
  first with a **correlated subquery per project row** for
  `active_section_name` (a nested `EXISTS`) plus a second correlated `COUNT(*)`
  (`:3863-3873`) — O(projects × sections × checklist) per month load, with only
  `idx_pcs_project` and `idx_pc_project` to lean on. `ProjectsCalendarView` is
  also unvirtualized: 42 cells built eagerly (`Projects.tsx:3249-3255`) with the
  whole month held in memory and filtered client-side (`:3256-3262`).
- `GET /summary` runs 4 sequential aggregates with no `Promise.all`
  (`routes/projects.ts:672, 684, 695, 700`).
- Open items in `docs/perf-optimization-plan.md`, verified still present:
  **B7** `:117` (two unbounded `/api/users` fetches per detail open —
  `Projects.tsx:4774`, `:4788` — plus a third at `:4477` in
  `CreateProjectPanel`); **B8** `:119` (`ProjectChat.tsx:91-96`, whole activity
  history, no `?limit`); **D1** `:136` (`ProjectMaintenance.tsx:1088-1089`, a
  `findIndex` inside `items.map`); **D2** `:138`.

> **The perf plan's PMS line references have drifted — re-check before acting.**
> Verified at this commit: **B1** `:101` is stale (the `per_page: 1000`
> fetch-all is gone, status is a server param). **W3** `:91` lists
> `MobilePMS.tsx:476` as still needing `MobileVirtualList`; it is already
> adopted at `MobilePMS.tsx:544`. **D4** `:142` cites `Projects.tsx:1040` for
> `columns`; `const columns` is at `:1166` (list) and `:2162` (finance) — the
> concern is real, the line is wrong.

No load test or measured latency figure exists for this module; every claim above
is structural, read from the code.

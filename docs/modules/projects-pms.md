> ## Corrections — 2026-08-12 code-read sweep
>
> 1. ~~PIC_GRACE_DAYS is 30~~ — OBSOLETE 2026-08-19: the PIC/brand row-level ACL (`projectAcl.ts` [gone]), including the grace window, was removed. See Axis 2.
> 2. isFinanceViewer admits projects.finance.view holders before the director test (pmsAccess.ts:335-344); financeHiddenForUser inherits that.
> 3. stock_transfer.approve/agreement.approve are NOT dead: pmsAccess.ts:260-261 grants WF_SENSITIVE visibility; permissions.ts:216-232 EXPLICIT_APPROVAL_KEYS gate checklist tick/status/review (projects.ts:3815,:3845,:3878).
> 4. The catalogue also carries stock_in.approve and projects.finance.view (permissions.ts:34-49).
> 5. For the four EXPLICIT_APPROVAL_KEYS, * does NOT confer the key (permissions.ts:223-232) — a bare-* admin cannot tick an approval-gated item.
> 6. denyFinance (403) sits on /api/finance/pnl and every projects money read (finance.ts:234,:404; projects.ts:591…:2897) — projects.read alone no longer reads P&L.
> 7. POST /:id/read (a write) is gated by requirePageAccess only (projects.ts:2576).
> 8. Fair Report has FOUR stages — pnl added, management-only (fair-report.ts:25-26); management = isFinanceViewer && !salesDirector (:58).
> 9. Defect review is region-split since 2026-08-11: Ops Exec for {Pulau Pinang, Kelantan, Terengganu, Perak} (projects.ts:1072-1087,:3709), Shukor the complement; both lanes time-boxed to events ended within 30 days.
> 10. CREW_SCOPED_POSITIONS = {helper, storekeeper, storekeeper supervisor} — Driver is NOT list-crew-scoped (projects.ts:3703); drivers are caged only on the calendar (:4863-4869).
> 11. idx_pfl_occurred is mig 0221/133, not 0213/132.

# Module: Projects / PMS

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

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
| Lookup masters (brands, event types, organizers, contractors, venues, default checklist) | `frontend/src/pages/ProjectMaintenance.tsx` | 2,099 |
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

**`ProjectSpecStrip` — what shows at rest vs behind Edit.** The strip under the
"Project Detail" header is two layers gated by one `editing` flag. At rest it
renders exactly **Start · End · Size · sqm · Rental · RM** in a 4-column grid —
the two dates and the two numbers the owner reads at a glance (owner 2026-09-03:
"frontend only should have start date / end date / rental / size, other details
keep hidden behind edit"). Everything else — Brand, Event Type, Created,
Duration, Booth, Venue, State, Organizer, Contractor, Name, Add-to-Calendar —
lives inside `{editing && (<>…</>)}` blocks and appears only after the Edit
button (`fullAccess` only). When adding a field, put it in an edit-only block
unless the owner has asked for it on the resting row; the resting set is pinned
by `projectDetailEdit.test.tsx` ("shows only Start, End, Size and Rental until
Edit is clicked"). Size keeps its `DetectSizeButton` and Rental its
`QuickRentalField` in both modes — those two write on their own, without Edit.

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

**BOTH halves of that merge are company-scoped** — the showroom half only since
2026-08-20. This paragraph used to say "`GET /venues` filters by the active
company" a few lines below and that was true of the `project_venues` half ONLY:
the showroom half read `scm.warehouses WHERE is_showroom = true AND is_active =
true` with no `company_id` predicate, so every company's venue picker listed
every company's showrooms. Measured on prod before the fix: HOUZS's picker
carried 2990's `PJ SHOWROOM` / venue `2990s PJ`. Owner's ruling — *"客人开单不能
看到 2990 的展厅啊…我们的 Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着
看到自己公司的"*. The showroom SELECT now carries
`activeCompanySql(c, "company_id")`, and `backend/tests/showroomVenueCompanyScope.test.ts`
fails if either half loses its predicate. `GET /staff/showrooms`
(`backend/src/scm/routes/staff.ts`) had already scoped its copy of the same list;
this was the half that was missed.

The SO **active-venue autofill** carries the same lock since the same date:
`GET /mfg-sales-orders/active-venue` maps the resolved venue TEXT onto a
`project_venues` id by name, and that lookup is now scoped too — venue names are
not unique across the two masters, so an unscoped match could hand one company
the other's venue id. A name this company does not master still resolves to
`venueId: null` with the TEXT standing, which is the documented fallback.

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

**Checklist TEMPLATES carry that same lock since PG mig 0292** (owner decision
2026-08-13: *应该按公司分开*). They were the odd ones out — company-BLIND on the
read *and* the write side, i.e. one shared master both companies edited — while
`project_brands` and `project_venues`, in the same router and stamped by the same
mig 0093, were already split. The templates are a PER-COMPANY master now:

- **Reads.** `GET /checklist-templates` filters on `activeCompanySql(c, "t.company_id")`.
  `GET /sections-distinct` and `GET /task-titles-distinct` resolve their
  "newest active template" `MAX(t.id)` *inside* the company — company-blind, they
  handed one company the other's stage names whenever the other owned the higher id.
- **Template id in the URL** (`/checklist-templates/:id/...`) resolves through
  `findTemplateInCompany(c, id)` and answers **404** on a miss — the same answer as
  "no such template", deliberately, because confirming another company's id exists
  is itself a leak.
- **Child id in the URL** (`items/:itemId`, `sections/:sectionId`) is scoped by the
  row's own `company_id` exactly as `PATCH /venues/:id` is, and returns **404** on a
  scoped miss instead of a silent `ok`.
- **Creates** resolve via `requireActiveCompanyId(c)` and **refuse with
  `company_unresolved` (409)** rather than falling through to the `NOT NULL DEFAULT
  <HOUZS>` column default, then stamp `company_id` — *and* re-check the parent
  template, because a stamp is not a predicate: stamping the new item says nothing
  about whose template it was hung under.

Not covered, deliberately: `project_event_types.default_template_id`, the pointer
the clone-on-create path (`services/projects.ts::instantiateChecklistFromEventType`)
follows into a template. `project_event_types` carries **no `company_id` at all** —
mig 0093 did not stamp it — so there is nothing to scope it by. Making event types
per-company is a separate owner decision, not an implementation detail to invent.

A venue carries an optional free-text `size` column (PG mig 0222) — the owner
writes a physical area (`"12,000 sqft"`) or a hall label (`"Hall 3"`), so it is
`text`, not a number. It is read in `GET /venues`, and accepted on `POST`
(INSERT + reactivate upsert) and `PATCH`. `VenueManager` edits it inline (add-row
column + a per-row input committed on blur). Synthetic showroom rows report
`size: null`. The country/city/postcode columns the add-form also posts (mig
0178/0182) are NOT yet read or written by these handlers — only `name`, `state`,
`size`, `notes` are persisted.

**Venue NAMES are canonicalized on write, in two layers.** The same showroom used
to appear as both "PJ Showroom" and "2990s PJ" because `projects.venue` is free
text and both prior cleanups were one-shot backfills with no guard, so the drift
came back. The rule now lives in `backend/src/scm/lib/canonical-venue.ts`
(`VENUE_CANONICAL_MAP` + `canonicalizeVenue()`), applied at `createProject` /
`patchProject`, `POST /venues` (an alias folds into the ONE canonical picker row
instead of spawning a duplicate), `resolveVenueBinding`, and read-time in the
by-venue P&L grouping — and, since PG mig **0229**, in the database itself:
`scm.canonicalize_venue()` plus a `BEFORE INSERT OR UPDATE` trigger on
`projects.venue`, `project_venues.name`, `scm.mfg_sales_orders.venue` and
`scm.warehouses.venue_name`, so a write that never goes through a route cannot
re-introduce an alias. NULL and blank are left alone — this unifies known
aliases, it does not assign a venue. **Adding an alias means editing four files
together** (the TS module, PG mig 0229, its D1 parity file, and
`backfill-canonicalize-venue.mjs`); `backend/tests/venueCanonicalSql.test.ts`
fails the build if they fall out of step.

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
| Reads of lookups | `requirePageAccess("projects")` | `GET /organizers` `:887`, `GET /contractors`, `GET /venues` `:939`, `GET /sections-distinct` `:869` |
| Calendar | `requirePageAccess("projects.calendar")` | `GET /calendar/events` `:3756` |
| Money reads | `requirePageAccess("projects.finances")` | `GET /cost-rates` `:559`, `GET /finance/by-project` `:2001`, `GET /finance/lines` `:2209`, `GET /analytics/profitability`, `GET /analytics/profitability/drill` (L2 months / L3 projects drill-down) |
| Ordinary writes | `requirePermission("projects.write")` | finance lines, payments, stock transfers, defects, team, sales attendees, attachments, sections. Current count is in `docs/generated/route-capability-matrix.csv` — do not type it here |
| Admin writes | `requirePermission("projects.manage")` | event types, brands, cost rates, archive/unarchive, checklist templates, CSV import. Same — read the generated matrix |
| Checklist ticking | `requireAnyPermission(["projects.write","projects.checklist.tick"])` | `PATCH /checklist/:itemId` `:2792`, `/status` `:2843`, `/review` `:2887`, attachments `:3071`, `:3170`, `:3215` |
| Chat | `requireAnyPermission(["projects.write","projects.chat"])` | `POST /:id/notes` `:1832` |
| Unguarded by middleware | — | small public lookups (`/states` `:858`, `/payment-statuses` `:859`, `/brands` `:204`, `/event-types` `:104`, `/finance/categories` `:1987`), the attachment stream `:3690`, and the **phase-photo** routes `:2427`, `:2472`, `:2507`, `:2539`, which carry an inline permission-OR-crew check instead |

**Contractor field (2026-09-02).** Each project carries a free-text `contractor`
(`projects.contractor`, mig `20260902T1224_projects_contractor.sql`) — the booth
setup/dismantle contractor, chosen on the Detail page (`ContractorPicker` in
`Projects.tsx`) and accepted by `PATCH /:id` via `PATCH_FIELDS` in
`services/projects.ts`. Options come from a `project_contractors` picker table on
the exact organizer pattern: `GET /contractors` (read), `POST /contractors`
(`projects.write`), `DELETE /contractors/:id` (`projects.manage`), managed by
`ContractorManager` in `ProjectMaintenance.tsx`. Feeds the planned per-contractor
calendar share links.
**The role BADGE is the second half of the checklist-tick gate, and the UI must
ask it too.** A caller holding `projects.checklist.tick` but **not**
`projects.write` may attach, edit, delete and status-change only on tasks whose
`role_label` admits their role — `roleLabelAdmits(label, role_name)` in
`backend/src/services/projectGates.ts`: any "&"-separated part equal to the
role, plus DRIVER-badged field work admitting HELPER / STOREKEEPER. An unbadged
task admits nobody on this path. That population is not theoretical: the
Purchaser role (330) lost `projects.write` on purpose in bug 0489 so exactly
this scoping would apply to it.

The desktop had twice disagreed with the server by omitting it — the Attach
button (bug 0546) and then the file-delete trash (bug 0628) asked
`projects.write` alone, so the purchasers saw no control on the documents they
themselves file while the API accepted the request. The rule now lives once, in
`frontend/src/auth/roleLabelAdmits.ts`, imported by BOTH desktop and mobile.
**When adding a control the tick path can reach, gate it on the badge, not on
`projects.write`.**

**Removing a file follows ATTACH on both surfaces** (owner 2026-09-03: *"every
user can delete/remove file or image from their own task, both pc and mobile
pms"*), retiring the 2026-08-05 managers-only rule. Whoever may put a file on a
task may take one off it; `projects.manage` is no longer consulted for deletion
anywhere. Mobile carries THREE such gates — the file chip (`canRemoveFile =
canAttach`), the document tiles (`canDeleteFiles = canTick`, each use site also
ANDing `!t.readOnly`) and the floor-plan card (`canDeleteFiles = canWrite`) —
so a change here must visit all three, plus the desktop's `TaskAttachmentRow`
(`mayDeleteFile`) and `ChecklistRow` chip (`mayAttachRow`).

**The attachment stream (`GET /attachments/:key{.+}`) sends
`X-Content-Type-Options: nosniff` (PR #2522)** so its R2 object's server-derived
content-type cannot be MIME-sniffed into html/svg — parity with
`mail-center.ts`'s INLINE_SAFE serve.

**`PATCH /:id/finance` resolves the project in the ACTIVE COMPANY for every
caller (2026-08-14).** The project is loaded with the `activeCompanySql`
predicate first, so a cross-company id answers `404 Not found` before
`patchFinance` (which CREATES the snapshot row when missing) can run. The former
PIC gate on this write was removed 2026-08-19 (Axis 2); company scope + the
`projects.write` / finance gates remain.

**The P&L drill-down applies the same filters as its total (2026-08-14).**
`backend/src/routes/finance.ts` builds one `FROM … WHERE` fragment per source
(`projectCostFrom`, `serviceCostFrom`) and both `GET /pnl` and
`GET /pnl/bucket` interpolate it. The drill-down previously re-typed the
predicate and dropped both `company_id` and the `projects.archived_at IS NULL`
join, so the row list you get by clicking a cost bucket could not sum to the
bucket. If you add a filter, add it to the fragment.

**The company of a cost line is its PROJECT's (2026-08-21).** `projectCostFrom`
scopes on `p.company_id`, not on `project_finance_lines.company_id`. That column
is a denormalised copy added by mig 0170 and two writers never fill it —
`services/projectCostRates.ts` stamps it on INSERT only, so an auto row created
before 0170 keeps NULL through every later UPDATE, and the historical FAIR PNL
ledger seeds were written without it. Filtering on the copy DROPPED those rows
from `/api/finance/pnl` while `/projects/finance/by-project` and
`/projects/analytics/profitability`, which have always scoped on `p.company_id`,
counted them: measured on production 85 live cost lines carrying NULL, worth
RM 1,453,336.94, and ZERO lines whose copy disagreed with their project. The
column stays as provenance; it is not the scoping authority.

**`GET /finance/by-project` date semantics** (owner decision 2026-08-13): the
`date_from`/`date_to` range filters the SUMs *and* the rows — a project with no
non-archived line inside the window is dropped from the result, not rendered as
a zero row. With no range set, every project matching the other filters still
surfaces (upcoming events with no lines yet stay visible). Before this it
filtered only the SUMs, so a 2026 date filter listed 2025 fairs as RM 0.00 rows
— which read as "no data" and made search + date look like they didn't combine.

### Profitability analytics — rental column + L1→L4 drill-down

The Finances tab's **Analytics** sub-view (`Projects.tsx` `ProjectsAnalyticsView` +
`BreakdownCard`) groups every non-archived project's P&L four ways — **By Brand, By
Event Type, By Organizer, By Venue** (plus By Month) — and every level shows the same
columns: **Revenue · COGS · GP · Rental · NP · Margin**. `rental` is the
`category='rental'` slice of `cost` (`kind='cost'`), pulled out as its own visible
column; it does NOT change NP, which stays `income − cogs − cost`. `GET
/analytics/profitability` (L1) returns `rental` per group, in `totals`, and on the
top/bottom ranked rows.

**Four drill levels**, each carrying the parent filter down:
- **L1** the dimension list (exists) — a brand/organizer/venue/event-type row.
- **L2** click a dimension value → its performance **BY MONTH**.
- **L3** click a month → the individual **projects** in that month.
- **L4** click a project → navigate to `/projects/:id`.

L2/L3 are served by `GET /analytics/profitability/drill?dimension=<brand|event_type|
organizer|venue|month>&value=<L1 key>[&month=YYYY-MM]` — same date/brand/organizer/
event-type filters as L1, so a drill stays inside the group table's scope. With no
`month` it returns `{ level:"months", dimension, value, months[] }` (L2); with a
`month` it returns `{ level:"projects", dimension, value, month, projects[] }` (L3).
The `event_type` key is the type NAME; the dimension `month` is the **By-Month card**
special case (its L1 rows are start-date months carrying whole-project totals, so it
skips L2 and returns those whole-project rows directly).

**Lifecycle scope — `scope` (default `completed`).** Both endpoints accept
`scope=completed|started|all`; the UI holds it in the URL as `af_scope`.
`completed` = `p.stage='completed'`, `started` = `start_date <= today`, `all` = no
lifecycle filter. It defaults to settled-only because an unsettled event has its
rental and setup booked while sales are still being keyed, so counting it
understates profit — measured on prod 2026-07-29: `all` 720 projects NP RM -50,931
vs `completed` 528 projects NP **RM +710,285**. (The intuitive culprit, future
bookings, is NOT it: all 107 not-yet-started events carry RM 15,200 between them.
See BUG-HISTORY 2026-07-29.) **The drill endpoint keeps its own copy of the
project-level predicates**, so any new filter must be added to BOTH or a drilled
level totals a different population than the card it was opened from.

**Month binning** is on the finance line's own date — `COALESCE(occurred_at,
created_at)` (index `idx_pfl_occurred`, mig `0213`/`132`) — so revenue/cost lands in
the month it was recognised and the L2 month rows sum back to the L1 value total
(every line has exactly one month; the L3 project rows sum back to their L2 month).

**Drill state lives in the URL** (`ProjectsAnalyticsView`, repo "URL is state" rule):
the filters (`af_from`/`af_to`/`af_brand`/`af_org`/`af_type`) and the open drill path
(`dim`/`dv`/`dm`) are all query params, so a drilled view is shareable and Back
unwinds it one level. One drill path is open at a time. This dashboard is
**desktop-only** — mobile PMS is a single-project detail surface with no grouped
analytics.

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
**SALES REPORT SCOPE — everything except DRAFT and CANCELLED (2026-08-31).**
`fetchFairSos` (`scm/routes/reports.ts`) used to anchor on `status='CONFIRMED'`,
so an order LEFT the report the moment the floor delivered it — measured on
2990, **34 of its 49 delivery orders were invisible** and the DO tab showed 14
(owner: 「很多单都没进得来…可能因为我还没 delivered」). A fair's completed
business is still its business, so the predicate is now
`.not('status','in','(DRAFT,CANCELLED)')` for all four stages. Two neighbours
moved with it: the DO stage's LEGACY chip no longer counts SERVICE lines (the
delivery fee never carries a frozen ship cost, and it was pinning the chip on
11 of 14 rows), and a stock line frozen at ZERO against a real order-time
estimate now sets `do_cost_ship_anyway` so a ship-before-arrival DO reads as
"cost not captured at ship time" instead of a naked 100% margin. Bug
`docs/bugs/0575-the-book-s-none-placeholder-outranked-the-derived-branding-a.md`.

`/fair-report-fill`, nav "Fair Report Fill" under Projects) reads it in-browser
with SheetJS and calls:

> The finance gate is on the two ENDPOINTS, not on the page. The route carries
> only `<PageGuard page="projects">` (`frontend/src/App.tsx:488`) — the plain
> page key, not `projects.finances`; both handlers then call `denyFinance(c)` on
> top of their permission, and that is what keeps the money out. This paragraph
> used to say the page itself was gated `projects.finances`, which would have a
> reader looking for a frontend gate that is not there.

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
sheets; `rental`/`setup` come from the setup invoice (Job E — built and shipped; see §2 and `frontend/src/pages/SetupInvoiceFill.tsx`).

**That split is the module's central rule and its shape, but it is not an
invariant — two routes break it in opposite directions:** `POST /fair-report/match`
is a read gated by a ROLE permission (`projects.read`), and `POST /:id/read` is a
write gated by a page-access level. See §5.

Related routes elsewhere:
- `backend/src/routes/projects_print.ts` `GET /:id` — **no middleware gate**;
  the row-level gate is the company-scoped `getProjectDetail` load (a
  cross-company id prints "Not found"). The former `canSeeProject` PIC/brand
  gate was removed 2026-08-19 (Axis 2).
- `backend/src/routes/finance.ts:220`, `:390` — `GET /api/finance/pnl` and
  `/pnl/bucket`, gated on `projects.read`. `finance.ts:10` flags that
  `projects.read` alone gates a route that reads `project_finance_lines` cost.
  Its `scope` param means the COST DOMAIN (`all|sales|projects|service|po`), not a
  lifecycle — the Projects P&L tab passes `scope=projects`, which is why that tab
  shows cost with no revenue. `rawProjectCost` must JOIN `projects` and require
  `archived_at IS NULL`: archiving a project does NOT archive its finance lines, so
  without the join a removed project reports forever (RM 6.29M of RM 69.25M when
  measured 2026-07-29, PR #1401).
- `backend/src/routes/notifications.ts` `GET /` — **no permission gate at
  all**, deliberately (a Sales user who lacks the `projects.read` matrix
  permission still needs a bell). Scoped by COMPANY only
  (`allowedCompanyIds`); the former `getProjectScope` PIC/brand filter was
  removed 2026-08-19 (Axis 2).
- `backend/src/routes/events.ts` [gone] — **deleted on main** (`45d73689`: no frontend,
  ungrantable permissions, PMS covers it). It was the manual setup/dismantle
  calendar gated on `trips.read.all` / `trips.manage`, and was never the PMS
  calendar. Kept here because the absence is the fact worth knowing.
- `backend/src/scm/routes/reports.ts:1112`, `:1199` — the Fair / Sales Report.

---

## 3. Backend

### The list handler

`backend/src/routes/projects.ts` `GET /` → `listProjects` in
`backend/src/services/projects.ts`. It maps ~25 query params and passes
`company_id` (active company) + crew `assigned_user_id` down. The former
`pic_scope` / `brand_scope` / `attendee_user_id` ACL params were removed
2026-08-19 (see Axis 2). `per_page` defaults to 50, capped at 200.

Two things happen here that are easy to miss:

1. **Crew forcing.** For a crew-scoped caller, `assigned_to_me` is not a filter
   the client may choose — it is forced on (`:837-841`): a helper or storekeeper
   only ever sees the events they are crewed on.
2. **Server-side finance stripping.** The list SELECTs `pf.rental`,
   `total_sales`, `contractor_cost` per row, plus a **ledger-derived finance
   block** (`fin_revenue`, `fin_cogs` + the three `cogs_matt_sofa/bedframe/
   accessories` splits, `fin_rental`, `fin_total_cost`) via a single grouped
   `LEFT JOIN` over `project_finance_lines` (one aggregation, never a per-row
   fetch). These power the opt-in Revenue / COGS / GP / GP% / NP / Margin%
   columns in the desktop list chooser; GP / NP / percent are derived
   client-side (`Projects.tsx` column defs) from the raw sums so the numbers
   match the Finance tab (`/finance/by-project`). Every one of these money fields
   is blanked **before the response is written** (`financeHiddenForUser`) for
   ANY caller who has a position and is not a finance viewer — sales, logistics,
   ops and purchasing alike, not just sales. Finance viewer = DIRECTOR, or any
   holder of `projects.finance.view` (`pmsAccess.ts:335-356`). A position-less
   legacy user keeps the money. It never reaches the client, rather than being
   hidden in the UI.
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
   approve submitted stock documents, set the Sales PIC (`SALES_PIC_EMPTY` —
   `pic_id` NULL, dangling, or the HOUZS CENTURY house login id 1 that imports
   stamp as a placeholder), and set the Sales Attending reps
   (`SALES_ATTENDING_EMPTY`). Since 2026-08-21 (ledger 0490) the stock lane is
   TITLE-DRIVEN from the approval keys the director explicitly holds —
   `stock_transfer.approve` → Stock Out Transfer Record, `stock_in.approve` →
   Stock In Transfer Record (`pending_director.stock_titles`, built in
   `routes/projects.ts` my_pending mapping; the old Stock-Out-only
   `STOCK_OUT_AWAITING_APPROVAL` constant is gone). The owner / BD
   approve-holder branches likewise widen `pending_approve` with explicitly
   held stock/agreement keys, so a submitted Stock In finally reaches a lane
   (before 0490 it reached nobody's). The two staffing lanes are gated on
   `CONTRACT_CLEAR` — the project's CONTRACT section has no open item — so
   contract-stage projects stay the BD's pending, not the directors' (before
   the gate, every far-future imported event flooded their list; 110 rows on
   2026-07-23). The same CONTRACT gate applies to the Sales PIC's own
   attending lane. All in the `pendingOr` block, `services/projects.ts` around
   `:1447`. Three related 0489/0490 rules, same date:
   - **Uploads to a gated row auto-submit server-side** (attachments PUT):
     a gated, `pending`, not-in-review row flips to `pending_review` when a
     file lands, whichever client uploaded it — mobile never called
     `/review submit`, so phone uploads used to sit invisible to approvers.
   - **Keyless na/pending on a gated row is role-badge-scoped**: the
     `projects.write` exemption no longer extends it to other functions'
     rows (`projects.manage` still passes). Mirrored in the desktop
     `setItemStatus` guard. The Purchaser role (330) also lost
     `projects.write` — Sim/Farra are tick-only, fully badge-scoped.
   - **`my_pending_titles` excludes in-review rows**, so the purchaser card
     stops naming a document that is already with its approver.
5. **My Pending follows the timeline** (owner 2026-07-23): when any pending
   lane is active and no explicit `sort_by` is given, the list orders
   soonest event first (`start_date ASC`, nulls last) instead of the
   newest-first dashboard default — it is a work queue. A completed,
   N/A'd, or submitted-for-review task drops its row server-side the
   moment it changes state; nothing "done" ever lingers in My Pending.
   Two project-level gates sit on the whole OR-block, so every lane for
   every user inherits them: cancelled/'pending'-status events never
   surface (owner 2026-08-17), and neither does any event that ENDED
   before `MY_PENDING_EPOCH` = 2026-08-01 (owner 2026-08-24: the legacy
   backlog is deliberately incomplete — "just start bulan ni and onward
   saja"). The epoch is FIXED, not a rolling month, so a just-ended
   event's post-event tasks survive the month turn; it is a constant in
   `services/projects.ts` beside `DUE_GATE`.
6. **Defect items are a TWO-STAGE workflow** (owner 2026-08-07). Each defect
   photo on a "Defect Item Setup/Dismantle" task carries the append-only
   `project_checklist_attachment_actions` timeline, whose statuses are now
   **`done` | `replace`** (the old `ongoing` is retired; legacy rows read as
   "fresh"). Two actors, two lanes:
   - **Stage 1 — TWO reviewers, split by the project's STATE (owner 2026-08-11).**
     Projects whose state is in `DEFECT_REVIEW_REGION_STATES` — Pulau Pinang,
     Kelantan, Terengganu, Perak (`routes/projects.ts:3726`) — route to the Ops
     Exec (Nancy), keyed on **`role_name === "ops exec"`**; every other state
     routes to the Storekeeper Supervisor (Shukor), keyed on
     **`position_name === "Storekeeper Supervisor"`**, NOT role_name — his role
     is the shared "Storekeeper", which would otherwise cage him into the DRIVER
     lane. Both share the `pending_defect_review` lane (`:1072-1087`,
     `:1106-1108`). Neither lane is crew-scoped: `assigned_user_id` is
     suppressed for it, so each reviews defects on EVERY event in their arm, not
     just their crewed ones. Its predicate (`services/projects.ts`, `pendingOr`) is a live
     defect attachment whose LATEST action is `NOT IN ('done','replace')` — a
     fresh upload. Chip: a constant `Review Defect Items`.
   - **Stage 2 — the Purchaser (Sim / Farra, role `Purchaser`)** only sees a
     defect once Shukor ESCALATES it: the PURCHASER defect arm now matches
     LATEST action `= 'replace'` (was `<> 'done'`). They close it with `done`.
     Both purchasers share the lane (role-keyed), either can clear it.
   - **Endpoint gate** (`POST /checklist/attachments/:attId/actions`):
     `requireAnyPermission(["projects.write","projects.checklist.tick"])`
     (`:4273-4275`), then inline — reviewer (Storekeeper Supervisor OR Ops Exec)
     OR purchaser/BD OR `*`/`projects.manage`; `replace`
     is reviewer/admin-only (a purchaser cannot re-escalate). Both stages, both
     surfaces (`Projects.tsx` `TaskAttachmentRow` + `mobile/MobilePMS.tsx`
     `DefectFileActions`), gate the buttons on the attachment's latest status.

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

### Stock transfers and their tasklist mirror

`POST /:id/stock-transfers` (`services/projects.ts` `createStockTransfer`)
writes `project_stock_transfers` **and** mirrors the row into the tasklist:
`syncStockTransferTask` creates one `project_checklist` row linked by the notes
marker `auto:stock_transfer=<id>`, so a transfer is visible next to the rest of
the project's work. Confirm / unconfirm / delete re-sync or drop that row.

**The mirror row's title AND its `due_date` both come from one field,
`transferred_at`.** A blank one therefore used to produce a `due_date NULL` row
titled bare `"Stock OUT"` — invisible to the tasklist's date column, the Gantt
and every due-date rollup — and PERMANENTLY so, because
`redateChecklistFromOffsets` deliberately skips `notes LIKE 'auto:%'` rows (their
date follows the transfer, not the project schedule).

Since 2026-08-21 a missing `transferred_at` **defaults to today** (`todayMyt()`,
date-only) rather than being refused — default-never-refuse, the owner's standing
rule for this system. `todayMyt()` and not a raw UTC slice: Workers run in UTC,
so before 08:00 MYT a plain `toISOString()` files the transfer under yesterday.
The default is applied at CREATION only; `syncStockTransferTask` still renders a
legacy NULL row honestly rather than inventing a date for history.

**Mobile does not reach this endpoint at all.** `MobilePMS.tsx` files stock-out
records as CHECKLIST-TASK attachments (`uploadStockOut` →
`PUT /checklist/:taskId/attachments` + auto-submit for review), which is why the
project-level transfers list reads empty on the phone. A `uploadTransfer` helper
that did POST here lost its only call site on 2026-07-17 (`034e9a335`) and was
deleted as dead on 2026-08-21.

### The calendar handler

Since the PIC/brand ACL removal (2026-08-19) the rule is simply:

```
const seeAll = !!user && !crewScoped;
```

- Every authenticated **non-crew** caller sees the whole company calendar
  (the SQL still carries the active-company predicate `activeCompanySql(c,
  "p.company_id")`).
- `crewScoped` (helpers, storekeepers, storekeeper supervisors — **and drivers**,
  owner 2026-07-23, on THIS route only: `crewScoped = isCrewScopedUser(user) ||
  isScopedDriver`) **drops out of the see-all lane** and gets a crew-assignment
  arm instead — owner ruling 2026-07-21.

Crew-scoped callers get OR'd arms: the crew arm (6 FK columns plus a
`setup_crew`/`dismantle_crew` JSON name match) and the attendee arm
(`project_sales_attendees → sales_reps.user_id`). With no arms it fails closed
on ` AND 1 = 0`. The former scoped-PIC+brand arm and unscoped PIC-self arm were
removed with the ACL.

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
Supervisor, Calendar Viewer and the four Sales tiers, a position resolves to
`fullAccessMap()`, and a position the module cannot classify falls to FULL, never
to none — the anti-lockout guarantee (`positionPolicy.ts:12-19`). Project rows
for the crew cohorts are `projects: view`, `projects.finances: none`,
`projects.maintenance: none` (`:241-243`, `:253-255`, `:273-275`).

⚠ **The file is not only about PMS pages.** Because it is the whole page-access
authority for a positioned user, a non-PMS grant lands here too: the Sales
Director's row carries `scm.procurement.products: edit` and his flags carry
`canWriteConfig: true` (owner 2026-09-01 — he maintains product master data:
retail price, sofa combos, Model activation / Modular toggles). Nothing in PMS
moves, but a reader editing the sales cohort's rows for a projects reason is
also holding that grant in their hands. The SCM side of the catalogue is
`docs/PERMISSION-MATRIX.md`.

**Calendar Viewer is narrower still — the calendar and nothing else** (owner
2026-08-26, 「Calendar Viewer = 只有日历」). `CALENDAR_VIEWER_ROWS` grants
`projects: view` + `projects.calendar: view` but sets an explicit `none` on
`projects.list` / `.finances` / `.maintenance` so the L1 view does not cascade,
and an explicit `scm: none` so the position is honestly `scm_l2_configured` and
the SCM area-guard enforces the denial rather than deferring to the coarse
`scm.access` umbrella. The three OTHER office positions the owner reviewed the
same day — HR Manager, Service Admin, Procurement/Purchasing — stay on the
default-full interim and are deliberately absent from `RESTRICTED_ROWS`.

Enforcement: `requirePageAccess` (`backend/src/middleware/auth.ts:414-437`) reads
`user.page_access?.[pageKey] ?? "none"` (`:427`), `*` short-circuits to `full`
(`:422-426`), default `minLevel = "partial"` (`:416`). Ranks are
`full=3, edit=2, view=1, partial=1, none=0`
(`backend/src/services/pageAccess.ts:703-716`). Frontend mirror:
`frontend/src/auth/PageGuard.tsx:35-75`, which renders `<Forbidden>` inline and
preserves the URL (`:72`).

**A page-access level of `edit` grants no write.** Every `requirePageAccess(...)`
in `routes/projects.ts` uses the default `minLevel="partial"` (rank 1), and all
but one sit on GET routes; every other mutating route uses `requirePermission` /
`requireAnyPermission` against the role permission set. **The exception is
`POST /:id/read`** (`:2581`), a mark-as-read upsert into `project_reads` gated
only by `requirePageAccess("projects.list")`. So
`projects.list = edit` lets you read, and nothing more. (There is no permission
key spelled `projects:edit`; the colon form is a page-access *level*, not a key.)

### Axis 2 — row visibility: COMPANY only (PIC/brand ACL removed 2026-08-19)

**REMOVED — owner decision 2026-08-19.** There used to be a two-dimensional
row-level ACL here (PIC one-hop + brand allow-list + a 30-day grace window).
The service that implemented it — `services/projectAcl.ts`, which was **deleted**
in this change — exported `getProjectScope` / `canSeeProject` /
`projectAccessLevel` / `isScopedProjectUser` / `scopeNotExpiredSql`. It scoped a
Sales rep to projects where they (or their manager) were the PIC AND whose brand
sat in their `user_brands` list.

That whole file (`backend/src/services/projectAcl.ts` [gone]) and every predicate that
keyed off it were **deleted / removed**. Within a company, **any user with the
projects page permission now sees EVERY one of that company's projects**,
regardless of PIC or brand. Row visibility is governed only by:

1. **the projects page-access gate** (Axis 1 — `requirePageAccess`), and
2. **company scope** — the `company_id` / `activeCompanySql` predicate every
   project read carries. This widened visibility WITHIN a company; it did not
   touch the company boundary (a 2990 user still cannot see a HOUZS project).

The write side moved with it: the create/patch PIC restriction, the
`canPicProjectBrand` brand-on-PIC gate, and the `PATCH /:id/finance` PIC gate
were all removed. A `projects.write` holder may now edit any project in their
active company; the company predicate + the `projects.write` / `projects.finances`
gates remain.

`AuthUser.brand_scope` is now always `null` (vestigial — the signed-session
claims contract in `session-pass.ts` was left unchanged rather than reshaped in
the same change). **Crew scoping is a SEPARATE axis and is unaffected:**
helpers / storekeepers / drivers still see only the events they are crewed on
(`isCrewScopedUser`).

> `user_brands` and `GET/PUT /api/users/:id/brands` were **kept** — they still
> feed the DIRECTOR approval-lane brand split (`approverBrandBlocked` in
> `services/projectGates.ts`, owner 2026-08-10), which is a different axis from
> project visibility. Note the per-user brand-assignment UI (`UserBrandsPanel`
> in `frontend/src/pages/Team.tsx`) was removed, so those approval-split brands
> no longer have an edit surface; existing rows persist.

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

### Setup & Dismantle is VIEW-FOR-ALL — only its DOCUMENTS are role-filtered

Owner 2026-07-28: *"all users can view the setup & dismantle part."* The S&D card
is a read surface for every viewer of the project, on desktop and on mobile.

`stripSetupDismantle` (`backend/src/services/projects.ts:1083`) still runs for a
caller whose PMS role lacks `SETUP_DISMANTLE` — called from
`routes/projects.ts:2352` and `routes/projects_print.ts:332` — but what it
removes is now narrower than its name suggests:

| field | reaches a caller without `SETUP_DISMANTLE` |
| --- | --- |
| `setup_crew` / `dismantle_crew` / `service_crew` | YES (was NULLed until 2026-07-28) |
| `schedule_remark`, `setup_start_at`, `dismantle_start_at` | YES (was NULLed) |
| "SETUP & DISMANTLE DOCUMENTS" checklist rows badged DRIVER / PURCHASER | no — still stripped |
| the same rows badged `SALES PIC*` | YES (owner 2026-07-16 / 2026-07-29) |
| those rows' comments, attachments, sections, section-progress | stripped with their rows |

So the crew/schedule half of the card is no longer a server-side secret, and the
boundary that matters for it is the WRITE path: the PATCH route plus the UI's
`canWrite` / `canEdit` tier. The mobile surface matches — `MobilePMS.tsx` renders
`<SetupDismantle>` for every cohort but 5 and loads `phase-photos` for every
viewer — `GET /:id/phase-photos` (`routes/projects.ts:3188`) admits any
holder of `projects.read` or `projects.write`, and falls back to a crew phase
assignment for everyone else.

### Permission keys that do not mean what their labels say

- **`stock_transfer.approve` is dead; `agreement.approve` is NOT.**
  `stock_transfer.approve` has zero non-declaration references in `backend/src`.
  `agreement.approve` no longer gates a checklist item, but `getPmsAccess` grants
  the WF_SENSITIVE section (Agreement / Quotation) to any role holding it
  (`services/pmsAccess.ts:255-261`, owner 2026-07-29), so a non-director BD can
  see the document they approve. `routes/projects.ts:747-757` explains the
  checklist half:
  `projects.approve` is the only value ever written to
  `project_checklist.required_perm`. Worse, granting one used to **break** the
  holder — a live incident on 2026-07-16 where taking the approver branch
  replaced the role fallback and emptied "My Pending" instead of filling it. The
  fix was to hard-code `GATING_APPROVE_PERMS = ["projects.approve"]` (`:764`).
  Both keys remain toggleable switches in Team > Positions.
- **`projects.read` is labelled "See the Projects tab and open project detail
  pages" and does neither.** Exactly one route in `routes/projects.ts` is gated
  on it — `POST /fair-report/match` (`:701`). Reading the Projects tab is not —
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

**The same module also answers a question that is NOT resolution: what a
HALF-WRITTEN pair means.** `venueNameForHalfWrittenPair()` — a client that
resolved the venue id and not the name sends `venue: ""` beside a real
`venueId`, and read literally that deletes the venue. It returns three answers,
and `unresolved` (the master could not be read, or the id names nothing) makes
the caller leave the stored venue ALONE rather than write the blank. It lives
here, beside the binding rule, because the SO CREATE path already resolved a
name from an id in exactly this situation and a second copy is how the two paths
start disagreeing. Behaviour and repair: `docs/modules/sales-order.md` §Venue;
ledger `docs/bugs/0591-*`.

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
Four stages (`stage=so | do | invoice | pnl`, `scm/lib/fair-report.ts:26-27`; `pnl` is management-only, same as do/invoice), every stage anchored on the
fair via `project_id` (`:595`, filter `:673`), with `resolveProjects` reading
`public.projects` for name and period (`:702-713`) and `resolveFairRate` walking
fair → brand → `project_cost_rates` (`:770-773`). Access is enforced **per stage**
by `fairReportAccess` (`backend/src/scm/lib/fair-report.ts:79`, called
`reports.ts:800`, `:1123`):

- ordinary salespeople → 403 on every stage;
- **Sales Director → `stage=so` only** (403 on do + invoice);
- **management** → all stages, where management is `isFinanceViewer AND NOT a
  Sales Director` — `{*, Super Admin, Finance Manager}` **plus any role granted
  `projects.finance.view`**, so handing out that key also hands over the DO,
  invoice and P&L stages. The set is not closed. Deliberately not
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
| 171 | `project_brands` | name, color, sort_order, active — **plus `company_id` and `logo_r2_key`, which `schema.pg.ts` does NOT model** (migs 0093 / 0069). The `.unique()` on `name` in that file is drift too: production carries only `project_brands_pkey (id)`, and "bedframe" / "service" already exist under both companies (read-only run 32455140536, 2026-08-21). Treat the drizzle model as incomplete for this table; the raw-SQL handlers in `routes/projects.ts` are what production runs. |
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

Since 2026-08-19 (PIC/brand ACL removed) the top three rows collapse: any
non-crew user with projects page access sees the whole company set.

| Actor | Projects list & detail | Calendar | Finances | Writes |
|---|---|---|---|---|
| `*` (owner / IT) | everything | whole calendar | yes | everything |
| Any non-crew user with `projects.list` | **all projects in their active company** (no PIC/brand filter) | whole company calendar | per page level | per role |
| Crew (Helper, Storekeeper, Storekeeper Supervisor) | forced to `assigned_to_me` (`CREW_SCOPED_POSITIONS`) | only events they are crewed on | `projects.finances: none` | phase photos on their assigned phase; checklist ticks |
| Driver | **not** forced on the LIST — drivers are crew-scoped on the CALENDAR only | only events they are crewed on, calendar | `projects.finances: none` | phase photos on their assigned phase; checklist ticks |
| Anyone holding `projects.write` | escapes crew scoping entirely | | | |

Enforcement points, in one place:

- **Page entry** — `requirePageAccess(...)` on every read route
  (`middleware/auth.ts`), resolved from POSITION by
  `services/positionPolicy.ts` via `services/auth.ts`. Frontend mirror:
  `PageGuard` (`frontend/src/auth/PageGuard.tsx`).
- **Row visibility** — COMPANY scope only (`company_id` / `activeCompanySql`).
  The former PIC/brand ACL (`services/projectAcl.ts` [gone]) was removed
  2026-08-19 — see Axis 2.
- **Within-project sections** — `services/pmsAccess.ts` `getPmsAccess`.
- **Writes** — `requirePermission` / `requireAnyPermission` against
  `roles.permissions`.

### The four project-detail ACTION controls, and the rule each one must ask

Added 2026-08-20. Every control below is a live write button on the project
detail page. Desktop rendered all four with no permission condition at all (or
on a key the route does not read), so the operator clicked and got a raw 403;
mobile gated each of them. The desktop gate is now the rule the SERVER enforces,
and the two composite predicates live once, in `frontend/src/auth/salesAccess.ts`.

| Control | Route | Server rule | Desktop gate | Mobile gate |
|---|---|---|---|---|
| Archive / Restore | `POST /:id/archive`, `POST /:id/unarchive` | `projects.manage` | `can("projects.manage")` | `canManage` |
| Status dropdown | `PATCH /:id` | `projects.write` | `can("projects.write") && canEditDetail` | `canWrite && access.canEdit` |
| + Total Sales | `PATCH /:id/finance` | `projects.write` + `denyFinance` | `canWriteProjectFinance(user, can)` | `canWrite`, inside the finance-visible snapshot |
| + Quick Log / + New Sale | `POST /api/sales/entries` | `requirePageAccess("sales")` | `canLogSalesEntry(salesLevel)` | same helper |

Three traps this table exists to stop:

- **`disabled` is not a gate.** The Archive and Restore menu items each carried a
  `disabled` derived from `archived_at` — that is STATE. A state condition next
  to a missing permission condition reads, at a glance, as if the control were
  gated.
- **The sales READ rule is not the sales WRITE rule.** `GET /api/sales/entries`
  is `requirePageAccessOrSalesView`, whose extra arm admits Sales staff and
  directors by ORG POSITION; `POST /entries` is plain `requirePageAccess`. A
  Sales Director therefore READS the list and cannot WRITE to it, so the two
  gates on this one panel must not share a predicate.
- **`sales.write` gates nothing here.** It was the desktop condition on both
  write buttons and is a term in neither route, so it was wrong in both
  directions at once: it showed "+ Total Sales" to a rep the finance gate
  refuses, and hid it from a finance user holding `projects.write`.

`canWriteProjectFinance` mirrors `denyFinance` -> `financeHiddenForUser`
(`position_id == null` OR `project_finance_viewer`), NOT the per-project
`_access.pms.canFinancial` flag. The flag is the DIRECTOR-only section tier and
is a strict subset: it excludes the granular `projects.finance.view` holders
(the BD role, owner 2026-07-23) that the write route accepts.

### Desktop and mobile files that must change together

| Change | Desktop | Mobile |
|---|---|---|
| Project list, cards, filters | `pages/Projects.tsx:949` `ProjectsListView` | `mobile/MobilePMS.tsx` |
| Project detail, checklist, crew, photos, defects | `pages/Projects.tsx:4756` / `:5919` | `mobile/MobilePMS.tsx` (same file) |
| Defect-file action timeline (Done / Replace + remark) | `pages/Projects.tsx` `TaskAttachmentRow` `saveAction` | `mobile/MobilePmsDefectActions.tsx` — extracted from `MobilePMS.tsx` 2026-08-21 so the save path is renderable in a test; both surfaces must SURFACE a refusal |
| Calendar | `pages/Projects.tsx:3034` | `mobile/MobileCalendar.tsx` |
| Finances profitability analytics (group tables, rental column, drill-down) | `pages/Projects.tsx` `ProjectsAnalyticsView` / `BreakdownCard` | **no mobile counterpart** (mobile PMS is single-project detail only) |
| Gantt | `components/ProjectGantt.tsx` | `mobile/MobileGantt.tsx` (rendered from `MobilePMS.tsx:1603`) |
| Fair / Sales Report | `pages/scm-v2/FairReport.tsx` | `mobile/MobileFairReport.tsx` |
| Activity / read-marking | `components/ProjectChat.tsx` | `mobile/MobileInbox.tsx` (`POST /:id/read` at `:115`) |
| Maintenance masters (brands, event types, organizers, venues) | `pages/ProjectMaintenance.tsx` | **no mobile counterpart** |
| Venue resolution | — | — shared server-side in `backend/src/scm/lib/venue-binding.ts`; neither client re-implements it |
| Director / sales cohort names | `backend/src/services/pmsAccess.ts` | `frontend/src/auth/salesAccess.ts` — must stay in lockstep, test-pinned |
| P&L category labels | — | — shared in `vendor/scm/lib/pms-ledger-categories.ts`; neither surface labels a category itself |
| Which checklist rows carry Approve/Reject | — | — shared in `vendor/scm/lib/pms-reviewable-titles.ts` |
| Project STATUS values + payment-pill labels | — | — shared in `vendor/scm/lib/pms-project-status.ts`; each surface keeps only its own palette |

#### The shared PMS vocabularies, and why they are shared

`pms-status.ts` (workflow STAGE) was the first of these; three more joined it on
2026-08-21 after a desktop-vs-mobile audit found each one hand-written twice:

| Module | Owns | What the duplication had already cost |
|---|---|---|
| `pms-ledger-categories.ts` | the P&L picker lists + `ledgerCategoryLabel` | desktop mapped the slugs, mobile ran a generic `humanize()` — one P&L row read "COGS — Matt/Sofa" on the PC and "Cogs Matt Sofa" on the phone |
| `pms-reviewable-titles.ts` | `isReviewableTitle` | desktop tested a Set of seven EXACT titles, mobile a PREFIX regex claiming to mirror it — "3D Design (Revision 2)" got the approve/reject workflow on the phone and none on the PC |
| `pms-project-status.ts` | status values/labels + payment-pill labels | values agreed, but the `fully_paid` pill read "Fully paid" on desktop and "Paid" on mobile |

**The rule for all four is the same:** only the value→label contract is shared.
Each surface keeps its OWN visual map — desktop Tailwind chip/ring classes and a
calendar hex, mobile inline styles — so the two can never disagree about WHICH
values exist or what they are called, while neither dictates the other's palette.

**`isReviewableTitle` is a PREFIX rule, and that was a choice.** The prefix
matcher is a strict SUPERSET of the old exact set (proved in
`pms-vocabulary.test.ts`: every one of the seven matches its own prefix), so
adopting it removed review controls from nobody. What changed is that DESKTOP now
shows submit/approve/reject on suffixed rows — "3D Design (Revision 2)",
"Agreement — signed copy" — which mobile already did. Chosen because staff type
these titles by hand and the owner's standing philosophy for this system is to
loosen rather than restrict. **Flagged for the owner**; if he wants exactness
instead, the matcher changes in one place and both surfaces follow.

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

## Child rows are NOT reached through their parent — the gate that assumes they are (2026-08-18)

`routes/projects.ts` carried a header claiming child tables "are ALWAYS read
through their parent `project_id`", and migration 0292's prose repeated it. It is
true only where the URL carries the parent. `PATCH`/`DELETE /finance/lines/:lineId`,
`/checklist/:itemId`, `/checklist/attachments/:attId`, `/sections/:sectionId`,
`/defects/:defectId`, `/sales-reports/:reportId`, `/team/:teamId`,
`/attachments/:attId` and the three `/stock-transfers/:tid` routes have no parent
in the path and no middleware supplying one — each was a bare `WHERE id = ?`
against a service-role client.

`backend/src/routes/lib/project-company-gate.ts` is the boundary now, and it has
exactly two shapes:

- **`refuseForeignChild(c, table, id)`** — for a child addressed by its own id.
  Tables that HAVE `company_id` (`project_checklist`, its sections / attachments
  / comments per mig 0093, and `project_finance_lines` per 0170) are checked on
  that column; tables that do not (`project_stock_transfers`, `project_defects`,
  `project_sales_reports`, `project_team`, `project_attachments`) go through
  `EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id …)`.
- **`refuseForeignProject(c, id)`** — for the `/:id/<child>` CREATE routes, which
  bind `:id` as `project_id` on the INSERT.

Both answer **404**, deliberately the same answer as a missing row, and both
DEGRADE to a no-op when `activeCompanySql` yields "" (pre-migration / D1 test
mirror / cold-start). `project_event_types` and `project_organizers` are shared
masters with no `company_id` at all and are deliberately NOT gated.

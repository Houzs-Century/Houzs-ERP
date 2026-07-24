# Module: Delivery / TMS

Per-module technical doc — the delivery board (Pending Delivery / Pending
Schedule / Overdue / Delivered), the region model, and Driver / Helper / Lorry
assignment. Third of the per-module set (see `docs/modules/sales-order.md` for
the shape).

Verified against `main` @ `8f8427ed`. Line citations are that commit.

> Conventions: everything here lives in the **`scm`** schema and is served under
> `/api/scm/*` via the PostgREST client (`c.get('supabase')`) — with two
> deliberate exceptions that read `public.*` through the D1 shim
> (`c.env.DB.prepare`): service cases and PMS projects. Money is integer sen
> (`*_centi`). Dates display DD/MM/YYYY; "today" is MYT (`todayMY()`).

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop board | `frontend/src/pages/scm-v2/DeliveryPlanning.tsx` | 1,377 lines. Component at `:517`. The 4 state tabs + region chips + inline Driver / Lorry cells. |
| Desktop trips | `frontend/src/pages/scm-v2/Trips.tsx:43` | A trip = one lorry-day with an ordered stop list. Status tabs order `IN_PROGRESS` before `PLANNED` (default tab still `PLANNED`). Carries a read-only **"To schedule"** panel — see below. |
| Desktop fleet masters | `frontend/src/pages/scm-v2/Fleet.tsx:78` | `DriversSection` `:98`, `HelpersSection` `:294`, `LorriesSection` `:461`; `LorryDetail.tsx:71` mounts as a drawer from `Fleet.tsx:613`. |
| Desktop regions | `frontend/src/pages/scm-v2/DeliveryPlanningRegions.tsx:40` | Region master + per-state mapping editor. |
| Desktop capacity | `frontend/src/pages/scm-v2/LorryCapacity.tsx:140` | |
| Mobile run-sheet | `frontend/src/mobile/MobileDeliveryPlanning.tsx:277` | 2,408 lines. Driver job-card run sheet. |
| Mobile POD | `frontend/src/mobile/MobilePOD.tsx:71` | Photo / signature capture. |
| Mobile masters | `frontend/src/mobile/MobileModuleList.tsx` | Generic list configs: `drivers` `:1327`, `helpers` `:1357`, `fleet` (lorries) `:1857`, `delivery-planning-regions` `:1957`. |
| Board drawers | `frontend/src/vendor/scm/components/DeliveryFieldsDrawer.tsx:46`, `NewDpOrderDrawer.tsx:45`, `ScheduleDpOrderDrawer.tsx:40`, `ScheduleTripDrawer.tsx` | HC field editing, manual DP-order create, DP scheduling, and the Phase-2 **multiselect scheduling drawer** (resizable). |
| Resizable drawer chrome | `frontend/src/components/ResizableDrawer.tsx` | Generic right slide-over with a drag-to-resize left edge; width persisted to localStorage (`panel-*` DEVICE_PREF). The FIXED-width `DetailDrawer` (`max-w-[520px]`) is its non-resizable sibling. |

`frontend/src/pages/scm-v2/Drivers.tsx:22` is on disk with **no importer** —
the `/scm/drivers` route was retired on 2026-07-17 in favour of the Drivers
section of `/scm/fleet` (`App.tsx:593-599`, `Sidebar.tsx:518-523`). Do not
re-add it.

### Trips "To schedule" panel — read-only pending-orders queue

The Trips page carries a full-width **"To schedule"** panel below the trip
list / stop sheet grid. It surfaces the `PENDING_SCHEDULE` orders (ready to
ship, not yet on a trip) so a dispatcher sees the incoming work inside Trips,
not only on the Delivery Planning board. It **reuses the board's own data
path** — `useDeliveryPlanning({ region: 'ALL', state: 'PENDING_SCHEDULE' })`
(`vendor/scm/lib/delivery-planning-queries.ts:150`) → `GET
/delivery-planning?state=PENDING_SCHEDULE` — so it shares `derivePlanningState`
and cannot drift from the board. No new endpoint, no new state derivation.

Columns are read-only: SO / Ref (`so_doc_no`), Customer (`debtor_name`),
Region (`region` bucket), Stock (`stock_remark`), Qty (`remaining_qty`,
rounded), Delivery Date (`effective_delivery_date ?? customer_delivery_date`).
Order array is null-guarded (`?? []`) before `.length` / `.map`.

**Deliberately deferred** (next slice): multiselect, the Date/Time scheduling
actions, and any write-back from Trips onto the board. Scheduling an order
still happens only on the board (`PATCH /delivery-planning/:type/:id/schedule`
→ `scheduleOntoTrip`); this panel is display-only.

### Scheduling drawer — multiselect → schedule → Apply, on the board (Phase 2)

The board's multiselect bar (the "N selected" bar) carries a **Schedule (N)**
action next to "Convert to DO". It opens `ScheduleTripDrawer` — a right-side
drawer built on the reusable `ResizableDrawer` (drag the left edge; width
persisted to localStorage under `panel-dp-schedule-drawer.v1`, clamped
420–1040px). The owner schedules the selected orders onto a lorry-day trip
**without leaving the board**.

Inside the drawer:

- **Ordered stop list** — each selected SO as a numbered stop: customer, region
  chip, address, and a per-stop delivery-date input. Selection resolves to the
  order objects from the region-scoped board (`allOrders`, all states), so a
  selection made under one state tab still resolves after a tab switch.
- **Trip assignment** — one Trip date + Driver + Lorry, applied to every stop.
  Setting the Trip date fills every per-stop date (the "one lorry-day trip"
  case); a lorry is what puts the orders on a trip.
- **Propose dates** — a first-cut, DISPLAY-ONLY suggestion: fills each stop with
  its own effective delivery date (`effective_delivery_date ?? amended_delivery_date
  ?? customer_delivery_date`), blank where absent for the dispatcher. Nothing is
  written until Apply. Heuristic is intentionally simple; refine per owner.
- **Propose times + route** — rendered DISABLED with a "Phase 3" affordance. The
  map, geocoding, travel-time and residence-type rules are Phase 3, not built.
- **Open in Trips** — a header control navigating to `/scm/trips` (the full-page
  wide view), mirroring the SO detail drawer's "Open full page".
- **Apply** — fans out one `useScheduleDelivery` call per selected SO (capped
  concurrency 4), REUSING `PATCH /delivery-planning/so/:id/schedule` →
  `scheduleOntoTrip` (find-or-create the trip + a DELIVERY stop). It writes
  `amended_delivery_date` (via `scheduleDate`), never `customer_delivery_date`.
  Per-stop result is surfaced honestly — **WIRED / NOT_REQUESTED / FAILED** —
  read from the endpoint's `trip` / `tripWiring` fields (the hook's return type
  was widened to `ScheduleDeliveryResult`). REPORT, don't REPAIR: a wiring
  failure is named per stop, never hidden. No new schedule path, no double-count
  (the existing one-job-one-stop sweep still owns dedupe).

**Deferred to Phase 3** (documented, not guessed): the Google Map, geocoding,
travel-time / smart time proposals, residence-type rules, and the "Propose times
+ route" logic. This drawer is scheduling only.

### The four state tabs

`DELIVERY_STATES` (`frontend/src/vendor/scm/lib/delivery-planning-queries.ts:19-21`)
with labels at `:24-29`; re-exported as `STATE_TABS` in the page
(`DeliveryPlanning.tsx:192`) and rendered with an "All" tab prepended at
`:1148-1151`.

| Tab | `delivery_state` | Means |
|---|---|---|
| Pending Delivery | `PENDING_DELIVERY` | Goods not ready, and more than 3 days from the effective delivery date |
| Pending Schedule | `PENDING_SCHEDULE` | Ready to ship, not yet fully delivered |
| Overdue | `OVERDUE` | Not ready AND within 3 days of (or past) the effective delivery date |
| Delivered | `DELIVERED` | Status `DELIVERED`, or every deliverable line remaining is 0 once any qty shipped |

**Mobile does NOT use these tabs.** `MobileDeliveryPlanning.tsx:143-148` uses
Today / Tomorrow / History day buckets, split client-side off the effective
delivery date (`:297-330`); the four states survive only as the `Bucket` type
(`:64`) that colours the pill. Anything further out than tomorrow and not
delivered is deliberately off the driver run-sheet — the desktop board owns
long-range planning (`:33-42`).

### Data hooks

All in `frontend/src/vendor/scm/lib/`:

| Hook | File:line | Query key | staleTime |
|---|---|---|---|
| `useDeliveryPlanning` | `delivery-planning-queries.ts:151` | `['delivery-planning', region, state]` | 30 s, `placeholderData: prev` (`:165-166`) |
| `useDeliveryPlanningLines` | `:195` | `['delivery-planning','lines',docNo]` | 30 s, lazy (`enabled: !!docNo`) |
| `useScheduleDelivery` | `:397` | optimistic write over `['delivery-planning']` (`:416-417`), `onSettled` invalidate (`:462`) | — |
| `useUpdateDeliveryFields` | `:247` | invalidates `['delivery-planning']` | — |
| `useCreateDpOrder` / `useCancelDpOrder` / `useScheduleDpOrder` | `:314` / `:324` / `:351` | last also invalidates `['scm-trips']`, `['scm-trip']` | — |
| `useConvertSosToDo` | `:494` | invalidates SO + DO + board keys (`:542-546`) | — |
| `useDrivers` / `useHelpers` / `useLorries` | `drivers-queries.ts:46` / `helpers-queries.ts:34` / `lorries-queries.ts:99` | `['drivers'\|'helpers'\|'lorries', …]` | 60 s |
| `useTrips` / `useTrip` | `trips-queries.ts:49` / `:65` | `['scm-trips', from,to,status]` / `['scm-trip', id]` | 30 s / 15 s |
| `useLorryCapacity` | `lorry-capacity-queries.ts:60` | `['lorry-capacity', from,to,fleet]` | 30 s |
| `useDeliveryPlanningRegions` / `useStateDeliveryRegions` | `delivery-planning-regions-queries.ts:53` / `:106` | `REGIONS_KEY` / `STATES_KEY` | 60 s / 30 s |

Mobile does **not** reuse `useDeliveryPlanning`. It runs its own query against
the same endpoint — `["mobile-delivery-planning","ALL"]`, `staleTime 30_000`,
always `?region=ALL&state=ALL` (`MobileDeliveryPlanning.tsx:290-294`), and
invalidates it plus the shared SO/DO/inventory keys after a status write
(`:1248-1249`).

Loading behaviour: the desktop board keeps the previous rows on screen while a
region/state tab switch loads (`placeholderData: prev`), and the Driver / Lorry
selects write optimistically (`useScheduleDelivery` `:416-417`) so a picked name
appears before the round-trip settles. Filters live in the URL
(`DeliveryPlanning.tsx:527-529`, `useSearchParams`) per the repo's "URL is
state" rule.

---

## 2. API surface

All under `/api/scm`. Mounted in `backend/src/scm/index.ts`; **every one of
these routers is gated by `scmAreaGuard('scm.transportation.drivers')`** — see
§6.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| GET | `/delivery-planning` | `scm/routes/delivery-planning.ts:409` | **The board.** `?region=ALL\|<code>&state=ALL\|<delivery_state>` → `{ orders, counts, regions }` |
| GET | `/delivery-planning/:docNo/lines` | `:1389` | Expand-row line items, scoped to the caller's ALLOWED companies (not the active one) |
| PATCH | `/delivery-planning/:type/:id/fields` | `:1493` | HC delivery fields (time range, shipout date, sub-status…) |
| PATCH | `/delivery-planning/:type/:id/schedule` | `:1705` | Schedule date + **driver / lorry assignment**; `type` = `so \| do \| assr` |
| GET/POST/PATCH/DELETE | `/delivery-planning-regions`, `/…/states/:stateKey` | `delivery-planning-regions.ts:65,89,120,150,196,228,261` | Region master + the state→region map |
| GET/POST/PATCH | `/drivers` | `drivers.ts:26,40,71` | Driver master |
| GET/POST/PATCH | `/helpers` | `helpers.ts:23,35,64` | Helper master |
| GET/POST/PATCH | `/lorries` | `lorries.ts:85,100,143` | Lorry master |
| GET | `/lorry-service-records` | `lorry-service-records.ts` | Service history (mig 0121) |
| GET/POST/PATCH/DELETE | `/trips`, `/trips/:id`, `/trips/:id/stops`, `/trips/:id/status` | `trips.ts:101,141,175,234,277,325,398,412` | Trip (lorry-day) CRUD + stop ordering |
| POST | `/trips/:id/optimize-route` | `trips.ts:438` | Google route optimisation; returns `{configured:false}` when `GOOGLE_MAPS_API_KEY` is unset |
| GET/PATCH/PUT | `/lorry-capacity`, `/lorry-capacity/lorries/:id/*` | `lorry-capacity.ts:132,354,389` | Capacity dashboard, in-house flag, repair days |
| POST/GET/PATCH | `/dp-orders`, `/dp-orders/:id/cancel`, `/:id/schedule` | `dp-orders.ts:190,234,281,313,348` | Manual DP jobs with no source document |
| PUT | `/delivery-orders-mfg/:id/crew` | `delivery-orders-mfg.ts:3314` | The only writer of `scm.delivery_order_crew` (driver 1/2 + helper 1/2 + lorry). **No frontend caller exists** — grep `frontend/src` for `/crew` returns nothing. |

Machine-generated gate list: `docs/generated/route-capability-matrix.csv`
(rows for `/delivery-planning`, `/trips`, `/drivers`, `/helpers`, `/lorries`).

---

## 3. Backend

### How a job reaches the board — `delivery-planning.ts:409-1372`

The board is a **union of four sources**, assembled per request. Nothing is
materialised; there is no board table.

1. **Sales Orders** (`row_type: 'so'`, `:852`) — live `scm.mfg_sales_orders`
   with `status NOT IN (DRAFT, CANCELLED)` that carry a delivery-date signal
   (`customer_delivery_date` or `internal_expected_dd`), paginated so the
   1000-row PostgREST cap cannot silently truncate (`:442-479`). Their DOs,
   crew, readiness and warehouse labels are joined on.
2. **Service Cases** (`row_type: 'assr'`, `:1034`) — read from **`public.assr_cases`
   via `c.env.DB`** (`:981-1004`), not the scm client. A case appears only when
   it is open (`closed_at IS NULL AND archived_at IS NULL`) and carries a
   trigger date. **One row per SET date**, so a case can appear as up to three
   independent legs (`:1019-1027`): `customer_pickup_at` → `job_kind
   'customer_pickup'`, `inspection_visit_at` **when `inspection_by = 'own'`** →
   `'inspection'`, `do_date` → `'delivery'`. Row key is `<ASSR-NO>#<job_kind>`
   (`:1031`). ASSR rows always land as `PENDING_DELIVERY` (`:1046-1048`).
3. **DP Orders** (`row_type: 'dp'`, `:1150`) — manual jobs from `scm.dp_orders`
   with **no** source document (`so_doc_no`, `assr_case_id`, `do_id` all null)
   and status not DELIVERED/CANCELLED (`:1132-1136`). DP orders that DO have a
   source are deliberately excluded so the line is not doubled (`:1120-1124`).
4. **PMS Projects** (`row_type: 'project'`, `:1269`) — non-archived projects
   with a `setup_start_at` or `dismantle_start_at`, read from `public` via
   `c.env.DB` (`:1240-1244`). One row per window; crew is a **read-only mirror**
   of what Projects assigned (`:1330-1336`) — edit it in Projects, not here.

Each of the last three unions is wrapped defensively: a failure logs and leaves
the SO rows untouched (`:1341-1343`).

Then: row scope (§6) → region filter → counts → state filter →
`{ orders, counts, regions }` (`:1345-1371`). Counts are computed over the
**region-filtered** set BEFORE the state filter, so switching state tabs does
not move the badge numbers (`:1358-1364`).

### The 4-state derivation — `derivePlanningState`, `:283-308`

Pure, exported, and **shared with the `/mfg-sales-orders` list endpoint** so the
board and the mobile Orders card cannot drift (`:266-269`). A manual override
stored on the SO header (`delivery_state`) wins when it is one of the four enum
values (`:290`); otherwise:

```
DELIVERED        status DELIVERED, or delivered > 0 && remaining <= 0
PENDING_SCHEDULE readyToShip (isMainReady when a MAIN line exists, else isFullyReady)
OVERDUE          !readyToShip && daysLeft <= 3            (daysLeft vs the EFFECTIVE date)
PENDING_DELIVERY otherwise
```

Effective delivery date = `amended_delivery_date ?? customer_delivery_date`
(`:277-278`). The original customer date is never overwritten.
`backend/src/services/agents/delivery-agent.ts:53` imports this same function,
so the agent and the board cannot disagree.

### Region is derived from the customer STATE — verified

Confirmed at this commit. `stateToRegionsFromConfig()`
(`delivery-planning.ts:190-206`) takes `customer_state`, falls back to
`customer_country`, normalises it (`normState` `:107-114`: uppercase, strip
accents, punctuation → space, collapse whitespace, so "Pulau Pinang" /
"P.Pinang" / "pulau-pinang" all match), and looks it up in the config map. Call
site for SO rows (`:839-841`):

```ts
const stateRegions = stateToRegionsFromConfig(regionCfg, r.customer_state, r.customer_country);
const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
const regionSet    = new Set<Region>(stateRegions);
```

emitted as `region` + `regions[]` at `:951-952`. The other three row types use
the **same** function: ASSR off the case `location` (`:1013`), DP off
`dp_orders.state` (`:1141`), projects off the project `state` (`:1254`).

**Postcode is never used for region.** `postcode` is selected (`:474`) and
emitted (`:917`) purely as an address display column. The frontend restates the
rule in its type comment (`delivery-planning-queries.ts:31-36`, `:122`) and the
page header comment (`DeliveryPlanning.tsx:186-188`).

A region is a **config-driven open string**, not a fixed union: the buckets come
from `scm.delivery_planning_regions` and the mapping from
`scm.state_delivery_regions`, loaded once per request by `loadRegionConfig()`
(`:130-184`). A state may map to several regions; an unmapped state falls back
to `KL` if configured, else the first active region (`:201-205`). When the
config tables are empty the hardcoded `FALLBACK_REGIONS` keeps today's five
tabs (`:98-103`): KL/SEL, Northern, Southern, East Coast, EM.

> Not the same thing: `routeRegion()` in `backend/src/services/autocount.ts:280-287`
> returns `WEST | EAST | SG | null` from the SO's address line 3 and
> `SalesLocation`. It belongs to the AutoCount ASSR sync
> (`services/pull.ts:61`, `routes/assr.ts:1267`) and has nothing to do with the
> delivery board's buckets.

### Driver / Helper / Lorry routing model

Three masters, one shared fleet across companies. `drivers.ts:31-34` and
`helpers.ts:23-31` are explicit: the roster is deliberately **not** company-scoped;
`company_id` on a fleet row is a created-by stamp, not an isolation boundary.

**Assignment happens in two places, and they are not the same mechanism:**

| Path | What it writes | Who calls it |
|---|---|---|
| `PATCH /delivery-planning/:type/:id/schedule` (`:1705`) | schedule date, optional `deliveryState` override, and `{lorryId, driverId, tripId?, tripDate?, warehouseId?}` → **finds or creates a `scm.trips` row** for (lorry, date) and adds a `trip_stops` DELIVERY row (`:1909-1946`). `is_outsourced` derives from the lorry's `is_internal` (`:1705-1712`); trip numbers are minted max+1 via `mintMonthlyDocNo` (`:1716-1722`). | The board's `DriverEditCell` (`DeliveryPlanning.tsx:305`) and `LorryEditCell` (`:340`), and the bulk apply (`:660-665`). |
| `PUT /delivery-orders-mfg/:id/crew` (`delivery-orders-mfg.ts:3314`) | the full `scm.delivery_order_crew` row — driver 1/2, **helper 1/2**, lorry, plus name/IC/contact/plate snapshots — and syncs `driver_id` / `driver_name` / `vehicle` onto the DO header (`:3412-3414`). | **Nobody, at this commit.** No frontend file references `/crew`. |

Consequences worth knowing before you touch this:

- **There is no helper assignment UI on the delivery board or on Trips.** The
  schedule payload has no helper field (`scheduleSchema` `:1642-1662`), the
  board renders no helper cell, and the mobile detail shows Driver + Helper
  **read-only** (`MobileDeliveryPlanning.tsx:1612-1613`). Helpers can be
  assigned only via `POST /trips` / `PATCH /trips/:id` (`trips.ts:164-173`
  accept `helper1Id` / `helper2Id`) — and `frontend/src/vendor/scm/lib/trips-queries.ts`
  exports no create/update hook, so no UI reaches it either.
- Driver / Lorry cells are **name-matched, not id-linked**: the board row
  carries `crew.driver_1_name` / `crew.lorry_plate`, and the cell preselects by
  matching that string against the master list, keeping an off-list current
  value selectable so an existing assignment never silently blanks
  (`DeliveryPlanning.tsx:311-336`, `:345-366`).
- ASSR rows are **assignable** (PR #947): picking a lorry wires the leg onto a
  real trip via `scheduleAssrOntoTrip`, so a service visit consumes fleet
  capacity like an SO/DO delivery. The stop links back to its case through
  `scm.trip_stops.assr_case_id` (mig 0166), and the board re-reads the trip's
  crew on every load (the "ASSR crew echo") so the assignment survives a
  refresh. **DP** rows still show "not applicable" for Driver / Lorry
  (`DeliveryPlanning.tsx:307`, `:342`); project rows are read-only mirrors
  (`:309`, `:344`).
- **One job = one stop — on BOTH paths.** A job re-scheduled to another lorry or
  day resolves to a different trip, so the wiring deletes that job's stops on
  every other trip. Without it `/lorry-capacity` counts the job against both
  lorries (two stops, and its revenue added twice), and it stays on the route of
  the driver it was moved off. The two paths key the delete on **different
  columns, deliberately** — they are not mirrors:
  - ASSR legs (`scheduleAssrOntoTrip`, #947): `assr_case_id` + `stop_type`, with
    `trip_id` ≠ the new one. A service case has no scm uuid, so the stop links
    back through `scm.trip_stops.assr_case_id` (mig 0166).
  - SO/DO deliveries (`scheduleOntoTrip`): `do_id` (or `so_id`) + `stop_type`
    `DELIVERY`, with `trip_id` ≠ the new one. The key is chosen by the pure
    `staleStopSweepFor`, which **refuses** to sweep when neither uuid is present
    rather than widening the filter.

  Cross-contamination is impossible in either direction: an ASSR stop carries
  `do_id` / `so_id` NULL, an SO/DO stop carries `assr_case_id` NULL, a manual DP
  job (`dp-orders.ts`) carries all three NULL, and a NULL never matches a
  concrete uuid. A failed delete is returned as `tripWiring.failed` with a reason
  saying the job may be counted twice — best-effort, but never silent.

  **Consequence, accepted:** a stop for the same document added by hand to a
  second trip (`POST /trips/:id/stops`) is also cleared by the next board
  schedule. Splitting one document across two lorries is the exact shape that
  double-counts, and the board is the single dispatcher of record.

  **Still open on the SO/DO path:** a `type: 'so'` schedule (an SO with no DO)
  writes **no stop at all** — `scm.mfg_sales_orders` has a TEXT PK (`doc_no`) and
  no `id`, so there is no uuid for `trip_stops.so_id` and the insert's
  `(doId || soId)` guard skips it. It does still find-or-create a **trip**, so
  re-pointing such an SO leaves the previous lorry's trip behind carrying no stop
  for it — and with no stop, nothing links that trip to the SO, so nothing can
  clean it up. `/lorry-capacity` counts every trip in `total_trips` and in
  utilisation regardless of its stops. Recorded in `BUG-HISTORY.md`
  (2026-07-22); the stop sweep does not fix it, because there is no stop to
  sweep.
- A crew-only edit (a lorry with no `scheduleDate`) skips the case's date write,
  so the ASSR branch checks the case **exists and is open** up front; a closed,
  archived or unknown case is a 404 and never mints a trip or a DP number.

### The sync is bidirectional — Trips → Board reconciliation

The forward direction (above) is Board → Trips: scheduling writes a `scm.trips`
row + a `trip_stops` DELIVERY row keyed on `do_id`. The **reverse** direction —
Trips → Board — runs when a trip/stop changes on the Trips side, and closes the
stale-board gap: a cancelled trip or a removed stop used to leave the source
order still LOOKING scheduled on the board, because the persisted
`delivery_state` override that hid it from **Pending Schedule** was never
cleared.

`backend/src/scm/lib/tripReconcile.ts` (`reconcileStopsToBoard`) is wired into
the three trip write endpoints in `trips.ts`:

| Endpoint | When it reconciles |
|---|---|
| `DELETE /trips/:id/stops/:stopId` | the removed stop's source order — the stop's `do_id` is snapshotted **before** the delete |
| `DELETE /trips/:id` (soft cancel → `CANCELLED`, and `?hard=true`) | every `DELIVERY` stop on the trip. Hard-delete CASCADEs the stops away (`trip_stops.trip_id ON DELETE CASCADE`), so they are read first |
| `PATCH /trips/:id/status` → `CANCELLED` | same — every `DELIVERY` stop. Other statuses leave the schedule intact |

What it does, and its guardrails:

- It **clears** the `delivery_state` override cache (sets it NULL) on the source
  header(s) — `scm.delivery_orders` (via `do_id`) and the parent
  `scm.mfg_sales_orders` (via the DO's `so_doc_no`). It **never** touches
  `derivePlanningState`: clearing the override the derivation already respects
  returns a ready-to-ship order to its derived `PENDING_SCHEDULE`, and a
  genuinely delivered order still derives `DELIVERED`. It writes **no**
  `customer_delivery_date` and adds **no** column to any shared SO-LIST select
  (the VIEW-TRAP).
- The SO override is cleared through the **canonical generation writer**
  (`advanceSoGeneration`), not a raw update, so a human holding the SO's edit
  lease is not clobbered — the reconcile stands down and **reports** a lease /
  version conflict rather than overwriting. Only headers that actually carry an
  override are written, so a routine stop removal churns no version and spams no
  audit.
- **Keyed on `do_id`**, the same column `scheduleOntoTrip` writes and
  `staleStopSweepFor` sweeps — forward and reverse stay symmetric. The pure
  `stopReconcileKeyFor` **refuses** a stop with no `do_id` (a `so_id`-only stop —
  which never occurs, an SO has no uuid; an ASSR leg keyed on `assr_case_id`; a
  manual DP job with all three NULL), so the reconcile only ever acts on an SO/DO
  delivery it owns.
- **REPORT, don't REPAIR.** The trip/stop change has already committed, so a
  partial reconcile failure is surfaced as `reconcile: { failed, reason }` on the
  response (present ONLY on failure, `reconcileFieldsFor`, the same convention as
  the forward `tripWiring`) — a stale override that could not be cleared is
  named, never hidden behind `ok: true`.

**Deliberately deferred** (documented, not guessed):

- **ASSR-leg reverse sync.** Cancelling a trip does not clear a scheduled
  service case's driving date on `public.assr_cases`. That is a different key
  (`assr_case_id`) writing to a `public` table via `c.env.DB`, and ASSR rows
  always land as `PENDING_DELIVERY` on the board regardless — a separate, safer
  slice.
- **`amended_delivery_date` is left in place** on unschedule. It cannot be
  distinguished from a customer-requested amendment
  (`amend_date_from_customer`) without more logic, and clearing it blindly would
  risk a legitimate customer date. It does not affect the `PENDING_SCHEDULE`
  derivation, so leaving it is harmless.
- **No Trips-side UI triggers these endpoints yet** — the Trips page has no
  cancel / remove-stop action, so the reconcile is reached only via the API
  today. When such a UI is added it should invalidate `['delivery-planning']`;
  the backend reconcile is already in place.
- **`dp_no` on a cancelled (not deleted) trip's stop** still shows on the board
  (the board reads all `trip_stops.dp_no` regardless of trip status). It is a
  label, not the schedule-queue state, so it is out of this slice.

**How a person becomes a driver or helper — two disconnected mechanisms.**
(1) Manual master CRUD (`POST /drivers`, `POST /helpers`), which creates a
fleet row with no link to `public.users`. (2) A `user_id` link on
`scm.drivers` / `scm.helpers` that `resolveDeliveryScope` reads
(`backend/src/scm/lib/deliveryScope.ts:131-132`) to decide row scope.

> **Unverified / gap.** The `user_id` link columns and the "internal staff →
> fleet row" sync that `deliveryScope.ts:24-28` describes are **not created by
> any migration in this repo** — `grep drivers backend/src/db/migrations-pg/`
> returns only `0015`, `0022`, `0053`, `0083`; `0066_scm_staff_user_sync.sql:9,22`
> refers to a "migration 0060" that is an unrelated file locally. The sync
> therefore lives outside this repo (the 2990 full-schema import; see the note
> at `drivers.ts:9`). On any database built from this repo's migrations alone,
> `resolveDeliveryScope` fails open to `mode: 'all'` (`deliveryScope.ts:146`).
> I could not verify the production state of those columns from the repo.

Separately, `backend/src/routes/fleet.ts:25-29` (`GET /api/fleet/staff`, gate
`requirePermissionOrSalesView("users.read")`) uses a **different** driver/helper
concept entirely — `public.roles.name IN ('Driver','Helper','Storekeeper')` over
`public.users`. It feeds the Projects / Logistics crew pickers, not the SCM
fleet. The mismatch is noted in `backend/src/routes/inbox.ts:236-246`.

---

## 4. Database

Schema `scm` unless stated. The board itself has no table — it is derived per
request (§3).

| Table | Role |
|---|---|
| `scm.mfg_sales_orders` | Board's primary source. `delivery_state` (the manual override cache, `0053:172`, indexed `:174`), `customer_state`, `customer_country`, `customer_delivery_date`, `amended_delivery_date` + `amend_date_from_customer` + `amend_reason` (`0053:192-194`), `internal_expected_dd`, `postcode`, `building_type`, HC context columns (`0053:178-181`) |
| `scm.delivery_orders` | `delivery_state` (`0053:173`); execution columns `time_range`, `time_confirmed`, `arrival_at`, `departure_at`, `shipout_date`, `customer_delivered_date`, `eta_arriving_port`, `delivery_substatus` (`0053:182-189`), `arrives_em_warehouse_date` (`0053:195`) |
| `scm.delivery_order_crew` | `0053:144-169`. `do_id` UNIQUE; `driver_1_id`/`driver_2_id` → `scm.drivers`, `helper_1_id`/`helper_2_id` → `scm.helpers`, `lorry_id` → `scm.lorries`, plus name/IC/contact/plate SNAPSHOTS and `assigned_at`/`assigned_by` |
| `scm.trips` | `0053:68-92`. `trip_no`, `trip_date`, `lorry_id`, `driver_id`, `helper_1_id`, `helper_2_id`, `warehouse_id`, `trip_type`, `status`, `is_outsourced`, `clock_in_at`/`clock_out_at` |
| `scm.trip_stops` | `0053:94`. Ordered stops; route metrics `leg_distance_m`, `leg_duration_s`, `eta_offset_s`, `route_optimised_at` (`0134:19-22`), `dp_no` (`0137:37`), stop type `SUPPLIER_PICKUP` (`0128`) |
| `scm.drivers` | `driver_code`, `name`, `phone`, `ic_number`, `vehicle`, `in_house` (`0053:36`), `active`; `company_id` (`0083:306-307`). Table itself predates this repo's migrations |
| `scm.helpers` | `0053:38-48`. `helper_code` UNIQUE, `name`, **`contact`** (not `phone`), `ic_number`, `in_house`, `active` |
| `scm.lorries` | `0053:50-65`. `plate` UNIQUE, `type` (`scm.lorry_type`), `is_internal`, `warehouse_id`, `capacity_m3`, `capacity_kg`, `active`; extended by `0121:62-86` with `model`, `purchase_*`, `road_tax_expiry`, `insurance_expiry`, `puspakom_expiry` |
| `scm.lorry_maintenance`, `scm.lorry_service_records` | `0053:110-120`, `0121:99` |
| `scm.dp_orders` | `0129:30-63`. `dp_no`, `job_type` (`scm.trip_stop_type`), `party_type`, address + `postcode` + `state`, `requested_date`, `trip_id`, `status` |
| `scm.delivery_planning_regions` / `scm.state_delivery_regions` | `0053:198` / `0053:208`. The region master and the state→region map keyed on a state **name** (`state_key`) |
| `scm.delivery_legs` | `0053:123`. The removed multi-hop feature; table still present, unused |

Enums (`0053:27-33`): `delivery_state`, `lorry_type`, `delivery_leg_kind`,
`delivery_leg_source`, `trip_type`, `trip_status`, `trip_stop_type`.

Seeded state→region mapping: `0053_scm_delivery_planning_tms.sql:230-263` (the
original 6 buckets), reconciled to 5 by
`0159_scm_reconcile_delivery_regions.sql:38-82` (KL / NORTHERN / SOUTHERN /
EAST_COAST / EM; Singapore folds into Southern). A fresh environment seeded from
`0053` alone differs from production until `0159` runs — the code comment at
`delivery-planning.ts:92-97` says so too.

> `backend/src/db/schema.pg.ts` models **none** of these. It carries only the
> legacy `public` Drizzle tables (`lorries` `:306`, `trips` `:321`, `trip_stops`
> `:334`, `order_details` `:389`), and `public.lorries` was dropped by
> `0055_drop_old_fleet_lorries.sql`. The scm TMS tables are reached through
> PostgREST only, never Drizzle — so do not expect type help here.

---

## 5. Performance summary

Optimized:
- Region config, warehouse labels and the SO header page are each read once per
  request and reused across all four row sources.
- `paginateAll` on the SO header read (`:466-479`) and on the region config
  (`:139-146`, `:164-170`) so PostgREST's 1000-row cap cannot silently truncate.
- Every non-SO union is wrapped in try/catch, so one bad row degrades that
  source instead of 500-ing the board.
- Board list query keeps previous rows across tab switches; masters cache 60 s;
  Driver / Lorry writes are optimistic.

Watch as data grows — this endpoint is the module's whole cost model:
- **The board has no server-side pagination and no date bound.** Every live SO
  with a delivery signal is read on every load, then the ASSR, DP and project
  unions are added, then region/state filtering happens **in memory**
  (`:1358-1367`). Row count grows monotonically with the SO table.
- `dp_orders` is the one source with a hard cap (`.limit(1000)`, `:1136`) —
  silent truncation past that.
- The ASSR union is an unbounded `SELECT` over open, dated `public.assr_cases`
  (`:981-1004`) with no LIMIT.
- Mobile fetches `?region=ALL&state=ALL` — the entire board — and buckets three
  days out of it client-side (`MobileDeliveryPlanning.tsx:290-294`). Phones pay
  the full board cost to render one day.

The scaling model for the neighbouring SCM lists (fixed base + per-row cost, and
where it breaks) is in `docs/scm-scaling-audit.md`; the cross-module audit is
`docs/perf-optimization-plan.md`.

---

## 6. Who can see and do what

**The backend is the authority.** Page admission on the frontend reads the
server-supplied `page_access` map; it does not compute the rule. The one place
that re-derives a backend rule locally is called out below.

### One area key gates the whole module

Every TMS router is mounted behind `scmAreaGuard('scm.transportation.drivers')`
(`backend/src/scm/index.ts:431-467` (`/drivers` :431, `/delivery-planning` :436, `/delivery-planning-regions` :449, `/trips` :451, `/dp-orders` :453, `/lorry-capacity` :458, `/helpers` :460, `/lorries` :462, `/lorry-service-records` :466)) — `/drivers`, `/delivery-planning`,
`/delivery-planning-regions` (plus `{ openRead: true }`), `/trips`,
`/dp-orders`, `/lorry-capacity`, `/helpers`, `/lorries`,
`/lorry-service-records`. There is no per-endpoint `requirePermission` in this
module.

`scmAreaGuard` (`backend/src/scm/middleware/area-guard.ts:112-210`) resolves in
this order:

1. `*` (Owner / IT) → through, never gated (`:122-126`).
2. Sales JD **deny**, then Sales JD **write-cap**, then the money-write deny —
   rules in code, enforced always, ahead of the rollout fallthrough
   (`:135-166`).
3. `user.scm_l2_configured === false` → **through** (`:168-172`). The no-lockout
   rollout: a caller with no explicit SCM L2 rows falls back to the coarse
   `scm.access` umbrella enforced upstream.
4. Otherwise per-method: GET/HEAD need `view`, POST/PATCH/PUT/DELETE need `edit`
   on the area (`:190-193`).

So in practice: **read the board = `view` on `scm.transportation.drivers`;
schedule / assign / edit fields = `edit` on the same key** — unless the caller
is not L2-configured, in which case `scm.access` is the real gate.

### Row scope — a driver sees only their own jobs

`resolveDeliveryScope` (`backend/src/scm/lib/deliveryScope.ts:105-149`) narrows
a caller only when **both** signals agree:

1. **Intent** — `resolvePositionPolicy` classifies them into the `restricted`
   cohort (Driver / Helper / Storekeeper / Storekeeper Supervisor,
   `backend/src/services/positionPolicy.ts:300-307`). Keyed on the policy
   cohort, not a position-name regex, so a rename cannot inject or drop a
   restriction.
2. **Identity** — at least one `scm.drivers` / `scm.helpers` row resolves via
   `user_id` (`:129-136`).

Every other outcome **fails open to `mode: 'all'`** — wildcard, non-restricted
position, unresolvable identity, lookup error (`:110-146`). The rationale is in
the file header: this change can only ever reduce exposure, never lock a driver
out of their own jobs. An unassigned job never matches a `self` scope
(`scopeMatchesAssignment` `:157-165`), so it stays visible to ops only.

Where it is enforced:

| Site | File:line |
|---|---|
| Board read (rows filtered after assembly) | `delivery-planning.ts:418`, `:1347-1349`, helper `:317-369` |
| `PATCH /delivery-planning/:type/:id/fields` (write ownership → 403 `NOT_YOUR_JOB`) | `:1553-1566` |
| Trips list / detail / status | `trips.ts:128-131`, `:153-154`, `:292-293` |
| DP orders list + act | `dp-orders.ts:102`, `:118-125`, `:247` |

> **Deliberately unscoped — owner ruling 2026-07-22. Do not "fix" this.**
> `PATCH /delivery-planning/:type/:id/schedule` — the route that assigns driver
> and lorry and creates trips — does **not** call `resolveDeliveryScope`, and
> must not. Scheduling is a ONE-PERSON function: a single dispatcher assigns the
> whole operation's jobs. Narrowing the handler to the caller's own assignments
> would lock that dispatcher out of every job they do not already own — the
> exact opposite of what the business needs. Its gate is the area guard's `edit`
> level on `scm.transportation.drivers`, and that is intended to be the complete
> gate.
>
> The asymmetry with `/fields` (`:1553-1566`, which **does** scope) is the point.
> `/fields` narrows because editing a job's own data — steps, POD, execution
> timestamps — is a per-owner act. Assignment is the opposite act: it decides
> whose job it becomes, so it cannot be scoped by ownership it creates. Adding
> the scope call to make the two routes match would be a behaviour change against
> a standing ruling, not a consistency fix. The handler carries the same note at
> `delivery-planning.ts:1682-1704`, and
> `backend/tests/scheduleScopeRuling.test.ts` fails loudly if a scope call is
> added.
>
> What would justify revisiting: if scheduling ever stops being one person —
> per-region or per-depot dispatchers each owning a slice of the board — then
> `resolveDeliveryScope` is the mechanism to reach for, extended with a
> region/depot mode rather than the existing `self` (which keys on crew
> assignment and would be the wrong axis). Until the operation actually splits,
> unscoped is correct.

### Frontend gates

| Surface | Gate | File |
|---|---|---|
| `/scm/delivery-planning`, `/scm/trips`, `/scm/delivery-planning-regions`, `/scm/fleet`, `/scm/lorry-capacity` | `<ScmGuard area="scm.transportation.drivers">` | `App.tsx:601-605` |
| `ScmGuard` | delegates to `<Guard perm="scm.access" anyAccess={[area]}>` — an OR of the flat permission and the server's `page_access` map | `App.tsx:240-269`, `Guard` at `:183-222` |
| Sidebar entries | `anyPerm ["*","scm.access"]`, `anyAccess ["scm.transportation.drivers"]`, `hideForSalesRep: true` | `Sidebar.tsx:515-524` |
| Mobile screens | resolved through the same nav table (`gateVia`) | `MobileApp.tsx:114`, `:157-184`, `:718` |

No `PageGuard` wraps any delivery route — `PageGuard` is for the
service-case / sales / projects family.

> **Frontend re-derivation, by design but worth knowing.** The board's
> "Convert to DO" actions are gated by `canOperateDeliveryOrders(user, can,
> pageAccess)` (`DeliveryPlanning.tsx:526`), which is
> `canOperateScmSalesDoc` (`frontend/src/auth/salesAccess.ts:187-206`):
> `can("*") || !isSalesStaff(user) && ACCESS_RANK[pageAccess("scm.sales.delivery")]
> >= edit`. It restates two backend terms — the area guard's `edit` requirement
> and `salesJdWriteDenial` — in the frontend, deliberately, so a button it shows
> cannot 403 (its own docblock `:157-186` explains the four hand-copies it
> replaced). It is a mirror, not the authority: the backend still refuses.
> Unlike `scm.maintenance.open` there is **no backend capability** covering this
> today (`backend/src/services/capabilities.ts` has none for delivery), so if a
> third rule term ever lands, this mirror is where it will drift.

---

## 7. Desktop and mobile files that must change together

| Change | Desktop | Mobile | Shared / authority |
|---|---|---|---|
| The 4 states, their labels, their meaning | `pages/scm-v2/DeliveryPlanning.tsx` (`STATE_TABS` `:192`, tab row `:1148`) | `mobile/MobileDeliveryPlanning.tsx` (`Bucket` `:64`, pills) | `vendor/scm/lib/delivery-planning-queries.ts:19-29` for the constants; `derivePlanningState` (`backend/.../delivery-planning.ts:283-308`) for the RULE |
| Board row shape / new column | `DeliveryPlanning.tsx` columns | `MobileDeliveryPlanning.tsx` `BoardRow` `:79` and the job card | `PlanningOrder` type in `delivery-planning-queries.ts:47` — add the field there first |
| Region model | `DeliveryPlanningRegions.tsx` | `MobileModuleList.tsx:1957` (`delivery-planning-regions`) | `stateToRegionsFromConfig` + the two config tables |
| Driver / Helper / Lorry masters | `Fleet.tsx` (`DriversSection` `:98`, `HelpersSection` `:294`, `LorriesSection` `:461`) | `MobileModuleList.tsx:1327` / `:1357` / `:1857` | `drivers-queries.ts` / `helpers-queries.ts` / `lorries-queries.ts` |
| Assignment + scheduling | `DriverEditCell` `:305`, `LorryEditCell` `:340`, bulk `:660-665` | read-only rows `MobileDeliveryPlanning.tsx:1612-1613` | `useScheduleDelivery` (`delivery-planning-queries.ts:397`) → `PATCH …/schedule` |
| Status writes / POD | board row actions | `MobileDeliveryPlanning.tsx` (`PATCH /delivery-orders-mfg/:id/status`), `MobilePOD.tsx` | the DO status machine in `delivery-orders-mfg.ts` |
| Access gating | `App.tsx:601-605` + `Sidebar.tsx:515-524` | `MobileApp.tsx:114,157-184` | `scmAreaGuard('scm.transportation.drivers')` |

Note the asymmetry that is intentional and must be preserved: mobile is a
**driver run-sheet** (Today / Tomorrow / History, read-only crew), desktop is
the **planning board** (4 states, region chips, assignment). One backend, one
state machine, two presentations.

---

## Related

- `docs/delivery-tms-stage2-backend-spec.md` — the original build spec.
- `docs/delivery-planning-jobtypes-spec.md` — "Seven job types on one fleet";
  key file index at `:162`, migration numbering at `:177`.
- `docs/MULTICOMPANY-MODULE-MAP.md:28-39` — TMS is one global cross-company
  fleet with a shared board.
- `docs/generated/route-capability-matrix.csv` — the generated gate per route.
- `docs/modules/service-case.md` — where the ASSR legs on this board come from.
- `BUG-HISTORY.md` — read the delivery entries before touching this module.

# Module: Delivery / TMS

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — the delivery board (Pending Delivery / Pending
Schedule / Overdue / Delivered), the region model, and Driver / Helper / Lorry
assignment. Third of the per-module set (see `docs/modules/sales-order.md` for
the shape).

Verified against `main` @ `8f8427ed`. Line citations are that commit.



---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop board | `frontend/src/pages/scm-v2/DeliveryPlanning.tsx` | Thin host: PageHeader + data fetch (region server-side) + selection + drawers, rendering the shared **`DeliveryPlanningBoard`**. The 4 state tabs + region chips + inline Driver / Lorry cells + expand + multiselect all live in the shared component now. |
| Desktop DP-order registry | `frontend/src/pages/scm-v2/DpOrders.tsx` | Route `/scm/dp-orders`, nav "DP Orders" under Transportation (after Delivery Planning). The FLAT `dp_orders` list over `GET /dp-orders` (`useDpOrders`) — every status, including the source-linked orders the board's anti-double-count guard hides and cancelled jobs the board drops. DataTable + client search; Schedule… (pending rows, reuses `ScheduleDpOrderDrawer` via its `ScheduleDpOrderTarget` subset prop) + Cancel + New DP order (reuses `NewDpOrderDrawer`). Status pill = `StatusPill docType="dpOrder"`. The optional P3 list of `docs/delivery-planning-jobtypes-spec.md`. **Sales-context columns (owner 2026-08-19, board parity):** Salesperson / Venue / Processing Date / Total Amount, read off the SOURCE SO — `GET /dp-orders` batch-reads `mfg_sales_orders` by the rows' `so_doc_no` and stamps `so_agent / so_salesperson_id / so_venue / so_processing_date / so_total_sen` (null on manual / supplier / project / case rows → dash; a failed SO read degrades to null, never a 500). Salesperson resolves through `useStaffLookup` like the SO list. |
| Shared board grid | `frontend/src/vendor/scm/components/DeliveryPlanningBoard.tsx` | The board itself, extracted so it is reused UNCHANGED by all four pipeline pages — Delivery Planning, Delivery Date Arrangement (`AutoSchedule.tsx`), Delivery Time Arrangement (`Trips.tsx`) and Last Mile Delivery (`FleetDay.tsx`): the CONFIG-DRIVEN region chip row, the optional 4 state-tab rail, the compact bulk-edit bar (multiselect), the inline Excel-style cell editors, the SO line-item drill-down and the full HC column set. Props: `stateTabs?` (present → tab row + client state-filter; omitted → locked to the passed single-state fetch), `selectedKeys`/`onToggle`/`onToggleAll`/`onClearSelection`, `bulkExtras` (page-injected Convert / Schedule buttons), `contextMenu`, `onRowDoubleClick`. The page owns the `useDeliveryPlanning` fetch so `region` stays a server-side filter. |
| Desktop trips | `frontend/src/pages/scm-v2/Trips.tsx` | **Delivery Time Arrangement** (pipeline stage 3, 2026-08-08). The page IS the time-arrangement queue: the EXACT shared board locked to PENDING_SCHEDULE, split Pending Time Arrangement (the inbox) vs Time arranged. Multiselect carries TWO actions: **"Propose time (N)"** — the per-date, per-zone STOP-SEQUENCE proposal (owner's final division 2026-08-08: this page is 排单, sequencing only). Runs the sequence-assign engine under the confirmed-date discipline of `vendor/scm/lib/propose-time.ts` (one call per confirmed delivery date, started AT that date, pinned to that one day; the depot is derived from the selected orders' majority warehouse via `depotForDocNos` so routes — and therefore delivery windows — can be computed at all), then `vendor/scm/lib/anonymous-runs.ts` folds the engine's crewed trips into anonymous **"Trip 1 / Trip 2"** cards per date: every crew/vehicle identity field is stripped (the opaque `vehicleSlotId` survives as Apply plumbing only — a stop needs a trip and a trip keys on (lorry, date)); each stop shows its **estimated delivery window** (`estWindowOf`: engine arrival → finish [installation folded in via residence rules] + `DELIVERY_UNLOAD_BUFFER_MIN`) beside the ALLOWED residence window; a proposal with no geocodable depot gets a LOUD red box naming the warehouse to fix. Applying a trip stages the sequence + dates through the schedule PATCH with NO driver/helper written — and the manual **Schedule (N)** → `ScheduleTripDrawer` (unchanged). The crew machinery (AssignTripCard / 3PL overflow) moved on to Last Mile Delivery (2026-08-08); the shared presentation pieces live in `pages/scm-v2/delivery-propose-ui.tsx`. The trip list + stop sheet (+ route optimiser + Phase-4 live map) render UNDER the "Time arranged" tab; the old page-top trip-state chip bar is gone (CANCELLED dropped, ordering IN_PROGRESS → PLANNED → COMPLETED). |
| Desktop fleet day-map (A4) | `frontend/src/pages/scm-v2/FleetDay.tsx` | **Last Mile Delivery** — the EXECUTION + CREW stage (pipeline stage 4; owner's final division 2026-08-08: 智能 assign driver + lorry lives HERE). Route `/scm/fleet-day`. Same page skeleton as the family: split chips (All / Time arranged / Delivered for the picked day) + the shared board over the day's SO rows on a live trip (the pure fold `vendor/scm/lib/last-mile.ts` over the server-stamped `trip_date`; state=ALL so a delivered order stays visible as done). **"Propose crew"**: ONE leave-aware sequence-assign call over the day's time-arranged orders; the engine's per-run crew picks re-attach to the day's REAL numbered trips by stop overlap (`matchCrewSuggestions`), each trip carrying editable Lorry + Driver 1/2 + Helper 1/2 selects (crew-leave marked) and per-trip Apply → `PATCH /trips/:id` (trip row) + `PUT /delivery-orders-mfg/:id/crew` per live DO (the `delivery_order_crew` snapshot the board shows — the only driver-2 store, hence no migration). The 3PL overflow section (carrier + captured cost) lives here. The board's inline Driver / Lorry cells stay as the manual path. **Option B (2026-08-08):** the day map is now the RIGHT PANEL of the board/map split (see "The Option B side map" below) — the old "Lorries today" side list merged into the trip/crew cards under the map, run-sheet links kept, and the trip-focus click filters the board. The map read for the run-sheet (`GET /trips/day`) is unchanged. |
| Desktop driver run-sheet (A4) | `frontend/src/pages/scm-v2/FleetRunSheet.tsx` | Route `/scm/fleet-run-sheet?date=&warehouseId=&trip=`. The printable paper the driver takes: one clean sheet PER lorry (`@media print`, one lorry per page) — trip summary (date, driver, helper, plate, drops, revenue), the lorry's route map, and the ordered stop table (no., customer, full address, phone, house type, time window, ETA, access note). Same `GET /trips/day` data as the day-map. |
| Desktop packing lists | `frontend/src/vendor/scm/components/PackingListsSection.tsx` | **Packing lists**, mounted full-width at the foot of Last Mile Delivery (`FleetDay.tsx`) — owner 2026-08-25: the packing list hangs off transportation's last-mile module, NOT off a delivery order, because one run can legitimately carry both companies' DOs. One row per trip of the picked day: packing/trip no, date, lorry, driver, DOs, stops, units, volume, a delivery-status rollup chip and Print / QR. It is its own component rather than more of `FleetDay.tsx` so that page keeps its size; FleetDay owns the date + depot, which are already its URL state. The printed sheet is `vendor/scm/lib/packing-list-pdf.ts`. |
| Desktop fleet masters | `frontend/src/pages/scm-v2/Fleet.tsx:78` | `DriversSection` `:98`, `HelpersSection` `:294`, `LorriesSection` `:461`; `LorryDetail.tsx:71` mounts as a drawer from `Fleet.tsx:613`. |
| Desktop regions | `frontend/src/pages/scm-v2/DeliveryPlanningRegions.tsx:40` | Region master + per-state mapping editor. |
| Desktop residence rules | `frontend/src/pages/scm-v2/DeliveryResidenceRules.tsx` | Per residence / building-type CONFIG the Phase-3 scheduler will read: service duration (shown in hours, stored as minutes), optional no-delivery time windows, lift-booking / registration flags. Owner-editable master, mirrors the Regions page (DataGrid + inline edit buffers + create drawer). Route `/scm/delivery-residence-rules`; not a nav row — it opens as the Residence Rules section of Coverage & Fleet. **Wired and read by three endpoints**: `GET /trips/day` (`trips.ts:308`), `POST /trips/propose-schedule` (`:910`) and `POST /delivery-zones/sequence-assign` (`delivery-zones.ts:562`), for per-building-type service duration and the allowed delivery window; shaping in `scm/lib/fleet-day-view.ts`. |
| Desktop capacity | `frontend/src/pages/scm-v2/LorryCapacity.tsx:140` | |
| Desktop delivery zones (A1) | `frontend/src/pages/scm-v2/DeliveryZones.tsx` | Route `/scm/delivery-zones`, nav "Delivery Zones" under Transportation > Maintenance. Owner-editable postcode-prefix -> area-zone map (`scm.delivery_zone_postcodes`, mig 0205). Each row maps a first-two-digit postcode RANGE to one of the 14 zones; the classifier picks the NARROWEST matching range so a fine rule overrides a broad one. Ships with a "using the built-in default" banner + one-click "load the default map". Mirrors the Residence Rules master (DataGrid + inline edit + create drawer). |
| Desktop auto-schedule (A1) | `frontend/src/pages/scm-v2/AutoSchedule.tsx` | **Delivery Date Arrangement** (pipeline stage 2; dates-first rewrite 2026-08-08). Route `/scm/auto-schedule`. The page IS the queue board — the EXACT shared `DeliveryPlanningBoard` locked to PENDING_SCHEDULE (full column fidelity), split Pending Date Arrangement vs Date arranged over the server-stamped `arrangement_stage`. Flow: MULTISELECT rows → **"Propose dates (N)"** (the A1 packer `/delivery-zones/propose`; depot + capacity ceilings ride the server defaults silently, only a start-date input — default today — sits beside the button) → proposal grouped by DAY + postcode-zone (`vendor/scm/lib/propose-days.ts`, a pure fold that DROPS the lorry dimension — no lorry name renders on this page) → **"Apply proposed dates"** fans out `useScheduleDelivery` → `amended_delivery_date`, never `customer_delivery_date`, no lorry assignment. Per-day LOCK/unlock stays; "Needs attention" lists unzoned orders. The old config/controls row (Depot / Start date / Depart time / capacity / max-trips), the per-lorry packing cards, "Sequence & assign" and the 3PL tools all MOVED to Delivery Time Arrangement (`Trips.tsx`). |
| Desktop crew leave (A3 / WS2) | `frontend/src/pages/scm-v2/DriverLeave.tsx` | Route `/scm/driver-leave`, nav "Crew Leave" under Transportation. The date-ranged crew-absence master (`scm.driver_leave`, mig 0206 + **0208**) the A2 auto-assigner reads to skip on-leave crew. **WS2:** covers DRIVERS and HELPERS (a Who toggle picks which; the picker lists every active helper — whether storekeepers actually hold `scm.helpers` rows is UNVERIFIED as of 2026-08-13: production data, not readable from the tree). Create form (who + from/to + reason) + table (Type/Name) + remove. On the covered days the person is **MARKED, never hidden**, on the manual pickers — `ScheduleTripDrawer` stamps a `leaveNote` via `crewLeaveLabel` and still offers the driver, because a driver back early from MC has to stay assignable (`ScheduleTripDrawer.tsx:111-121`). Only the AUTO assigner refuses to crew them. Mirrors the Residence Rules / Delivery Zones masters. |
| Desktop delivery maintenance | `frontend/src/pages/scm-v2/DeliveryMaintenance.tsx` | Route `/scm/delivery-maintenance`, page title **"Coverage & Fleet"**, nav Transportation > Maintenance > Coverage & Fleet. Owner 2026-08-01: "Regions、Residentials 和 Fleet 其实是一个整体 — 这三个一个" — but owner 2026-08-02 REVERSED the rest ("我要原本的UI", "delivery zones和carriers 根本都不需要dropdown啊"), so this page holds **exactly those three sections: Regions, Residence Rules, Fleet** (`DeliveryMaintenance.tsx:39-55`). Delivery Zones, Carriers & Rates and Fleet Health are their own Maintenance nav rows pointing at their own pages. **Regions opens on arrival** (`useOpenSections(['regions'])`, `:60-62`) — landing on three closed chevrons is the "table of contents instead of the page" the owner rejected. Each section renders THE SAME component its standalone route renders, with `embedded` suppressing that page's own `PageHeader`; there is no second copy. Open sections live in `?open=` (`components/CollapsibleSection.tsx`); the only valid keys are `regions`, `residence-rules`, `fleet`. A closed section is UNMOUNTED, so its queries do not fire. `DeliveryRateCards.tsx` owns its own `onCreateCompany` (`:82,:87,:148`) and this page has no rate-card or 3PL wiring at all. |
| Desktop 3PL companies | `frontend/src/pages/scm-v2/ThreePLCompanies.tsx` | Route `/scm/threepl-companies`, **not a nav row** — it opens from the "New 3PL company" control at the top right of Carriers & Rates, because a rate card is priced per carrier (`Sidebar.tsx:556-558`). The 3PL carrier company master (`scm.threepl_companies`, migs 0210 + **0237**). Registers the carrier's PARTICULARS (name, SSM `registration_no`, contact person + phone, `office_phone`, `email`, `address`) and, in an expandable per-company block, its FLEET — lorries (plate + L/W/H), drivers (code/name/phone/IC) and helpers (code/name/contact/IC). Those rows are created through `/lorries`, `/drivers`, `/helpers` carrying `threeplCompanyId`, so they land in the SHARED fleet masters flagged OUTSOURCE. A lorry can still be attached from the lorry drawer instead. Rate card is priced per company. |
| Mobile run-sheet | `frontend/src/mobile/MobileDeliveryPlanning.tsx:277` | Driver job-card run sheet (the module's largest mobile file — current size in `docs/generated/`). Carries the Phase-4 `MobileTrackingBanner` in its header. |
| Mobile POD | `frontend/src/mobile/MobilePOD.tsx:71` | Photo / signature capture. |
| Mobile GPS capture | `frontend/src/mobile/MobileTrackingBanner.tsx` | Phase-4 driver-capture banner. Self-gating: finds the driver's active trip + runs `useTripLocationCapture`; renders + captures only when a trip is IN_PROGRESS and the page is open. |
| Desktop live map | `frontend/src/vendor/scm/components/LiveTripMap.tsx` | Phase-4 dispatcher live driver markers (same maps layer as `ScheduleRouteMap`). Shown in `Trips.tsx` under a selected IN_PROGRESS trip. |
| Mobile masters | `frontend/src/mobile/MobileModuleList.tsx` | Generic list configs: `drivers` `:1327`, `helpers` `:1357`, `fleet` (lorries) `:1857`, `delivery-planning-regions` `:1957`. |
| Board drawers | `frontend/src/vendor/scm/components/DeliveryFieldsDrawer.tsx:46`, `NewDpOrderDrawer.tsx:45`, `ScheduleDpOrderDrawer.tsx:40`, `ScheduleTripDrawer.tsx` | HC field editing, manual DP-order create, DP scheduling, and the Phase-2 **multiselect scheduling drawer** (resizable). |
| Resizable drawer chrome | `frontend/src/components/ResizableDrawer.tsx` | Generic right slide-over with a drag-to-resize left edge; width persisted to localStorage (`panel-*` DEVICE_PREF). The FIXED-width `DetailDrawer` (`max-w-[520px]`) is its non-resizable sibling. |

`frontend/src/pages/scm-v2/Drivers.tsx:22` is on disk with **no importer** —
the `/scm/drivers` route was retired on 2026-07-17 in favour of the Drivers
section of `/scm/fleet` (`App.tsx:593-599`, `Sidebar.tsx:518-523`). Do not
re-add it.

### Mobile run-sheet — the v2 job card (`MobileDeliveryPlanning.tsx`)

The owner's v2 mobile design turns each delivery stop into a full JOB CARD run
sheet: a Today / Tomorrow / History day view, a per-stop card (seq badge coloured
by state, customer, kind / house-type chips, a time window, house type, item
list, balance to collect) and a per-stop DETAIL (tracking timeline Start →
Arrive → Done, Call + Navigate, Emergency contact, balance block, item list, and
for Setup jobs a photo group + 3D floor-plan attach), plus a late banner.

It is wired to the **same** `GET /delivery-planning` the desktop board uses. The
route returns `{ orders, counts, regions }`; the mobile screen drops the region /
state chips and splits `orders` into three day-buckets by their effective
delivery date:

- **Today** — effective delivery date == today
- **Tomorrow** — effective delivery date == tomorrow
- **History** — delivered, OR effective delivery date in the past

Anything further out (and not delivered) is left off the driver run-sheet; the
desktop board owns long-range planning.

v2 has three stop KINDS (delivery / service / project); the
`/delivery-planning` feed is Sales-Order deliveries only, so every stop renders
as the v2 DELIVERY job card. **The service / project variants are intentionally
not built — there is no backend source for them.**

Per-stop actions map to the REAL DO status machine on the latest
(non-DRAFT / CANCELLED) delivery order for the SO:

| Action | Call | Note |
|---|---|---|
| Start / Mark arrived | `PATCH /delivery-orders-mfg/:id/status { status: 'IN_TRANSIT' }` | DOs are created at DISPATCHED, so goods are already OUT; `IN_TRANSIT` is inventory-idempotent and just flips the pill to "On the way". |
| POD complete | `PATCH /delivery-orders-mfg/:id/status { status: 'DELIVERED' }` | Stamps `delivered_at`, behind an in-app `useConfirm`. The FULL photo / signature POD capture lives behind `onOpen(doc)`. |

A stop with no DO yet cannot be started or completed here — it deep-links to the
SO via `onOpen` so the office cuts the DO first.

**REAL-DATA DISCIPLINE:** fields the backend does NOT provide (emergency contact,
move type, per-item spec, sales-rep contact, 3D floor plan) are omitted, never
invented. Money is balance-only and never NaN.

#### The "Delivery details" card — `MobileDeliveryFieldsCard.tsx`

The stop detail's editable HC-fields card lives in its own file
(`frontend/src/mobile/MobileDeliveryFieldsCard.tsx`), not in
`MobileDeliveryPlanning.tsx` — that file sits under a 2,449-line ceiling in
`scripts/file-size-ceilings.json`. `pdRow` / `hhmm` / `EM` moved there with it
and MobileDeliveryPlanning imports them back; the dependency is one-way on
purpose, since the reverse direction would be a cycle.

It is the mobile counterpart of the desktop drawer and PATCHes the same
endpoint, so it carries the drawer's **two groups**:

- **SO-context** — move-in (possession) date, house type (`New House` /
  `Replacement`), referral, replacement / disposal. Saved on the SO header, so
  the card **renders and these stay editable whether or not a DO exists**.
- **DO-execution** — time window + confirmed, arrival / departure, shipout date,
  customer-delivered date, port ref, HC "Remark 4" sub-status. These columns
  live on the DO, so the group is replaced by a "create a DO first" hint when
  there is none. (Desktop disables a `<fieldset>` instead; eight greyed inputs
  is a lot of dead phone screen.)

Mobile sends a **changed-only diff** where the drawer posts the whole form. That
decision is the pure exported `buildDeliveryFieldsPatch(initial, form, {
procLocked, hasDo })`, pinned by
`frontend/src/mobile/mobileDeliveryFields.test.tsx` — test the builder, not a
render, when changing what a save sends.

#### `replacement_disposal` has TWO lanes, and the client picks

This is the one field on either surface that does not always go down the direct
PATCH, and it is not documented anywhere else.

Owner ruling 2026-07-27: `replacement_disposal` is a CONTROLLED SO field. On an
order that is processing-locked or PO-locked, a change to it "appears in SO
Amendment — Logistics reviews → approves" rather than being written from the
board. **The backend enforces this independently**: the `fields` handler answers
**409 `so_locked_processing`** for a *genuine* change (it re-reads the stored
value first, so re-saving the same text is not a change) when
`soProcessingLocked(...) || soPoLocked(...)`. The other SO-context fields —
possession date, house type, referral — are FREE and never take this lane.

So a client that simply PATCHes the field on a locked order gets a refusal with
no way forward. Both surfaces therefore recognise the lock themselves, using the
shared `procLockActive` from `frontend/src/vendor/scm/lib/so-detail-gates.ts`,
and:

1. EXCLUDE `replacementDisposal` from the direct PATCH body;
2. raise it through `useCreateAmendment`
   (`frontend/src/vendor/scm/lib/so-amendment-queries.ts`) as a header-only
   amendment (`headerChanges: { replacementDisposal }`, no lines). The same
   payload's LINE half gained `newDiscountSen` in mig 0317 (the delivery fee's
   reduction lever on a locked SO) — irrelevant to this drawer, which sends no
   lines, but the type is shared, so it is named here for the next reader
   diffing it;
3. show the lock warning as soon as the order is locked — before the field is
   dirty, not after.

`procLockActive` needs **`po_locked`** as well as `processing_date` + `status`.
It is server-computed (a live PO already claims one of this SO's lines, 2990
only) and cannot be derived client-side, so it rides on the board payload and
must be declared on `PlanningOrder` *and* on mobile's `BoardRow`. Absent reads
as false, degrading the gate to the date rule alone.

### Trips = Delivery Time Arrangement — the board IS the page


It is the **EXACT Delivery Planning board** — the shared
`DeliveryPlanningBoard` component — LOCKED to `state=PENDING_SCHEDULE` (owner
2026-07-25: "把我的 Delivery Planning 一模一样做进去 Trips,可是你只需要看到的是
pending schedule 的"). Same full HC column set, same CONFIG-DRIVEN region chips,
same expandable per-row line-item detail (the caret → `useDeliveryPlanningLines`
→ `GET /delivery-planning/:docNo/lines`), same multiselect and inline cell
editors. It reuses the board's own data path — `useDeliveryPlanning({ region:
<activeRegion>, state: 'PENDING_SCHEDULE' })` → `GET
/delivery-planning?region=<r>&state=PENDING_SCHEDULE` — so it shares
`derivePlanningState` and cannot drift from the board. No new endpoint, no new
state derivation. There is **no state-tab row** (no `stateTabs` prop): the
split chips above the board are the page's rail.

**Two bulk actions on the multiselect:**

- **"Propose time (N)"** — the per-date, per-zone STOP-SEQUENCE proposal
  (owner's final division 2026-08-08: this page is 排单 — sequencing only; the
  crew machinery moved on to Last Mile Delivery). Under the **confirmed-date
  discipline** (`vendor/scm/lib/propose-time.ts`, pinned by
  `propose-time.test.ts`): the Date page owns dates, so the selection is
  grouped by each order's confirmed delivery date (`amended_delivery_date`
  first, the live trip's date next, effective/customer only as the
  degraded-cache fallback; a dateless order is reported and skipped, never
  dated here), `POST /delivery-zones/sequence-assign` is called ONCE PER
  date-group with that date as its start and the group's MAJORITY warehouse as
  the depot (`depotForDocNos` — the engine geocodes routes, and therefore
  computes delivery windows, only when the request names a depot), and each
  response is PINNED to that one day — a trip the packer walked past the date
  means the own fleet is provably full on the confirmed date, so those orders
  spill to a "beyond own-fleet capacity" list FOR that date (assigned to 3PL
  at Last Mile) instead of being re-dated. The invariant: every proposed
  stop's trip date equals its order's confirmed date. Capacity ceilings and
  max-trips ride the server defaults silently; the depart-time input (beside
  the button) applies to every day's trips. The engine's crewed trips are then
  folded to ANONYMOUS "Trip 1 / Trip 2" cards per date
  (`vendor/scm/lib/anonymous-runs.ts`, pinned by `anonymous-runs.test.ts`):
  every crew/vehicle identity field is stripped — the opaque `vehicleSlotId`
  survives strictly as Apply plumbing (a stop needs a trip; a trip keys on
  (lorry, date)) and never renders. Each stop row shows its **estimated
  delivery window** (`estWindowOf`: engine arrival → finish, which already
  folds the residence-rule installation minutes, + `DELIVERY_UNLOAD_BUFFER_MIN`
  = 15, the one documented unload-buffer constant) beside the ALLOWED
  residence window; a date whose depot could not be geocoded (or whose orders
  carry no warehouse) gets a LOUD red box naming the warehouse and where to
  fix its address. "Apply this run" fans out `useScheduleDelivery` per stop —
  sequence + dates only, NO driver or helper written.
- **"Schedule (N)"** — the Phase-2 manual `ScheduleTripDrawer`
  (`vendor/scm/components/ScheduleTripDrawer.tsx`, #1251), unchanged: Apply
  fans out one `useScheduleDelivery` call per SO, REUSING
  `PATCH /delivery-planning/so/:id/schedule` → `scheduleOntoTrip`.

The board's own bulk field editor (Status / Delivery date / Driver / Lorry) and
the inline cell editors are present too — it is the same component.

**Trip detail lives under the "Time arranged" tab.** When that tab is active,
the trip list + stop sheet (+ the route optimiser and the Phase-4 live map)
render below the board — the trip list is the trip-level view of the same fact
the board's TIME_ARRANGED rows state per order. CANCELLED trips are dropped
(a cancelled trip arranges nothing; the reverse reconcile already returned its
orders to the queue) and the rest order IN_PROGRESS → PLANNED → COMPLETED
(dispatchers watch running trips first), trip_date newest first within a
status.

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
- **Propose times + route** — the SMART proposal (Phase 3, WIRED). Calls `POST
  /trips/propose-schedule` with the selected SO doc numbers + a depot warehouse +
  a depart time; the backend geocodes each stop (cache-first), reads each stop's
  service duration + delivery window from `scm.delivery_residence_rules` (by the
  SO's `building_type`), makes ONE Google Distance Matrix call, and returns a
  sequenced route with per-stop arrival / start / finish times + totals. The
  drawer then renders an interactive Google Map (depot + numbered pins + route
  line) and a DRAG-to-reorder sequence list; reordering recomputes the times
  LOCALLY from the returned matrix (no extra Google call). See "The smart route"
  below.
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

### The smart route — "Propose times + route" (Phase 3)

The smart proposal turns the plain stop list into a sequenced route with clock
times. It is the only place that calls Google's Distance Matrix, and it runs
ONLY on the "Propose times + route" click — never on render (the cost note).

**Backend** — `POST /trips/propose-schedule` (`trips.ts`). Body:
`{ soDocNos[], depotWarehouseId?, departTime? }` (departTime defaults `09:00`).

1. Loads the selected SOs (address parts + `building_type`), scoped to the
   caller's allowed companies.
2. Reads `scm.delivery_residence_rules` for the company → per `building_type`:
   `service_duration_minutes`, `earliest_delivery_time`, `latest_delivery_time`.
   Unknown type → 90-minute default, no window.
3. Geocodes the depot warehouse + each stop through `geocodeAddressCached`
   (`backend/src/scm/lib/geocode.ts`) — CACHE-FIRST against `scm.geocode_cache`
   (mig 0197), so a given normalized address geocodes ONCE ever. A stop that
   can't be geocoded is reported in `ungeocoded[]`, never silently dropped.
4. ONE `travelTimeMatrix` call (`maps.ts` Distance Matrix) over `[depot,
   ...stops]`.
5. `proposeRoute` (`backend/src/scm/lib/propose-route.ts`, PURE + unit-tested)
   sequences the stops: a greedy earliest-deadline-first / nearest-neighbour walk
   where **earliest is a HARD constraint** (the lorry WAITS, never services
   before the window opens), service durations are summed into the clock
   (`finish = start + service`, next leg departs at `finish`), and a stop that
   cannot meet its `latest` is emitted with `windowViolated: true` rather than
   hidden. Returns the sequence + per-stop arrival/start/finish + totals incl.
   the return-to-depot leg.

Gated exactly like `optimize-route`: no `GOOGLE_MAPS_API_KEY` → `{configured:
false}`, no Google call, drawer keeps its plain list. No depot geocode / no stop
geocoded / matrix failure → `{configured:true, ok:false, reason}`, reported
honestly. NOTHING is written here — the proposal is display-only until Apply.

**Frontend** — the drawer (`ScheduleTripDrawer.tsx`) calls `useProposeSchedule`,
renders `ScheduleRouteMap.tsx` (the Maps JavaScript API via
`@vis.gl/react-google-maps`, markers + polyline drawn imperatively through
`useMap()` so no cloud `mapId` is needed), and a drag-to-reorder sequence list.
The map's browser key is `import.meta.env.VITE_GOOGLE_MAPS_API_KEY` — UNSET →
the map degrades to a "map key not configured" note (the sequence + times still
render); a runtime load failure degrades in-place. A drag reorders the sequence
and recomputes the times via `recomputeSequenceTimes` (PURE, reuses the returned
matrix — NO extra Google call).

**Apply** persists the proposed ORDER + ETA onto the trip stops through the SAME
schedule path — `PATCH /delivery-planning/so/:id/schedule` now accepts optional
`stopNo` / `etaOffsetS` / `legDistanceM` / `legDurationS`, and `scheduleOntoTrip`
writes them onto `trip_stops` (stop lands in the proposed position with its ETA,
mig 0134 columns). Omitted on a plain schedule → behaviour unchanged. No new
schedule endpoint, no new trip logic.


### Live driver tracking — "Live location" (Phase 4)



The dispatcher watches the driver move in real time, with **no websockets** —
polling is this repo's realtime mechanism. The approach is PWA geolocation: the
driver keeps the delivery page open on their phone, the browser reports
coordinates every ~25s (inside the 20-30s window) via the Geolocation API, the
backend stores each report, and the dispatcher map POLLS the latest position per
driver every 15s.

**One shared logic layer** (repo rule: desktop and mobile are one product):
`frontend/src/vendor/scm/lib/trip-locations-queries.ts` holds everything —
`useTripLocationCapture` (the driver-capture engine), `useMyActiveTrip`,
`usePostTripLocation`, and the dispatcher reads `useTripLatestLocations` /
`useActiveTripLocations`. Cadence constants live there too: `DRIVER_POST_MS`
(25s) and `DISPATCH_POLL_MS` (15s).

**Driver capture (MOBILE)** — `frontend/src/mobile/MobileTrackingBanner.tsx`,
mounted on the mobile Delivery Planning run-sheet. It finds the driver's own
ACTIVE (IN_PROGRESS) trip via `useMyActiveTrip` (the trips list is already
backend row-scoped to a Driver/Helper's own trips) and runs
`useTripLocationCapture`, which uses `navigator.geolocation.watchPosition` +
a `DRIVER_POST_MS` heartbeat to POST each fix. It STOPS when the trip completes,
capture is disabled, or the page is backgrounded (Page Visibility) — so there is
no background or persistent tracking. Permission is asked properly; a denial
degrades to a clear "location off" row (never a crash), no-API shows
"unavailable". The banner renders NOTHING when there is no active trip.

**Dispatcher view (DESKTOP)** — `frontend/src/vendor/scm/components/LiveTripMap.tsx`
(the same maps layer as `ScheduleRouteMap` — `@vis.gl/react-google-maps`,
imperative markers via `useMap()`, no cloud `mapId`), wired into
`Trips.tsx` under the selected trip. It shows a "Live location" panel ONLY while
the selected trip is IN_PROGRESS, polling `GET /trips/:id/locations/latest` every
15s. Each driver is a numbered marker with an accuracy halo; the marker + the
"last seen" caption go AMBER when the newest fix is older than 90s (~3 missed
posts). Falls back gracefully: `VITE_GOOGLE_MAPS_API_KEY` unset → the last-seen
time still updates without the map; a trip with no pings yet → an empty map with
a "waiting for the driver's first location" caption.



#### Background capture — the native app (Phase 5)

The browser path stops when the page is backgrounded. That is correct for a
browser tab and it is also the hole: **a driver who pockets their phone between
drops disappears from the map**, which makes "where is my delivery" unanswerable
honestly. No mobile browser can watch position with the screen locked; this is
the reason the native app exists at all.

`frontend/src/vendor/scm/lib/native-location.ts` is the bridge.
`useTripLocationCapture` now takes the native branch when
`hasBackgroundLocation()` is true and falls through to the browser watcher
otherwise. **Everything downstream is identical** — same mutation, same
`POST /trips/:id/location`, same accepted/rate-capped handling. Only the source
of the fix differs.

Two things about the native branch that are deliberate:

- **No Page Visibility listener and no heartbeat interval.** Stopping on hidden
  is precisely what it replaces, and the plugin's `distanceFilter` (30 m) decides
  when a fix is worth sending. A stationary lorry stops filling the table with
  identical rows, and the battery cost is what decides whether drivers leave
  tracking on at all.
- **No npm dependency in `frontend/`.** The plugin lives in `native/`. A
  Capacitor plugin's JS wrapper is a thin shim over
  `window.Capacitor.Plugins.<Name>`, so the bridge calls that directly — zero
  bytes in the web bundle, which matters because the bundle-size gate is at its
  ceiling on main. The types are a hand-written mirror of the plugin's
  `definitions.d.ts`.

#### `simulated` — a faked position is recorded, not refused (mig 0253)

The native watcher reports `simulated: true` when a fix came from a
mock-location app rather than the GPS chip. A browser cannot tell, and always
leaves the column at its `false` default — which is a true statement about a
browser ping, not a guess.

It matters because these rows are about to answer a **customer-facing** question,
and a driver running a mock-location app can put the lorry anywhere. Refusing the
ping would leave a gap indistinguishable from lost signal — the most common and
most innocent thing in this data. A row that says "this was simulated" is
evidence; a missing row is nothing. What to do about it belongs to whoever reads
the trail, not to the write path.


### The Option B side map — board LEFT, sticky map RIGHT (owner decision 2026-08-08)

All three arrangement pages — Delivery Date Arrangement (`AutoSchedule.tsx`),
Delivery Time Arrangement (`Trips.tsx`) and Last Mile Delivery (`FleetDay.tsx`)
— carry the SAME split (mockup-approved): the board on the left, a ~40%-wide
STICKY map panel on the right.

**Split rules.**

- The ✕ collapses the map and the board returns to FULL width; a "Show map"
  button beside the split chips reopens it. The open/closed choice persists
  per page under `dmap-open.<page>.v1` (DEVICE_PREF — the same personal-pref
  localStorage idiom as the ResizableDrawer widths; registered in
  `lib/browserStorageRegistry.ts`, caller `DeliveryMapPanel.tsx`).
- While the map is OPEN the board auto-narrows to the ESSENTIAL columns — SO
  No / Customer / State / Postcode / Delivery Date + Est. New Delivery Date,
  plus Trip No. + Time Slot on the Time page and Trip No. on Last Mile
  (`MAP_ESSENTIAL_COLUMNS*` in `vendor/scm/lib/delivery-map-model.ts`). This
  is a RENDER-TIME overlay: the board passes `visibleColumnsOverride` → the
  DataGrid's `overlayHidden` prop, which hides ON TOP of the user's own
  hidden set without ever writing the persisted layout — close the map and the
  user's own column prefs return exactly as saved. Do NOT implement narrowing
  by writing `layout.hidden`.
- The narrowing is a **DEFAULT, never a lock** (owner bug 2026-08-08: columns
  ticked in the Columns panel stayed hidden — "已经添加了 column 可是它却没有
  出来"). A visible "Compact columns" pill on the panel header carries the
  state (on by default; persisted per page under `dmap-compact.<page>.v1`,
  same DEVICE_PREF idiom as `dmap-open`, via `useMapCompactColumns`), and any
  EXPLICIT column-visibility choice while the map is open — the Columns
  drawer's toggle / Show all / Reset, the header context menu's Hide/Show,
  applying a saved layout — fires the DataGrid's `onUserAdjustColumns`, which
  the pages use to switch compact OFF so the user's picks win instantly.
  Pinned by "overlay narrowing yields to explicit column choices" in
  `DataGrid.test.tsx`.

**What each page's map shows.**

| Page | Map content |
|---|---|
| Date | Depot marker + ONE pin per order whose effective delivery date is the PICKED DATE (a required date input on the map header; region chips re-fetch + re-fit the viewport). Pin colour = postcode ZONE, region-bucket fallback (`zoneColorFor` — deterministic per zone NAME). Hover/click → a mini card (SO no, customer, sets, address); a totals line (orders / sets / RM). |
| Time | Everything above + the PROPOSED runs for the picked date as coloured polylines with numbered stops and each stop's ESTIMATED delivery window (`estWindowOf`, the #1720 fold — the same text the run card shows); with no live proposal the day's STAGED trips draw instead, off the server-stamped `trip_id` / `trip_stop_no` / `trip_eta_offset_s` board columns (`stagedRoutesFromRows`), each stop labelled with its ETA offset — the arranged view is never poorer than the proposal view; nothing staged/proposed → pins only. |
| Last Mile | The same staged routes for the picked day + CREW labels (plate · driver) per route from `GET /trips/day`. The page's old standalone day-map section became this panel: the "Lorries today" side list MERGED into the trip/crew cards, which render UNDER the map while it is open (colour dot, plate, crew line, warehouse, drops/revenue, per-trip run-sheet link) and below the board when it is closed. The printable run-sheet (`FleetRunSheet.tsx`) still uses `FleetDayMap` + `GET /trips/day` unchanged. |

**Readability + navigation (owner feedback 2026-08-08, on prod).**

- **Clustering.** At low zoom, plain order pins fold into coloured COUNT
  bubbles; clicking a bubble zooms into its members. Hand-rolled pure grid
  fold (`clusterPins` — ~64 px cells per integer zoom, dominant member colour,
  off at zoom ≥ `CLUSTER_OFF_ZOOM`), deliberately NOT the
  `@googlemaps/markerclusterer` dep: zero bundle cost, deterministic and
  unit-tested, and the panel's imperative overlay (selected-pin outline, focus
  dimming, hover cards) would fight the library's renderer abstraction.
  Numbered TRIP stops and the depot never cluster; nor does the selected pin.
- **Region fly-to + auto-fit.** Every (date, region) data load auto-fits the
  viewport to the loaded pins (`viewportForPins` + the panel's `viewKey`):
  many pins → fit with padding, zoom clamped to `FIT_MAX_ZOOM` (15); ONE pin →
  centred at `SINGLE_PIN_ZOOM` (14, never street level); ZERO pins → fly to
  the region's static geographic extent (`regionExtent`) with a "0 orders in
  this region" note over the map. Region chips therefore ARE the fly-to:
  clicking Southern with one Johor order lands the map on that order.
- **Zone summary strip.** A per-region count strip above the map
  (`zoneSummary` fold over the already-fetched geo points): under All, every
  bucket with orders in master order + a "rest 0" collapse; under a region
  filter only that region's count is claimed (the others are not loaded). The
  totals line stays.
- **Trip legend + direction.** Trip polylines are bold (weight 4) with
  direction arrows; stops are numbered coloured circles. A TRIP LEGEND under
  the map (`legendFromRoutes`) lists one row per trip — swatch, "Trip N",
  stop count (allRefs, unpinned included), time range (first window's start →
  last window's end; ETA offsets range the same way; none → null, never
  fabricated), crew label on Last Mile, and the per-stop windows small.
  HOVERING a legend row dims the other trips (visual only); CLICKING is the
  existing focus behaviour (dim + zoom + board filter). The marker hover card
  also shows the stop's trip, number and window.
- **Decluttered roadmap.** The roadmap layer applies `roadmapDeclutterStyles`
  by default — POI icons/labels, transit and road-shield badges (E19/AH2) off;
  locality/town names and road-name text KEPT so orientation survives. Works
  because the panel's map is classic raster with NO cloud mapId (a vector
  mapId ignores the inline `styles` array — check before reusing). A small
  "Labels" toggle (roadmap only) mirrors Satellite's checkbox: off = ALL
  labels off (chosen over locality-only — one mental model with Satellite).
  Satellite/hybrid and their built-in Labels checkbox are untouched.

**Two-way linkage + trip focus.**

- Board row click → that order's pin ENLARGES/outlines and the map PANS to it
  (`selectedRef`). Pin click → the board scrolls to and highlights the row —
  the DataGrid's new `scrollToRow` prop (`{ key: rowIdOf, nonce }`): the
  virtualizer path scrolls by index, the plain path by the row's
  `data-rowkey`; the existing single-row highlight is the marker.
- Clicking a trip card (RunCard on Time, the crew card header on Last Mile,
  the trip list on Time's arranged tab) or its polyline FOCUSES the trip: the
  other routes dim, the viewport fits the focused route, and the board filters
  to its stops (`focusFilterRows` — keyed by refs, so an unpinnable stop still
  filters IN). Clicking again unfocuses; Last Mile stores the focus in the
  existing `?trip=` URL param (the run-sheet deep link).

**Files — one shared panel, pure folds, three presentations.**

- `frontend/src/components/scm-v2/DeliveryMapPanel.tsx` — the React/Maps
  shell: `@vis.gl/react-google-maps` + the FleetDayMap imperative `useMap()`
  overlay idiom (classic raster, no cloud mapId), extended with click/hover
  wiring, focus dimming and the selected-pin outline. Also `useMapPanelOpen`.
  No `VITE_GOOGLE_MAPS_API_KEY` → a note, everything else still works.
- `frontend/src/vendor/scm/lib/delivery-map-model.ts` — the PURE model
  (`zoneColorFor`, `pinsFromGeoPoints`, `geoTotals`, `routesFromRuns`,
  `stagedRoutesFromRows`, `focusFilterRows`, `toggleFocus`, `clusterPins`,
  `viewportForPins`/`regionExtent`, `zoneSummary`, `legendFromRoutes`,
  `roadmapDeclutterStyles`, the essential column sets), pinned by
  `delivery-map-model.test.ts`.
- `frontend/src/vendor/scm/lib/delivery-geo-queries.ts` — `useDeliveryGeo`,
  `staleTime` 30 s like its siblings, fetched once per (date, region), and
  DISABLED while the panel is closed (a closed map fetches nothing).
- Backend: `GET /delivery-planning/geo` (see §2's table row) — the zone rule
  is the delivery-zones router's own map + default (`toPrefixMap` exported,
  one rule two readers), sets are the packer's `deriveSetCount`, geocodes are
  the mig-0197 cache. Ungeocoded orders are LISTED beside the map ("N 张单定位
  不到 — 检查地址"), never silently dropped.

### The four state tabs

`DELIVERY_STATES` (`frontend/src/vendor/scm/lib/delivery-planning-queries.ts:19-21`)
with labels at `:24-29`; re-exported as `STATE_TABS` in the **shared board**
(`DeliveryPlanningBoard.tsx:189`) and rendered there with an "All" tab prepended
(`:1141-1144`) — only when the host page passes `stateTabs`. It moved out of
`DeliveryPlanning.tsx` when the board was extracted; that page is now 404 lines.

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

### Packing lists — a trip, rendered (owner 2026-08-25/26)

Route: `GET /trips/packing` in `backend/src/scm/routes/trips.ts`, registered
before `/:id`. Assembly: `backend/src/scm/lib/packing-list-view.ts`.

**There is no `packing_lists` table and there must not be one.** `scm.trips`
already IS "one day + one lorry" — `trip_date DATE`, `lorry_id`, both indexed
(mig 0053) — and `scm.trip_stops` already carries the ordered drops with a
delivery order hanging off each. So the owner's rule falls out of the schema
rather than needing a schema: 「如果今天出 3 辆罗里，就会有 3 个 packing list；
如果出 5 辆罗里，就会有 5 个；一周 6 天、每天 1 辆罗里，那就是不同日期的 6 个」.
Three trips on a date = three packing lists. Mixed companies work by
construction, because each stop's DO carries its own `company_id`.

> **"No table" is NOT "not a row", and reading it that way cost a release.**
> `scm.trips` has a uuid primary key and carries `company_id bigint NOT NULL`
> from mig 0083 — the same migration, with the same treatment, that gave
> `scm.delivery_orders` the column its public token's tenant scope rests on. PR
> #2722 read the sentence above as "a packing list is not a row" and shipped the
> delivery-order scan without the packing-list half on that basis. See
> `docs/bugs/0545-…`. The rule in this paragraph is about not creating a
> redundant TABLE; it says nothing about whether a packing list has an identity.

It hangs off **Last Mile Delivery**, not off the Delivery Order —
「packing list 不是跟着 delivery order 走的，应该挂在 transportation 的
last-mile delivery 模块下。因为我们还有我们的 delivery 那一边，可能掺杂了不一样
公司的一些 DO」.

**The sheet is the REVERSE of the route, and that is the whole point.** Stops are
numbered 1..N in DELIVERY order; the printed sheet runs N..1, because the last
delivery is loaded first and goes deepest into the lorry:
「Packing List 还得根据我的 Delivery Time 那边去排序，把最后一张单排在最前面。
因为我们进货 Loading 的时候，都是把最后一张单放在最里面，所以顺序应该反过来」.

The reversal lives in ONE function — `loadingOrder` in
`frontend/src/vendor/scm/lib/packing-list-model.ts` — so the screen and the
sheet cannot drift apart on it, and
`frontend/src/vendor/scm/lib/packing-list-model.test.ts` fails if anyone "fixes"
it to ascending.

**Numbered by LOADING order only.** The sheet prints 1, 2, 3 and does NOT also
print the stop number beside it. The two-number form was shown to the owner and
rejected: 「LOAD FIRST ① STOP 3 · … 这个地方太复杂了」. Same reason the header
carries `Lorry · Driver · Stops · Total` and not a combined `Stops / DOs`.

**All copy on the sheet is ENGLISH** (owner checked, 2026-08-26). The letterhead
is `drawHeader` from `vendor/scm/lib/pdf-common.ts` — the same one the other
twelve generators use — so company details follow the switcher and are never
typed into the document.

**The status chip is a ROLLUP, and it can refuse to answer.** The words are the
owner's ladder over the rungs `scm.do_status` actually has: `LOADED` = Confirmed,
`DISPATCHED` = **Loaded**, `IN_TRANSIT` = In Transit, `SIGNED`/`DELIVERED`/
`INVOICED` = Delivered. `rollupDeliveryStatus` names the furthest rung any member
DO reached and counts how many got there — "Loaded 2/3" — and returns **null**
when there is no readable delivery order at all, which the row renders as a dash.
A company predicate that matched nothing and a run with nothing on it are the
same shape from the client, so a confident `Delivered 0/0` would be a claim the
data cannot support.

**What the rack column can and cannot say.** Houzs stores ONE rack per
delivery-order LINE (`scm.delivery_order_items.rack_id`, mig 0118), so the sheet
prints one rack per line and a dash where no explicit pick was made (dispatch
auto-picks then). It does NOT print per PIECE. Hookka can — its packing job cards
carry a rack per component, which is why its sheet reads "HB: Rack 19 / Divan:
Rack 19, 20" — and Houzs has no piece layer to read. Inventing one would be a
sheet that says more than the data does.

### The sheet's QR is PUBLIC, and one scan moves the whole run (2026-08-26)

> **CORRECTED.** This section used to end: *"The QR points at an AUTHED route.
> `/scm/fleet-day?date=&trip=<id>` … A public no-login scan target is a separate
> change with its own security review."* It is public now, and the paragraph
> above it — "There is no `packing_lists` table and there must not be one" —
> was read as *"a packing list is not a row"* and used to justify skipping this.
> **That inference is wrong: a packing list is a trip, and a trip IS a row.** See
> `docs/bugs/0545-…`. The no-table rule stands; it was never a statement about
> rows.

The printed sheet's QR encodes **`/d/<token>`** and is captioned **`SCAN AT EACH
STEP`** — the same words as the delivery-order print, because it is the same act.

> **THE TOKEN'S LENGTH IS A PRINT SETTING (2026-08-27).** A QR's readability is
> its MODULE size, and the module count comes from the payload — so at a fixed
> printed size a longer token is a less scannable code. The owner asked for a
> smaller code on the sheet, which with the same payload would have made a worse
> one, so the two changed together: the token went from **64 hex to 10
> characters** (Crockford's alphabet, no `i`/`l`/`o`/`u`, because a warehouse
> reads these off paper and phones them in), the code went from 41 modules to 29,
> and the print went from 16mm to **14mm — 12% smaller AND 0.424mm per module
> against 0.356mm before.** The only figure with field evidence behind it is
> Hookka's 0.415mm, running on a warehouse floor today. Details and the refused
> 10mm arithmetic: `docs/bugs/0552-…`.
>
> **Both shapes resolve.** Every sheet already on a lorry carries a 64-hex token
> and keeps working; only the short form is minted from now on. `drawQrIntoPdf`
> treats its size argument as a FLOOR TO GROW FROM, so a legacy token prints at
> the size it needs rather than being squeezed into 14mm and quietly failing at
> the lorry. It opens `frontend/src/pages/PublicDoScan.tsx` with **no login**: the
driver carrying the sheet has no account, and the token is the credential.

**One scan moves the whole run.** The spec quotes the owner: 「这三个操作都可以
通过 scan DO 或 scan packing list 来达成（scan packing list 会将该 list 内的货物
统一全部出完）」. `POST /api/public/do-scan/:token/advance` applies the rung to
every delivery order on the run.

| what | where |
| --- | --- |
| the column pair | `scm.trips.qr_token` + `qr_revoked_at`, **mig 0329** (UNIQUE partial index on the token; no index on revoked_at) |
| minting | `GET /api/scm/trips/:id/scan-token` — authed, lazy, atomic claim, `backend/src/scm/routes/trip-scan-token.ts` |
| resolving + members | `resolveScanToken` / `loadTripScanMembers`, `backend/src/scm/lib/do-scan-token.ts` |
| the fan-out | `advanceWholeRun`, `backend/src/routes/publicDoScan.ts` |
| arming the print | `armPackingScanToken`, `frontend/src/vendor/scm/lib/packing-scan-token-arm.ts` |

**Four properties, each bought by a specific failure mode:**

1. **`stop_no` order.** The sequence the dispatcher built.
2. **Sequential, never parallel.** Two drops on one run frequently share a sales
   order, and the status writer updates it (`syncSoDeliveredFromDo`) on the
   delivered hop; run them together and they take that shared row in different
   lock order. Hookka wrote the deadlock down after paying for it, along with
   invoice numbers colliding on a read-MAX-then-+1. The test **counts writes in
   flight**, so a `Promise.all` added later fails it.
3. **One refusal never aborts the rest.** Every drop is attempted and every drop
   gets a line: `{ stopNo, doNumber, outcome, from, to?, message }` with
   `outcome ∈ DONE | ALREADY_DONE | BLOCKED | FAILED`, under a run headline of
   `DONE | PARTIAL | NOTHING`. "3 of 5 recorded" without naming the two is worse
   than silence — the driver has to re-scan the run to find out which.
4. **A re-scan drags nothing on.** Each drop's "already at or past this rung" is
   checked before the ladder, so a second scan of the sheet reports already-done
   per drop instead of walking everything to the NEXT rung.

**A DROP ON ANOTHER COMPANY'S BOOKS IS REFUSED — and this is the sharp edge.**
Trips is a **cross-company** module by design; `routes/trips.ts`'s own header
says *"a trip is raised from whichever company you are in; it may still reference
the other company's DOs"*, and the paragraph above says mixed companies work by
construction. On an authed dispatcher's screen that is a feature. Reached from a
printed sheet with **nobody logged in**, it is a lever that moves another
company's books — `docs/bugs/0497` with a QR code in front of it. So:

- the run's company comes from the **trip row** the token resolved to;
- each member DO is read **by id**, returning its **own** `company_id` —
  deliberately NOT scoped to the run's company, because a scoped read would make
  a stranger **vanish** from the sheet rather than be reported, and a drop that
  silently disappears is one the driver loads anyway;
- the **comparison** is the guard: mismatch ⇒ `BLOCKED`, never written;
- a foreign drop is named by its **stop number only** — no document number, no
  customer name. Printing the other company's document number on a page anyone
  holding the sheet can open is the leak, not the fix;
- every **write** is scoped to the run's company regardless.

> **AN OPEN DECISION FOR THE OWNER — nobody has ruled on this.** On a
> *deliberately* mixed run the scan now moves this company's drops and refuses
> the other company's, telling the driver which. That is the SAFE direction; it
> is not obviously the WANTED one, and the choice is a business call rather than
> a routing detail.
>
> | option | what it costs | what it means to live with |
> | --- | --- | --- |
> | **(a) keep the refusal** *(shipped)* | a mixed run needs a second scan — the other company's delivery orders scanned individually | safest: a public sheet can never move books it does not belong to. A driver on a mixed run does extra work |
> | **(b) let one scan move both** | the token would have to authorise every company the trip legitimately touches, which widens what one piece of paper can do | most convenient; the blast radius of a lost sheet grows to both companies |
> | **(c) stop trips carrying another company's DOs at all** | a planning-side change, and it contradicts the cross-company design the TMS was built on | cleanest tenancy story, biggest change, and it removes a capability dispatch may be using |
>
> **Recommended: (a) now, and ask whether mixed runs actually happen before
> spending anything on (b) or (c).** How common a mixed run is has NOT been
> measured — no production query was made for this change — and that number
> should decide it. A read-only probe is the way to get it (CLAUDE.md: never ask
> the owner to run a query, build the check).

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
| GET | `/delivery-planning/geo` | `delivery-planning.ts` (registered BEFORE `/:docNo/lines` — 'geo' would parse as a docNo) | **Option B side map (2026-08-08).** `?date=YYYY-MM-DD&region=<r>` → `{ date, region, configured, points[], depot\|null, depotReason, ungeocoded[] }` — one point per SO whose EFFECTIVE delivery date (amended ?? customer) is the picked day. Allowed-companies scoped + region-filtered with the board's own config classification + per-assignee row scope (latest-DO assignment rule). lat/lng resolve CACHE-FIRST through `scm.geocode_cache` (ONE batched read, then at most one Google call per never-seen address — cached forever; no `GOOGLE_MAPS_API_KEY` → only cached addresses pin, nothing bills). A point carries `zone` (postcode-zone via the delivery-zones map), `region`, `sets` (the packer's `deriveSetCount`), `revenueCenti`, `customer`, `address`; unlocatable orders return in `ungeocoded` with a reason, never dropped. Depot = the day's MAJORITY line-warehouse (ties to first seen), geocoded the same way; `depotReason` says why when null. READ-only, no polling — the frontend fetches once per (date, region) |
| PATCH | `/delivery-planning/:type/:id/fields` | `:1493` | HC delivery fields, in two groups. **SO-context** (`possessionDate`, `houseType`, `referral`, `replacementDisposal`) writes the SO header and needs no DO; **DO-execution** (`timeRange`, `timeConfirmed`, `arrivalAt`, `departureAt`, `shipoutDate`, `customerDeliveredDate`, `etaArrivingPort`, `deliverySubstatus`) writes the latest DO and answers `no_do_hint` when there is none. **`replacementDisposal` is the exception:** a GENUINE change to it on a processing- or PO-locked SO is refused **409 `so_locked_processing`** — it must arrive as an SO Amendment instead (§1, "`replacement_disposal` has TWO lanes"). The other three SO-context fields are free |
| PATCH | `/delivery-planning/:type/:id/schedule` | `:1705` | Schedule date + **driver / lorry assignment**; `type` = `so \| do \| assr` |
| GET/POST/PATCH/DELETE | `/delivery-planning-regions`, `/…/states/:stateKey` | `delivery-planning-regions.ts:65,89,120,150,196,228,261` | Region master + the state→region map |
| GET/POST/PATCH/DELETE | `/delivery-residence-rules`, `/…/:id` | `delivery-residence-rules.ts` | Per-building-type CONFIG (mig 0196): service duration + access windows + lift/registration flags. Per-company scoped (scopeToCompany read / scopeToCompanyId write). The Phase-3 scheduler READS this; no scheduler is wired here. NOT openRead — unlike the region master this is not a cross-page picklist. |
| GET/POST/PATCH | `/drivers` | `drivers.ts:26,40,71` | Driver master |
| GET/POST/PATCH | `/helpers` | `helpers.ts:23,35,64` | Helper master |
| GET/POST/PATCH | `/lorries` | `lorries.ts` | Lorry master. **A1 (mig 0205):** POST/PATCH also accept `maxSets`, `maxRevenueCenti`, `capacityLayer` (SETS\|REVENUE\|BOTH) — the per-lorry delivery capacity ceilings the auto-propose packer reads. NULL max_* => the packer uses its config default (10 sets / RM30k). **WS3 (mig 0209):** POST/PATCH also accept `lengthFt`/`widthFt`/`heightFt` (ft); when all three are supplied together `capacity_m3` is re-derived from them via the pure exported `boxCapacityM3` (ft3 x 0.0283168, 2 dp). `warehouseId` (the home-warehouse = REGION) is editable here and gates which trips can pick the lorry |
| GET/POST/PATCH/DELETE | `/delivery-zones`, `/…/:id` | `delivery-zones.ts` | **A1.** The postcode-prefix -> zone map CRUD (mig 0205). GET returns `{ zones, usingDefault, defaultMap, knownZones }`; writes validate `zone` against the 14 canonical zones. Company-scoped |
| POST | `/delivery-zones/propose` | `delivery-zones.ts` | **A1 auto-propose.** Body `{ soDocNos[], depotWarehouseId?, startDate?, defaultMaxSets?, defaultMaxRevenueCenti? }`. Loads the SOs + their lines, derives each order's zone (postcode) + set count (frame/mattress/sofa), loads the depot's active in-house lorries, and PACKS via the pure `capacity-pack.ts` (shared `loadAndPack` helper). Returns a DISPLAY-ONLY proposal (`days[] · proposals[] · unassigned[]`). Writes NOTHING |
| POST | `/delivery-zones/sequence-assign` | `delivery-zones.ts` | **A2 sequence + assign / A3 leave + overflow.** Body adds `departTime?` + `maxTripsPerLorryPerDay?`. RE-PACKS (shared `loadAndPack`), crews each group with an AVAILABLE lorry + driver + helper (`fleet-assign.ts`, excluding Module-B non-dispatchable lorries AND on-leave drivers AND (WS2) on-leave helpers), spilling groups the own fleet can't cover to 3PL `overflow[]`, and sequences each trip (geocode cache-first + ONE Distance Matrix call per trip + `sequence-stops.ts`) with residence-rule windows. Returns DISPLAY-ONLY `{ trips[] · excludedLorries[] · excludedDrivers[] · excludedHelpers[] · overflow[] · carriers[] · unassigned[] }`. `GOOGLE_MAPS_API_KEY` unset -> crewed + grouped, no route. Writes NOTHING |
| GET/POST/PATCH/DELETE | `/threepl-companies` | `threepl-companies.ts` | **3PL carrier company master** (`scm.threepl_companies`, migs 0210 + 0237). Company-scoped, `scm.transportation.drivers` gate. GET returns each company + `lorryCount` / `driverCount` / `helperCount`. `(company_id, name)` UNIQUE -> 409 `duplicate_name`; `(company_id, registration_no)` UNIQUE where not null -> 409 `duplicate_registration`. DELETE detaches its whole fleet (every FK is ON DELETE SET NULL), never deletes it |
| GET | `/threepl-companies/:id/fleet` | `threepl-companies.ts` | The carrier's own drivers, helpers and lorries. **Read-only** — the rows are written through `/drivers`, `/helpers`, `/lorries`, which own the outsource rule |
| GET/POST/DELETE | `/driver-leave` | `driver-leave.ts` | **A3/WS2 crew-leave master.** CRUD over `scm.driver_leave` (mig 0206 + 0208) — the date-ranged absences the A2 assigner reads to skip on-leave crew. Company-scoped, `scm.transportation.drivers` gate. **WS2:** POST takes EXACTLY ONE of `driverId` / `helperId` (XOR, mig 0208 CHECK); rows output both (the unused one `null`); GET filters by either. **INTERNAL drivers only:** a driver POST rejects an external / 3PL driver (`scm.drivers.in_house = false`) with 422 `external_driver` (unknown → 404) via the pure `isInHouseDriver`. Helpers have no external case yet (no in_house column), so a helper POST only checks the helper exists (unknown → 404) |
| GET/POST/DELETE | `/delivery-zones/locks`, `/…/locks/:id` | `delivery-zones.ts` | **A1.** Reversible day locks (`scm.delivery_day_locks`, mig 0205). POST is idempotent (upsert on `(company, warehouse, date)`); DELETE unlocks |
| GET | `/lorry-service-records` | `lorry-service-records.ts` | Service history (mig 0121) |
| GET/POST/PATCH/DELETE | `/trips`, `/trips/:id`, `/trips/:id/stops`, `/trips/:id/status` | `trips.ts:101,141,175,234,277,325,398,412` | Trip (lorry-day) CRUD + stop ordering |
| GET | `/trips/day` | `trips.ts` (before `/:id`) | **Fleet A4 day-view.** `?date=YYYY-MM-DD&warehouseId=<id>` → `{ date, configured, warehouses, trips[] }`: every non-cancelled trip that day with its ordered stops enriched (customer / phone / house type / window / ETA / revenue) and geocoded (cache-first, gated on `GOOGLE_MAPS_API_KEY`). READ-only; enriches phone + house type by resolving each stop's `do_id → delivery_orders.so_doc_no → mfg_sales_orders`, and the window from `scm.delivery_residence_rules`. Per-assignee row scope like the trip list. Shaping is the pure `scm/lib/fleet-day-view.ts` (`assembleDayView`). |
| GET | `/trips/packing` | `backend/src/scm/routes/trips.ts` (before `/:id`) | **Packing lists (2026-08-26).** `?date=YYYY-MM-DD&warehouseId=<id>` -> `{ date, lists[] }` — ONE ENTRY PER TRIP, because a packing list IS a trip (one lorry, one day; owner 2026-08-25). Each entry carries the trip header (plate / driver / depot), the counts (stops, DOs, units) and `m3_milli`, plus its stops in DELIVERY order with each stop's delivery order, its LINES and the rack each line was picked from. READ-only. **Five reads, five company predicates** — trips, delivery_orders, delivery_order_items and warehouse_racks all take `scopeToAllowedCompanies`; `trip_stops` has no `company_id` column (mig 0053) and is scoped through its already-scoped trips. Every id list is chunked (`chunkIn`). Shaping is the pure `scm/lib/packing-list-view.ts` (`assemblePackingLists`); the LOADING-order reversal is frontend-side, in `vendor/scm/lib/packing-list-model.ts`. |
| POST | `/trips/:id/optimize-route` | `trips.ts:438` | Google route optimisation; returns `{configured:false}` when `GOOGLE_MAPS_API_KEY` is unset |
| POST | `/trips/propose-schedule` | `trips.ts` | **Phase 3 smart scheduler.** Selected SO stops + depot → geocode (cached) + residence-rule service/windows + ONE Distance Matrix call → sequenced route + per-stop arrival/start/finish times. `{configured:false}` with no key; nothing written |
| POST | `/trips/:id/location` | `trips.ts` | **Phase 4 live GPS.** A driver on an IN_PROGRESS trip posts one ping `{lat,lng,accuracy?,recorded_at?}`. Range-validated + server-side rate-capped (pings <10s apart ignored); accepted ONLY for an IN_PROGRESS trip; row-scoped to the caller's own trip. A bad ping is rejected cleanly (never a 500). No Google dependency |
| GET | `/trips/:id/locations/latest` | `trips.ts` | **Phase 4.** Latest position per driver on ONE trip, for the dispatcher map. Read-only, row-scoped. `[]` when no pings yet |
| GET | `/trips/active/locations` | `trips.ts` | **Phase 4.** Latest position per driver across EVERY IN_PROGRESS trip (board-level overview). Read-only, scoped to allowed companies + own trips |
| GET/PATCH/PUT | `/lorry-capacity`, `/lorry-capacity/lorries/:id/*` | `lorry-capacity.ts:132,354,389` | Capacity dashboard, in-house flag, repair days |
| POST/GET/PATCH | `/dp-orders`, `/dp-orders/:id/cancel`, `/:id/schedule` | `dp-orders.ts:190,234,281,313,348` | Manual DP jobs with no source document |
| PUT | `/delivery-orders-mfg/:id/crew` | `delivery-orders-mfg.ts:3314` | The only writer of `scm.delivery_order_crew` (driver 1/2 + helper 1/2 + lorry). Written by Last Mile Delivery's per-trip Apply — `useAssignDoCrew` (`vendor/scm/lib/delivery-planning-queries.ts:772-784`) fires one PUT per live DO, called from `FleetDay.tsx:174,341-342`. It is the only store with a driver-2 seat, which is why no migration was needed. |

Machine-generated gate list: `docs/generated/route-capability-matrix.csv`
(rows for `/delivery-planning`, `/trips`, `/drivers`, `/helpers`, `/lorries`).

---

## 3. Backend

### How a job reaches the board — `delivery-planning.ts:409-1372`

The board is a **union of four sources**, assembled per request. Nothing is
materialised; there is no board table.

1. **Sales Orders** (`row_type: 'so'`, `:852`) — live `scm.mfg_sales_orders`
   with `status NOT IN (DRAFT, CANCELLED)` that carry a delivery-date signal
   (`customer_delivery_date` or `processing_date`), paginated so the
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
   **COMPANY-SCOPED since 2026-08-21** — see *Service Cases on the board are
   company-scoped* below. The SQL lives in `assrBoardUnionSql()`
   (`backend/src/scm/lib/assr-board-scope.ts`) rather than inline in the handler,
   so the predicate is assertable
   (`backend/tests/deliveryBoardAssrScope.test.ts`). ASSR rows now also carry
   `company_code`, from the same `companyCodeMap` the SO rows use.
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

**`processing_date` is the SALES ORDER's Processing Date and nothing else.**
The last three sources are jobs, not orders: a service leg, a manual DP job and
a PMS project window have no deposit gate, no supplier PO and no edit lock, so
they have no processing date at all.

> **CORRECTED 2026-08-14 — the intended fix is NOT on main.** This paragraph said
> those rows *"send `internal_expected_dd: null` and carry their own leg date as
> `job_date` (2026-08-13)"*. `job_date` does not exist on `origin/main`
> `0c2a4e88`: `grep -rn 'job_date' backend/src` returns one comment
> (`scm/shared/so-processing-date.ts:28`) and no field. Commit `9fa8e0ff` added
> it to `delivery-planning.ts`; the batch's conflict resolution `e1263558`
> (squashed into `d33ac743`, #2121) **deleted every one of those lines** — the
> `git show e1263558 -- backend/src/scm/routes/delivery-planning.ts` diff removes
> `job_date: null`, `job_date: leg.date` (×2) and `job_date: date`. What ships
> today is the OLD behaviour this paragraph describes as historical: synthetic
> rows carry their leg date in `processing_date` (`delivery-planning.ts:1169`
> ASSR, `:1333` DP, `:1470` project), so the name still means a third thing on
> rows that cannot have one. `frontend/src/mobile/MobileDeliveryPlanning.tsx:177`
> also still describes `job_date` as live; that is a source comment and is left
> alone here on purpose (docs-only diff).

Nothing on the board reads it for those rows: the
"Internal Est." column was removed in the owner's 2026-08-04 column pass, the HC
fields drawer (whose `procLockActive` reads it) is offered on `so` rows only,
and the mobile run-sheet's `effDateOf` reaches `effective_delivery_date` first,
which every synthetic row sets to the same leg date. A **"Processing Date"
column returned on 2026-08-19** (owner request, with Salesperson / Venue /
Total Amount — see below) but it keeps this rule: it renders `processing_date`
on `so` rows ONLY and an n/a dash on the three synthetic kinds, so the leg-date
mirror is never dressed up as a processing date.

**Owner column additions, 2026-08-19** (`DeliveryPlanningBoard.tsx`, all
default-VISIBLE): **Salesperson** (`agent` / `salesperson_id`, resolved to a
name through `useStaffLookup` exactly like the SO list — never a raw UUID;
SO rows only), **Venue** (`mfg_sales_orders.venue`, the sales venue; PMS
project rows show their event venue), **Processing Date** (SO rows only, above)
and **Total Amount** (`local_total_sen`, the SO list's Amount figure; n/a on
job rows whose total is a structural 0 — unlike the default-hidden Balance
beside it, which renders on every row). The `/delivery-planning` SO read now
selects `agent, salesperson_id, venue` and stamps them on SO rows (null on
ASSR / DP rows; project rows fill `venue`).

**Funnels and tabs persist, 2026-08-19** (owner: "漏斗和页签被清掉,也做成和
service case 一样"). Opening a record REPLACES the workspace tab, so returning
to the board is always a fresh mount — and its working view used to die with
it. Two mechanisms, both house-standard: (1) every vendored **DataGrid** now
persists its funnel filters (value sets / date presets / number ranges / custom
date ranges) per grid under `dg-filters:<idKey>` — `dataGridFilterStorage.ts`,
the twin of DataTable's 2026-07-29 `dt:filters:*`; the idKey is the layout
blob's, so the shared boards share filters unscoped while per-tenant grids stay
per-company. Filters are a working view, NOT synced to the account layout
store. (2) `DeliveryPlanning.tsx` swaps `useSearchParams` for
`useStickyFilters('delivery-planning', ['state','region'])` — URL wins,
localStorage restores the last state/region pair when the URL carries none.

**SO-list design parity, 2026-08-19** (owner: "要和 sales order design 设计,
字体,颜色一样" + "一样的button和位置和design"). The DataGrid chrome and the
board's cells now speak the DataTable lists' design language — this applies to
EVERY DataGrid list, not just the board. Table: 13px body / ~34px rows /
`border-subtle` row rules. Cells (`DeliveryPlanningBoard.tsx` type ramp): doc
numbers = Plex Mono 12.5 semibold ink (`DOCNO_STYLE`), Customer = 13 semibold
ink (`strong`), detail text (salesperson / venue / phone / dates / state) =
12.5 ink-secondary (`detail`), money = 13 semibold ink (`MONEY_STYLE`; Balance
keeps its over-collection red / settled grey). Toolbar: the SHARED
`ResetFiltersButton` sits after the search labelled "Reset layout" (clears
funnels + search, hides while inactive — it REPLACED the right-side "Clear
filters" pill AND the footer column-layout reset; column-layout resets live in
the Columns drawer, like the SO list), then the rows·cols caption; right side
is "Export" + the SHARED `ColumnsButton` ("Columns · N"). Region chips wear the
`FilterPills` slab (white track, squared uppercase pills, solid-primary
active; SG keeps its dashed cross-border outline). The filter-chips bar lost
its burnt-orange wash for a neutral grey.

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

Effective delivery date = `amended_delivery_date ?? customer_delivery_date`,
and since 2026-08-18 that rule is not this board's private property: it lives in
`scm/shared/effective-delivery.ts` (`effectiveSoDelivery`), and MRP and the stock
allocator read the SAME function. Before that they ranked on
`customer_delivery_date` alone, so a rescheduled order moved here and did not
move in the queue that decides who gets stock
(`:277-278`). The original customer date is never overwritten.
`backend/src/services/agents/delivery-agent.ts:53` imports this same function,
so the agent and the board cannot disagree.

### The arrangement pipeline — Planning → Date → Time → Last Mile (2026-08-07/08)

The delivery pipeline is FOUR stages over ONE UI family (owner, 2026-08-07/08;
"不用搞得太麻烦" — keep it simple). The owner's FINAL division of labour across
the three arrangement modules (2026-08-08, his own framing):

1. **Delivery Date Arrangement = 排期** — pick the day.
2. **Delivery Time Arrangement = 排单** — for the delivery DAY, decide the
   ORDER of orders within each zone: "在送货当天,决定那一个区要先送哪一张单".
   SEQUENCING ONLY — no lorry and no driver is named here.
3. **Last Mile Delivery = 智能 assign driver + lorry** — the crew / vehicle
   assignment intelligence lives THERE: "我只需要帮它标上去是什么罗里、什么
   Driver、什么 Helper". Crew capacity is flexible per trip: "Helper 可以是两个
   也可以是一个;我也可以选择两个 Driver 出去".

| Stage | Page | What happens there |
|---|---|---|
| 1. Delivery Planning | `DeliveryPlanning.tsx` | The full 4-state board — everything that needs delivering. |
| 2. Delivery Date Arrangement | `AutoSchedule.tsx` | DATES only (排期). Multiselect → "Propose dates" → a DAY-grouped (postcode-zone) proposal with **no lorry dimension** → Apply writes `amended_delivery_date`. |
| 3. Delivery Time Arrangement | `Trips.tsx` | SEQUENCE only (排单). Multiselect → "Propose time" → per-confirmed-date, per-zone stop sequences presented as anonymous **"Trip 1 / Trip 2" runs** (`lib/anonymous-runs.ts` strips every crew/vehicle identity; the engine's lorry-sized capacity is kept, its NAME is not) with each stop's **estimated delivery window** (Google leg ETA + installation time + unload buffer — `estWindowOf`). Applying stages the trip identity + sequence + dates through the schedule PATCH, writing NO driver or helper. The manual Schedule drawer stays. |
| 4. Last Mile Delivery | `FleetDay.tsx` | CREW (智能 assign). The day's numbered trips (trip_no order = the Time page's staging order) each get a crew card — Lorry + Driver 1/2 + Helper 1/2 — prefilled by "Propose crew": ONE leave-aware sequence-assign call over the day's time-arranged orders, its per-run picks re-attached to the REAL trips by stop overlap (`lib/last-mile.ts` `matchCrewSuggestions` — crew is never suggested for a run that does not exist). Apply writes the trip row (`PATCH /trips/:id`) + the `delivery_order_crew` snapshot per DO (`PUT /delivery-orders-mfg/:id/crew` — the ONLY store with a driver-2 seat, hence NO migration). The 3PL overflow tools live here. The day map + run-sheet stay. |

Every page shares one skeleton — PageHeader (one-line description) → split
chips (All / stage tabs with counts) → region chips → the shared
`DeliveryPlanningBoard` — and every edit routes through the ONE existing query
family + schedule PATCH (optimistic all-cache patch), so data interop is
by-construction: nothing is copied between stages, each page is a different
filter over the same stamped rows.

Owner's spec: every order in **Pending Schedule** means "needs a delivery DATE
arranged", and ALL of them flow into the **Delivery Date Arrangement** page
(`AutoSchedule.tsx`) with full data fidelity — "它的 Outlook、UI、Frontend、
Backend、Database，以及所有的 column 等等，该有的资料全部都要进到去" — never a
stripped-down subset. When Date Arrangement CONFIRMS a date, the order flows
AUTOMATICALLY into **Delivery Time Arrangement** (`Trips.tsx`) as work to do
there — no manual re-entry. **Dates first, lorries later, never lump-sum**: the
date page proposes and applies dates only (the packer's lorry-day reasoning
stays server-side; `vendor/scm/lib/propose-days.ts` folds the proposal to
DAY → orders before render), and the lorry / sequence / 3PL machinery lives on
the time page. The states split visibly, two per side:

| Side | Sub-state | Derivation (per request — NO new columns) |
|---|---|---|
| Date | **Pending Date Arrangement** | `delivery_state == PENDING_SCHEDULE` AND `amended_delivery_date IS NULL` AND not on a live trip |
| Date | **Date arranged** | `delivery_state == PENDING_SCHEDULE` AND (`amended_delivery_date IS NOT NULL` OR on a live trip) |
| Time | **Pending Time Arrangement** | date confirmed (`amended_delivery_date`), NOT on a live trip — the Time page's inbox |
| Time | **Time arranged** | a `DELIVERY` `trip_stops` row keyed on one of the SO's DO uuids (`do_id` — the same column `scheduleOntoTrip` writes) whose trip `status != CANCELLED` |

The rule is ONE pure function — `deriveArrangementStage`
(`backend/src/scm/lib/arrangement-stage.ts`, tests
`backend/tests/arrangementStage.test.ts`): three mutually exclusive stages
(`PENDING_DATE` / `PENDING_TIME` / `TIME_ARRANGED`; on-a-trip DOMINATES a
missing date), `null` outside `PENDING_SCHEDULE`. The board endpoint resolves
the two booleans (the dp_no trip_stops read was WIDENED to also return
`trip_id`, joined to `trips` with CANCELLED dropped) and stamps
`arrangement_stage` + `trip_id`/`trip_no`/`trip_date` on every row. Both
frontends read the stamped field and never re-derive
(`dateArrangementOf` / `timeArrangementOf` in
`vendor/scm/lib/delivery-planning-queries.ts`, tests beside it); an old cached
payload with no field degrades to the pre-split view, never a blanked queue.

Row types: SO rows carry the full derivation. A manual DP job joins while
`PENDING_SCHEDULE` (its `requested_date` is its confirmed date, so a dated
unscheduled job is Pending Time — it needs a lorry; scheduling flips it to
`PENDING_DELIVERY`, out of the pipeline). ASSR legs and PMS project windows
land `PENDING_DELIVERY` and stamp `null` — their scheduling lives on their own
documents. `derivePlanningState`, the A1 packer and the schedule write-path are
UNTOUCHED; "Apply proposed dates" / the bulk Delivery-date set writing
`amended_delivery_date` through `PATCH /delivery-planning/so/:id/schedule` IS
the date-confirmation act, and `scheduleOntoTrip` wiring the stop IS the
time-arrangement act.

Surfaces (post the 2026-08-08 restructure): on BOTH arrangement pages the
queue board IS the page body — the EXACT shared `DeliveryPlanningBoard` locked
to `PENDING_SCHEDULE` (full HC columns, region chips, drill-down, inline
editors, bulk bar) — split Pending-Date vs Date-arranged on the date page and
Pending-Time (the inbox, default) vs Time-arranged on the time page, with an
"N awaiting date arrangement" note linking back to the Date page. The date
page's primary bulk action is "Propose dates (N)"; the time page carries
"Propose time (N)" plus the existing Schedule (N) → `ScheduleTripDrawer` flow
unchanged, and its trip list / stop sheet render under the Time-arranged tab.
Last Mile Delivery shows the same board over the day's on-trip rows
(`lib/last-mile.ts`) beside the A4 day map, and carries the CREW machinery —
"Propose crew" + the per-trip Lorry / Driver 1/2 / Helper 1/2 cards + the 3PL
overflow tools (owner's final division 2026-08-08). The Delivery Planning board's
Pending Schedule tab shows the sub-split as a count line under the tab rail,
and two default-hidden columns ("Arrangement", "Trip No.") join the grid.
Mobile is deliberately untouched — the phone surface is the driver run-sheet,
not the planning board (§7's intentional asymmetry).

**Default queue order (owner 2026-08-07 "跟着 delivery date、state、postcode
去排" → v2 2026-08-08: new date first, run time in-group, doc-no tiebreak).**
On entry, BOTH arrangement queues — the Date Arrangement queue and the Time
Arrangement panel, each on BOTH sides (pending and arranged, and their All
tabs) — order by: the **ARRANGED (new) date, OLDEST first** (rows with no
arranged date sink below every dated row), then **customer state** A→Z, then
**postcode** A→Z, then **run time** (the stop's ETA offset on its live trip,
stop sequence as its tiebreak — the board stamps `trip_stop_no` /
`trip_eta_offset_s` off the widened stop read), then the customer's ORIGINAL
date, then the **document number** — blanks always last. **v3 (2026-08-08,
owner-approved): on the PENDING-DATE side — when BOTH rows lack an arranged
date — the customer's ORIGINAL date now outranks geography**: oldest promised
customer date first, THEN state, then postcode ("还没排的，谁答应得最早谁先排").
When either row carries a new date the established order stands unchanged.
The rule is ONE pure comparator, `arrangementQueueCompare`
(`vendor/scm/lib/arrangement-sort.ts`, pinned by `arrangement-sort.test.ts`
including the pending-side pins). It reaches the grid through
the opt-in `defaultSort` comparator prop (page →
`DeliveryPlanningBoard` → `DataGrid`), applied ONLY while no column sort is
active: a header the operator clicks overrides as always, and cycling that
header back to "off" returns to this default, not to raw fetch order. The main
Delivery Planning board passes no `defaultSort` and keeps the server's order
(SO rows by `customer_delivery_date` asc, then the ASSR/DP/project blocks).
Stacked per-column filters (they AND across columns; multi-select within one
column ORs) now surface as an active-filter chips row in the shared `DataGrid`
— one chip per filter with its own clear, plus Clear all — so a layered
narrow-down stays visible and reversible on every grid, this board included.

**Known gap, inherited and documented (BUG-HISTORY 2026-07-22):** a `type:'so'`
schedule for an SO with **no DO** writes no `trip_stops` row at all (no uuid),
so such an order cannot read as Time arranged — it stays Pending Time even
though a trip row exists. Honest by construction: with no stop, no lorry's run
sheet carries the job. Cut the DO first and the stop — and the stage — follow.

The mechanism, for anyone tempted to "fix" the insert: it is guarded
`if (!already && (doId || soId))`, and on the SO-direct path BOTH operands are
always null — `doId` because there is no DO, `soId` because it is set to `null`
a few lines above, since `scm.mfg_sales_orders` has a TEXT `doc_no` primary key
and no uuid while `trip_stops.so_id` is a uuid. The insert is unreachable, not
flaky.

**Since 2026-08-13 the RETURN SHAPE says so** (PR #2086). `TripWiring`'s `WIRED`
arm gained `stopCreated?: boolean` and, when false, `stopSkippedReason` — a plain
sentence saying the date is saved but the job will not appear on a driver sheet
until the DO exists. Additive: every existing field is untouched, so no caller
breaks. **No caller reads them yet either** — `git grep stopCreated` at
`origin/main` returns hits only inside `delivery-planning.ts`, so the dispatcher
still sees a plain success and the operator is still not told. Wiring a surface
to `stopSkippedReason` is the open half. The stop is deliberately NOT invented:
there is genuinely no key to file it under, and guessing one would put a job on a
route that cannot be traced back to its order. The orphan-TRIP half — a trip is
still found-or-created with no stop for it, and `/lorry-capacity` counts it in
`total_trips` and in utilisation regardless — remains open and is recorded in
BUG-HISTORY under the stale-stop sweep entry.

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


### Driver / Helper / Lorry routing model

Three masters, one shared fleet across companies. `drivers.ts:31-34` and
`helpers.ts:23-31` are explicit: the roster is deliberately **not** company-scoped;
`company_id` on a fleet row is a created-by stamp, not an isolation boundary.

**That ruling covers the MASTERS only — it does not cover `trips` /
`trip_stops`** (corrected 2026-08-13). Those are the shared QUEUE, and the queue
has always been read through `scopeToAllowedCompanies` (widen to the caller's
GRANTED companies). Until the unscoped-write sweep the WRITES carried no
predicate at all, so a dispatcher granted only one company could patch, cancel,
hard-delete or re-sequence the other company's trip by id — the service-role
client bypasses RLS, so nothing else stopped it. Every trip / trip_stop write now
carries `scopeToAllowedCompanies`, matching its own read. Shared queue means a
WIDER predicate, never no predicate.

### Service Cases on the board are company-scoped (owner ruling 2026-08-21)

The same correction, one union later. The board's ASSR rows read
`public.assr_cases` through raw `c.env.DB` SQL, and that raw path is exactly why
they shipped company-BLIND: `scopeToAllowedCompanies` is a supabase-js helper and
cannot reach a `DB.prepare()` string, so the predicate has to be written by hand
and nobody did. Meanwhile `/api/assr` scoped the very same table with
`assrCompanySql`. Two surfaces, one table, different answers for the same person
— and the board was the one that leaked.

Shown the board listing service cases from a company the caller holds no grant
for, the owner ruled: 「这个也不可以啊」.

- **The rule has ONE home** — `backend/src/scm/lib/assr-board-scope.ts`.
  `assrBoardUnionSql()` and `assrOpenCaseGuardSql()` append `assrCompanySql`,
  imported from `routes/assr.ts`, the same function `/api/assr` uses, never a
  local copy. `routes/search.ts` kept a copy of this rule once and drifted; that
  is the precedent being avoided. They are a MODULE rather than two more
  functions in the router because the router is at its file-size ceiling — and
  because a statement inside a 3,000-line handler is a statement nothing can
  assert, which is how the predicate stayed missing.
- **Widen, not isolate.** Delivery Planning is a cross-company VIEW module, so a
  dispatcher granted both companies still sees the combined queue. Only a caller
  granted one company loses the other's rows. Measured on production 2026-08-21
  (run 32467665635): 72 board-eligible cases — 70 HOUZS, 2 for 2990, none with an
  unresolvable company — and 61 active users hold exactly one grant, 16 hold both.
- **The WRITE is scoped too.** `PATCH /delivery-planning/:type/:id/schedule`'s
  ASSR branch runs its open-case guard with the same predicate and 404s an
  out-of-scope case, the same answer `/api/assr`'s own `caseInCallerScope` gives.
  Scoping the read alone would have left the half that consumes a lorry open.
- **NOT applied: the row-level VISIBILITY rule** (`assrVisibilityPredicateSql` —
  "which cases may THIS person see within the company"). The ruling was about the
  company boundary; narrowing a fleet coordinator's board to only the cases they
  personally handled is a different decision nobody has made, and it would empty
  the board for dispatchers.
- **Deliberately left company-blind, and NOT a miss:** the PMS project
  setup/dismantle union in the same handler. Its own comment says so — the fleet
  is shared across companies, so a project's window is a real fleet commitment the
  coordinator must see to avoid double-booking a lorry. Same standing ruling as
  the drivers / helpers / lorries masters above.

**Assignment happens in two places, and they are not the same mechanism:**

| Path | What it writes | Who calls it |
|---|---|---|
| `PATCH /delivery-planning/:type/:id/schedule` (`:1705`) | schedule date, optional `deliveryState` override, and `{lorryId, driverId, tripId?, tripDate?, warehouseId?}` → **finds or creates a `scm.trips` row** for (lorry, date) and adds a `trip_stops` DELIVERY row (`:1909-1946`). `is_outsourced` derives from the lorry's `is_internal` (`:1705-1712`); trip numbers are claimed from `scm.doc_number_counters` (mig 0316) via `mintMonthlyDocNo` (`:1716-1722`) — series `TRIP-YYMM`, with NO company prefix, so it stays ONE sequence shared by both companies, and a deleted trip does not return its number. | The SHARED board's `DriverEditCell` (`DeliveryPlanningBoard.tsx:273`) and `LorryEditCell` (`:312`), and its bulk-bar `applyBulk`. Both moved out of `DeliveryPlanning.tsx` when the board was extracted. |
| `PUT /delivery-orders-mfg/:id/crew` (`delivery-orders-mfg.ts:3314`) | the full `scm.delivery_order_crew` row — driver 1/2, **helper 1/2**, lorry, plus name/IC/contact/plate snapshots — and syncs `driver_id` / `driver_name` / `vehicle` onto the DO header (`:3412-3414`). | `FleetDay.tsx`'s per-trip crew card Apply, via `useAssignDoCrew` — one call per live DO, alongside `PATCH /trips/:id`. |

Consequences worth knowing before you touch this:

- **Helper assignment lives on Last Mile Delivery, not on the board or Trips.**
  `scheduleSchema` DOES accept `helper1Id` / `helper2Id`
  (`delivery-planning.ts:2225-2226`), written to `scm.trips.helper_1_id` /
  `helper_2_id` on a trip CREATE only (`:2620-2621`). The editing surface is
  `FleetDay.tsx:502-505` — per-trip Helper 1 / Helper 2 selects applied through
  `useUpdateTrip` (`trips-queries.ts:110-132`) → `PATCH /trips/:id`, plus the DO
  crew snapshot. The delivery board and Trips still render no helper cell, and
  the mobile detail shows Driver + Helper **read-only**
  (`MobileDeliveryPlanning.tsx:1612-1613`).
- Driver / Lorry cells are **name-matched, not id-linked**: the board row
  carries `crew.driver_1_name` / `crew.lorry_plate`, and the cell preselects by
  matching that string against the master list, keeping an off-list current
  value selectable so an existing assignment never silently blanks
  (in the shared `DeliveryPlanningBoard.tsx`, not the page).
- ASSR rows are **assignable** (PR #947): picking a lorry wires the leg onto a
  real trip via `scheduleAssrOntoTrip`, so a service visit consumes fleet
  capacity like an SO/DO delivery. The stop links back to its case through
  `scm.trip_stops.assr_case_id` (mig 0166), and the board re-reads the trip's
  crew on every load (the "ASSR crew echo") so the assignment survives a
  refresh. **DP** rows still show "not applicable" for Driver / Lorry, and
  project rows are read-only mirrors — both in the shared
  `DeliveryPlanningBoard.tsx`, not in `DeliveryPlanning.tsx` (404 lines).
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

> **Resolved 2026-08-25.** The `user_id` link columns exist in production
> (hand-applied, WITH supporting indexes, both verified read-only on the live
> DB) and are now tracked by `backend/src/db/migrations-pg/0327_scm_fleet_user_link.sql`
> (idempotent `ADD COLUMN IF NOT EXISTS` — a no-op on prod, so a database built
> from this repo's migrations now has the columns too). The "internal staff →
> fleet row" sync still lives outside this repo (the 2990 full-schema import;
> see the note at `drivers.ts:9`) — that part is unchanged. All five active
> in-house drivers were confirmed linked, so `resolveDeliveryScope` returns a
> `self` scope for them today.


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
| `scm.mfg_sales_orders` | Board's primary source. `delivery_state` (the manual override cache, `0053:172`, indexed `:174`), `customer_state`, `customer_country`, `customer_delivery_date`, `amended_delivery_date` + `amend_date_from_customer` + `amend_reason` (`0053:192-194`), `processing_date`, `postcode`, `building_type`, HC context columns (`0053:178-181`) |
| `scm.delivery_orders` | `delivery_state` (`0053:173`); execution columns `time_range`, `time_confirmed`, `arrival_at`, `departure_at`, `shipout_date`, `customer_delivered_date`, `eta_arriving_port`, `delivery_substatus` (`0053:182-189`), `arrives_em_warehouse_date` (`0053:195`) |
| `scm.delivery_order_crew` | `0053:144-169`. `do_id` UNIQUE; `driver_1_id`/`driver_2_id` → `scm.drivers`, `helper_1_id`/`helper_2_id` → `scm.helpers`, `lorry_id` → `scm.lorries`, plus name/IC/contact/plate SNAPSHOTS and `assigned_at`/`assigned_by` |
| `scm.trips` | `0053:68-92`. `trip_no`, `trip_date`, `lorry_id`, `driver_id`, `helper_1_id`, `helper_2_id`, `warehouse_id`, `trip_type`, `status`, `is_outsourced`, `clock_in_at`/`clock_out_at` |
| `scm.trip_stops` | `0053:94`. Ordered stops; route metrics `leg_distance_m`, `leg_duration_s`, `eta_offset_s`, `route_optimised_at` (`0134:19-22`), `dp_no` (`0137:37`), stop type `SUPPLIER_PICKUP` (`0128`) |
| `scm.drivers` | `driver_code`, `name`, `phone`, `ic_number`, `vehicle`, `in_house` (`0053:36`), `active`; `company_id` (`0083:306-307`). Table itself predates this repo's migrations |
| `scm.helpers` | `0053:38-48`. `helper_code` UNIQUE, `name`, **`contact`** (not `phone`), `ic_number`, `in_house`, `active` |
| `scm.lorries` | `0053:50-65`. `plate` UNIQUE, `type` (`scm.lorry_type`), `is_internal`, `warehouse_id` (home warehouse = REGION), `capacity_m3`, `capacity_kg`, `active`; extended by `0121:62-86` with `model`, `purchase_*`, `road_tax_expiry`, `insurance_expiry`, `puspakom_expiry`; **WS3 (mig 0209)** with `length_ft`/`width_ft`/`height_ft` NUMERIC(6,2) — `capacity_m3` is DERIVED from them (L x W x H ft x 0.0283168) when all three are set; **WS4a (mig 0210)** with `threepl_company_id` -> `scm.threepl_companies` (NULL = own fleet) |
| `scm.threepl_companies` | `0210` (WS4a) + **`0237`**. 3PL carrier COMPANY master, tenant-scoped: `name`, `contact_name`, `contact_phone`, `is_active`, `notes`, audit + `company_id`; **0237 adds** `registration_no` (SSM), `office_phone`, `email`, `address`. UNIQUE `(company_id, name)` and partial UNIQUE `(company_id, registration_no) WHERE registration_no IS NOT NULL`. Its FLEET links back through `scm.lorries.threepl_company_id` (0210) and `scm.drivers.threepl_company_id` / `scm.helpers.threepl_company_id` (0237) — all ON DELETE SET NULL. The per-company rate card keys on this |
| `scm.drivers.threepl_company_id`, `scm.helpers.threepl_company_id` | `0237`. The crew -> carrier link, mirroring the lorry one. A row with a carrier is OUTSOURCE (`in_house = false`), enforced by the ROUTES via `scm/lib/threepl-link.ts`, not by a constraint — see below |
| `scm.lorry_maintenance`, `scm.lorry_service_records` | `0053:110-120`, `0121:99` |
| `scm.dp_orders` | `0129:30-63`. `dp_no`, `job_type` (`scm.trip_stop_type`), `party_type`, address + `postcode` + `state`, `requested_date`, `trip_id`, `status` |
| `scm.delivery_planning_regions` / `scm.state_delivery_regions` | `0053:198` / `0053:208`. The region master and the state→region map keyed on a state **name** (`state_key`) |
| `scm.delivery_residence_rules` | `0196`. Per residence / building-type delivery CONFIG the Phase-3 scheduler will read. `building_type` (keyed on the SO's `building_type` UDF values), `service_duration_minutes` (default 90; Landed seeded 60), `earliest_delivery_time` / `latest_delivery_time` (nullable), `requires_lift_booking`, `requires_registration`, `notes`, `is_active`, audit cols + `company_id`. Per-company UNIQUE `(company_id, building_type)`. Seeded for every active company (Condo / Landed / Apartment / Office / Shop / Other) — canonical config, editable in the Residence Rules admin page. |
| `scm.geocode_cache` | `0197`. Phase 3 GEOCODE CACHE: `normalized_address` (UNIQUE) → `lat`/`lng` (+ `formatted_address`, `location_type`). NOT company-scoped (an address is one point on Earth). `geocodeAddressCached` reads it before any Google call, so a given address geocodes once ever |
| `scm.trip_locations` | `0199`. Phase 4 LIVE GPS ping log — APPEND-ONLY (one row per report, never updated). `company_id` (scoped like the rest of scm), `trip_id` FK ON DELETE CASCADE, `driver_id` (the trip's driver snapshot, nullable), `user_id` (BIGINT — the public.users id of the posting phone), `lat`/`lng`, `accuracy_m`, `recorded_at` (DEVICE clock), `received_at` (SERVER clock — "last seen" is measured from here). Index `(trip_id, recorded_at DESC)` answers "latest ping for this trip" in one seek; `(company_id, recorded_at DESC)` serves the board-level read. `RE-CHECK NUMBER AT MERGE` — 0199 was the next free number above 0198 at branch time |
| `scm.delivery_zone_postcodes` | `0205` (Fleet A1). Company-editable postcode-prefix -> area-zone map. `zone` (TEXT, one of the 14 zones), `prefix_start`/`prefix_end` (SMALLINT 0-99, the first two digits of a postcode), `label`, `is_active`, audit + `company_id`. UNIQUE `(company_id, zone, prefix_start, prefix_end)`. Ships EMPTY — the DEFAULT Malaysian map is data in `backend/src/scm/lib/zone-classify.ts` (`DEFAULT_ZONE_PREFIX_MAP`), installed by `backend/scripts/seed-delivery-zones.mjs` (idempotent, DRY-RUN default); `zoneForAddress` falls back to that default until the owner customises |
| `scm.lorries` capacity cols | `0205` (Fleet A1). `max_sets` INT NULL, `max_revenue_sen` BIGINT NULL, `capacity_layer` TEXT NOT NULL DEFAULT 'SETS' CHECK (SETS\|REVENUE\|BOTH). NULL max_* => packer uses the config default; no backfill needed |
| `scm.delivery_day_locks` | `0205` (Fleet A1). A REVERSIBLE freeze on a `(company_id, warehouse_id, delivery_date)`. Presence = locked; unlock = DELETE. UNIQUE `(company_id, warehouse_id, delivery_date)` |
| `scm.delivery_legs` | `0053:123`. The removed multi-hop feature; table still present, unused |

Enums (`0053:27-33`): `delivery_state`, `lorry_type`, `delivery_leg_kind`,
`delivery_leg_source`, `trip_type`, `trip_status`, `trip_stop_type`.

Seeded state→region mapping: `0053_scm_delivery_planning_tms.sql:230-263` (the
original 6 buckets), reconciled to 5 by
`0159_scm_reconcile_delivery_regions.sql:38-82` (KL / NORTHERN / SOUTHERN /
EAST_COAST / EM; Singapore folds into Southern). A fresh environment seeded from
`0053` alone differs from production until `0159` runs — the code comment at
`delivery-planning.ts:92-97` says so too.


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
`/delivery-planning-regions` (the only one adding `{ openRead: true }`),
`/trips`, `/dp-orders`, `/lorry-capacity`, `/helpers`, `/lorries`,
`/lorry-service-records` — **plus seven more this list used to omit**:
`/delivery-residence-rules`, `/threepl-companies`, `/delivery-zones`,
`/delivery-rate-cards`, `/driver-leave`, `/delivery-messages` and
`/scan-lorry-invoice`. Sixteen mounts in total, all on the same key. There is no
per-endpoint `requirePermission` anywhere in this module.

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

Outcomes split by whether the caller is FLEET personnel (2026-08-25, owner
"只能看到分配给自己的" — `backend/src/services/positionPolicy.ts` `isFleetPosition`):
- **wildcard / non-restricted / no id / lookup error** → `mode: 'all'` (a DB
  fault must never lock a driver out mid-shift).
- **Driver / Helper with no fleet link** → **fails CLOSED**: an EMPTY `self`
  scope, which matches no assignment, so an unlinked driver sees an empty board
  rather than the whole fleet's jobs. Fixing the link is an admin action.
- **Storekeeper / Storekeeper Supervisor with no fleet link** → `mode: 'all'`:
  the board is a coordination surface for the warehouse, not a per-person run
  sheet, so they are not narrowed.
- **any caller with a resolved fleet identity** → `self` scoped to their ids.

The `scm.drivers.user_id` / `scm.helpers.user_id` link columns are tracked by
`backend/src/db/migrations-pg/0327_scm_fleet_user_link.sql` (idempotent — they
were hand-applied in production before the migration existed). An unassigned job
never matches a `self` scope (`scopeMatchesAssignment`), so it stays visible to
ops only. Pinned by `backend/tests/deliveryScope.test.ts`.

Where it is enforced:

| Site | File:line |
|---|---|
| Board read (rows filtered after assembly) | `delivery-planning.ts:418`, `:1347-1349`, helper `:317-369` |
| `PATCH /delivery-planning/:type/:id/fields` (write ownership → 403 `NOT_YOUR_JOB`) | `:1553-1566` |
| Trips list / detail / status | `trips.ts:128-131`, `:153-154`, `:292-293` |
| DP orders list + act | `dp-orders.ts:102`, `:118-125`, `:247` |

>
>

### Frontend gates

| Surface | Gate | File |
|---|---|---|
| `/scm/delivery-planning`, `/scm/trips`, `/scm/fleet-day`, `/scm/fleet-run-sheet`, `/scm/delivery-planning-regions`, `/scm/fleet`, `/scm/lorry-capacity` | `<ScmGuard area="scm.transportation.drivers">` | `App.tsx:601-605` |
| `ScmGuard` | delegates to `<Guard perm="scm.access" anyAccess={[area]}>` — an OR of the flat permission and the server's `page_access` map | `App.tsx:240-269`, `Guard` at `:183-222` |
| Sidebar entries | `anyPerm ["*","scm.access"]`, `anyAccess ["scm.transportation.drivers"]`, `hideForSalesRep: true` | `Sidebar.tsx:515-524` |
| Mobile Fleet / Drivers / Helpers / Regions rows | `gateVia: "/scm/delivery-maintenance"` — they used to borrow the gate from `/scm/fleet`, whose nav row went with the 2026-08-01 consolidation. Same permission pair, surviving path. `mobileMenuGates.test.ts` fails if a `gateVia` ever points at a dead nav entry (it would fail OPEN) | `MobileApp.tsx:318-346` |
| Mobile screens | resolved through the same nav table (`gateVia`) | `MobileApp.tsx:114`, `:157-184`, `:718` |

No `PageGuard` wraps any delivery route — `PageGuard` is for the
service-case / sales / projects family.


---

## 7. Desktop and mobile files that must change together

| Change | Desktop | Mobile | Shared / authority |
|---|---|---|---|
| The 4 states, their labels, their meaning | `vendor/scm/components/DeliveryPlanningBoard.tsx` (`STATE_TABS`, tab row) — the tabs are rendered only when the host passes `stateTabs` | `mobile/MobileDeliveryPlanning.tsx` (`Bucket` `:64`, pills) | `vendor/scm/lib/delivery-planning-queries.ts:19-29` for the constants; `derivePlanningState` (`backend/.../delivery-planning.ts:283-308`) for the RULE |
| Board row shape / new column | `vendor/scm/components/DeliveryPlanningBoard.tsx` columns (the shared grid — a new column changes Delivery Planning, Delivery Date Arrangement, Delivery Time Arrangement and Last Mile Delivery at once) | `MobileDeliveryPlanning.tsx` `BoardRow` `:79` and the job card | `PlanningOrder` type in `delivery-planning-queries.ts:47` — add the field there first |
| Region model | `DeliveryPlanningRegions.tsx` | `MobileModuleList.tsx:1957` (`delivery-planning-regions`) | `stateToRegionsFromConfig` + the two config tables |
| Driver / Helper / Lorry masters | `Fleet.tsx` (`DriversSection` `:98`, `HelpersSection` `:294`, `LorriesSection` `:461`) | `MobileModuleList.tsx:1327` / `:1357` / `:1857` | `drivers-queries.ts` / `helpers-queries.ts` / `lorries-queries.ts` |
| Assignment + scheduling | `DeliveryPlanningBoard.tsx` `DriverEditCell` / `LorryEditCell` / the bulk-bar `applyBulk` (shared grid) | read-only rows `MobileDeliveryPlanning.tsx:1612-1613` | `useScheduleDelivery` (`delivery-planning-queries.ts:397`) → `PATCH …/schedule` |
| Status writes / POD | board row actions | `MobileDeliveryPlanning.tsx` (`PATCH /delivery-orders-mfg/:id/status`), `MobilePOD.tsx` | the DO status machine in `delivery-orders-mfg.ts` |
| HC delivery fields + the disposal amendment lane | `vendor/scm/components/DeliveryFieldsDrawer.tsx` (the "Edit HC fields" drawer) | `mobile/MobileDeliveryFieldsCard.tsx` (the stop detail's "Delivery details" card) | `PATCH /delivery-planning/:type/:id/fields` for the write; `procLockActive` (`vendor/scm/lib/so-detail-gates.ts`) decides the lane and `useCreateAmendment` (`vendor/scm/lib/so-amendment-queries.ts`) is the second one. A field added to one surface is missing on the other until it is added there too — that is exactly how the four SO-context fields stayed desktop-only |
| Live GPS (Phase 4) | dispatcher READ: `LiveTripMap.tsx` in `Trips.tsx` (poll `latest`) | driver CAPTURE: `MobileTrackingBanner.tsx` (watchPosition → POST) | `vendor/scm/lib/trip-locations-queries.ts` (the ONE shared logic layer: capture engine + reads + cadence) and `backend/src/scm/lib/tripLocation.ts` (validation / rate cap / shaping) |
| Access gating | `App.tsx:601-605` + `Sidebar.tsx:515-524` | `MobileApp.tsx:114,157-184` | `scmAreaGuard('scm.transportation.drivers')` |

Note the asymmetry that is intentional and must be preserved: mobile is a
**driver run-sheet** (Today / Tomorrow / History, read-only crew), desktop is
the **planning board** (4 states, region chips, assignment). One backend, one
state machine, two presentations.

---

## Fleet Module A1 — postcode->zone, per-lorry capacity, auto-propose + lock

The daily manual dispatch fitting, automated. Three PURE, unit-tested libs do
the reasoning; the route + pages orchestrate.

- **`backend/src/scm/lib/zone-classify.ts`** — `zoneForAddress` / `zoneForPostcode`
  over the company map (or the in-code `DEFAULT_ZONE_PREFIX_MAP`). Deterministic:
  the first two postcode digits pin the zone; the NARROWEST matching prefix range
  wins (so a fine rule overrides a broad one without deleting it). 14 zones;
  `KLANG_VALLEY_ZONES` mix freely, the rest run dedicated trips. Tests:
  `zone-classify.test.ts`.
- **`backend/src/scm/lib/set-count.ts`** — `deriveSetCount(lines)` = `max(frames,
  mattresses) + sofas`; `hasFurniture=false` (accessory/service only) => the
  packer falls back to revenue. Tests: `set-count.test.ts`.
- **`backend/src/scm/lib/capacity-pack.ts`** — `packProposals` fills lorry-days
  first-ceiling-wins (SETS / REVENUE / BOTH), Klang Valley in one pool, far zones
  dedicated + a below-ceiling far lorry flagged `partial`. A single order over the
  ceiling ships alone (`overCeiling`). Deterministic, days advance from a start
  date. Tests: `capacity-pack.test.ts`.

Route `delivery-zones.ts` glues them: `/propose` loads the picked
PENDING_SCHEDULE SOs + lines + the depot's in-house lorries + the company zone
map, and returns a REVERSIBLE, display-only proposal. **Guardrails honoured:**
`derivePlanningState` untouched; no `delivery_state` added to any SO-list select;
Apply writes **`amended_delivery_date`** only (via the existing schedule path),
never `customer_delivery_date`; no lorry ASSIGNMENT here (that is A2 — Apply
writes the date only). Seams for A2/A3: the packer already emits per-lorry
groupings; A2 turns the proposed lorry-day into a real trip + nearest-neighbour
sequence (reuse `propose-route.ts`), A3 layers driver/constraint rules.

## Fleet Module A2 — stop sequencing + auto-assign lorry/driver/helper + windows

Takes a locked day's zone-packed groups (A1) and turns each into an ordered,
crewed trip. TWO new PURE, unit-tested libs do the reasoning; the A1 route +
Auto-Schedule page orchestrate. **No new schema** — assignment persists through
the existing schedule write-path onto existing `scm.trips` / `scm.trip_stops`
columns.

- **`backend/src/scm/lib/fleet-assign.ts`** — `assignFleet` greedily crews each
  packed group with a lorry + driver + helper from the depot's AVAILABLE fleet.
  A lorry Module B (fleet-status) has grounded — BREAKDOWN / COMPLIANCE_BLOCKED /
  OUT_OF_SERVICE / a maintenance window — is EXCLUDED (`dispatchable:false`) and
  surfaced in `excludedLorries`. Capacity fit (`overCeiling` when a group exceeds
  the chosen ceiling, still ships), per-DAY load balancing (spread across distinct
  lorries; the A1-preferred lorry gets first refusal), driver paired by plate
  (`drivers.vehicle`) else least-used, helper least-used, each crew member used at
  most once per day. A3 extends this same lib with driver-leave exclusion + 3PL
  overflow (see Module A3 below). Tests: `fleet-assign.test.ts`.
- **`backend/src/scm/lib/sequence-stops.ts`** — `buildSequenceProposal` shapes ONE
  trip's route by REUSING the Phase-3 nearest-neighbour sequencer
  (`propose-route.ts`) verbatim — same earliest-is-hard / service-into-clock /
  `windowViolated` rules — and adds the `eta_offset_s` / leg metrics the schedule
  path persists. Tests: `sequence-stops.test.ts`.
- **`backend/src/scm/lib/fleet-availability.ts`** — thin DB loader: the depot's
  active in-house lorries WITH their Module-B `deriveVehicleStatus` / `canDispatch`
  folded in (reuses the pure `services/fleet-status.ts` core over compliance docs,
  maintenance windows, service-due, breakdowns) + capacity ceilings + the paired
  driver. Not unit-tested (I/O); the derivation it relies on is the tested core.

Route `delivery-zones.ts` — new `POST /delivery-zones/sequence-assign` (body
`{ soDocNos[], depotWarehouseId?, startDate?, departTime?, defaultMaxSets?,
defaultMaxRevenueCenti? }`). It RE-PACKS through the SAME A1 core (`loadAndPack`,
extracted so `/propose` and this share one packing path and cannot drift), crews
each group via `assignFleet`, then sequences each assigned trip (geocode
cache-first + ONE Distance Matrix call per trip + `buildSequenceProposal`) with
residence-rule windows. Returns a DISPLAY-ONLY proposal
`{ trips[], excludedLorries[], unassigned[] }`; writes NOTHING. Google is
hard-gated on `GOOGLE_MAPS_API_KEY` — unset (or an ungeocoded depot) still returns
crewed, grouped trips, just without a computed route (the plain order is kept,
`routeReason` says why). Same area guard as the rest of TMS.

**Frontend** — since 2026-08-08 this flow lives on the **Delivery Time
Arrangement** page (`Trips.tsx`) as "Propose time (N)" — SEQUENCE half only
since the owner's final division (2026-08-08): the Time page renders the
engine's runs ANONYMISED (no lorry / crew identity; `lib/anonymous-runs.ts`)
and its Apply writes sequence + dates with no driver/helper. The CREW half —
the editable lorry / driver / helper cards ("the auto-assignment, all
overridable", crew-leave marked) — lives on **Last Mile Delivery**
(`FleetDay.tsx`, "Propose crew"): one `useSequenceAssign` call over the day,
suggestions re-attached to the day's real trips by stop overlap
(`matchCrewSuggestions`), Apply via `PATCH /trips/:id` + `PUT
/delivery-orders-mfg/:id/crew` (driver 2 + helper 2 seats included). No new
page / route.

**Schedule-path extension (additive).** `scheduleSchema` +  `scheduleOntoTrip`
(`delivery-planning.ts`) now accept optional `helper1Id` / `helper2Id`, written
onto `scm.trips.helper_1_id` / `helper_2_id` on a trip CREATE (like `driverId`).
This is the ONLY change to the schedule path — no parallel scheduler, and a
schedule that omits them behaves exactly as before. `derivePlanningState`
untouched; no `delivery_state` in any SO-list select; `amended_delivery_date`
only, never `customer_delivery_date`.

**Guardrails honoured:** reuses the established schedule path (no parallel
scheduler); unavailable (Module B) lorries excluded from assignment; everything
overridable on screen. A3 seams: driver-leave / HR availability and 3PL overflow
are NOT here — the availability half of A3 (vehicle status) is folded in; the
driver-leave half and outsourcing stay for A3.

## Fleet Module A3 — driver-leave/HR constraint + 3PL overflow assignment

The final Module-A dispatch piece. Adds the last two constraints to the SAME A2
assignment flow (`sequence-assign` + the Auto-Schedule review UI): a driver on
LEAVE is not auto-crewed that day, and when a region's own AVAILABLE fleet cannot
cover a day's demand the spill is assigned to a 3PL carrier at a captured cost.

**Migration `0206_scm_driver_leave_3pl_cost.sql`** (additive, company-scoped):
- `scm.driver_leave` (`id, company_id, driver_id → scm.drivers, start_date,
  end_date, reason, created_by, created_at`, `CHECK start_date <= end_date`). One
  row per absence — the crew member is unavailable on every date in the inclusive
  range. There is **no structured HR leave/attendance source** in this ERP (the HR
  area is commission/payout only — migs 0123/0125), so A3 owns this minimal table.
- **Migration `0208_scm_crew_leave_helpers.sql` (WS2)** widens the same table to
  helpers: adds `helper_id → scm.helpers`, drops `driver_id` NOT NULL, and a CHECK
  `(driver_id IS NOT NULL) <> (helper_id IS NOT NULL)` (exactly one per row). Table
  name unchanged; the UI relabels the page "Crew Leave". `driver-availability.ts`
  now also loads helper ranges (`isHelperOnLeave`, `helperRanges`, `excludedHelpers`)
  and `fleet-assign.ts` skips an on-leave helper the same way it skips a driver.
- `scm.trips.three_pl_cost_sen BIGINT NULL` — the CAPTURED cost of a 3PL trip
  (integer sen). NULL on an own-fleet trip. **The seam Module C's rate-card will
  compute against.** A 3PL trip already models as a trip whose `lorry_id` is an
  OUTSOURCE lorry (`scm.trips.is_outsourced` already derives from
  `lorries.is_internal` — `deriveTripOutsourced`); the only thing missing was a
  home for the cost.

**`backend/src/scm/lib/driver-availability.ts`** — the driver-leave half, to
drivers what `fleet-availability.ts` is to lorries. Pure `isDriverOnLeave(ranges,
driverId, date)` / `driversOnLeave` core + a `loadDriverLeave(sb, {from,to})` DB
loader returning the ranges + a name-resolved `excludedDrivers[]`. A missing table
degrades to "no leave" (safe direction). Tests: `driver-availability.test.ts` (8).

**`fleet-assign.ts` (A2/A3)** — `assignFleet` gains two inputs:
- `driverLeave[]` — an on-leave driver (per group DATE) is skipped in the crew
  pick; the plate-paired driver on leave falls through to a free non-leave driver.
- `config.maxTripsPerLorryPerDay` (default **1** — one full-day run) — each
  own-fleet lorry runs at most N trips/day; a group with no own-fleet SLOT left
  (every eligible lorry at cap, OR no eligible lorry at all) SPILLS to a new
  `overflow[]` bucket instead of being stacked. Overflow is the 3PL-assign
  candidate list; a 3PL trip does NOT consume an own-fleet slot. Tests updated to
  16 (was 10) — leave exclusion (3) + 3PL overflow (3) + the zero-fleet case now
  routes to overflow, not `unassigned`.

**Route `delivery-zones.ts` `sequence-assign`** — body adds
`maxTripsPerLorryPerDay?`. Loads driver leave over the packed group-date window
(`loadDriverLeave`) and passes ranges to `assignFleet`; loads the region's 3PL
carriers (active `scm.lorries` with `is_internal=false`, depot-scoped or
warehouse-null). Response adds `excludedDrivers[]`, `overflow[]`, `carriers[]`.

**Schedule-path extension (additive).** `scheduleSchema` + `scheduleOntoTrip`
now accept `threePlCostCenti?`, written to `scm.trips.three_pl_cost_sen` on a
trip CREATE — and ONLY when the lorry is outsourced (guarded by the derived
`is_outsourced`, so the seam column never carries a cost against internal
capacity). Omitted on an own-fleet schedule -> NULL, behaviour unchanged.

**`/driver-leave` route** (`driver-leave.ts`) — GET / POST / DELETE for
`scm.driver_leave`, company-scoped, same `scm.transportation.drivers` area gate.
Leave is an INTERNAL-driver concept only: POST looks the driver up and rejects an
external / 3PL driver (`scm.drivers.in_house = false`) with 422 `external_driver`
(unknown driver → 404), and the `DriverLeave.tsx` picker offers only in-house
drivers. `driver-availability.ts` is unchanged — it never sees external drivers'
leave once they cannot be recorded.

**Frontend** — the A3 pieces ride the same relocated "Propose time" flow on
`FleetDay.tsx` — Last Mile Delivery's "Propose crew" (2026-08-08 final
division; they sat briefly on `Trips.tsx` mid-restructure): an "On leave (not
auto-assigned)" line (from `excludedDrivers`) and the **3PL overflow** section — per overflow group a
carrier picker (from `carriers`) + a captured-cost (RM) input + "Assign 3PL"
that fans out `useScheduleDelivery` with `{ lorryId: carrier, threePlCostCenti,
tripDate }` (cost captured once on the trip CREATE). The "Max trips / lorry /
day" control was retired with the config row — the request omits it and the
server default (1) applies. New page **`DriverLeave.tsx`** at
`/scm/driver-leave` (nav **"Crew Leave"** under Transportation — renamed when
leave became a crew concept, not a driver one) — the leave master
(create form + table + remove). Route-manifest counts are enforced by
`routeManifestDrift.test.ts`; do not type them here.

### Leave on the MANUAL pickers (2026-08-01) — marked, never hidden

A3 above folded leave into the AUTO assigner only. The manual pickers then drifted
apart from it and from each other, which is what the owner hit on 2026-08-01 (see
`BUG-HISTORY.md`): `ScheduleTripDrawer.tsx` HID an on-leave driver, `AutoSchedule.tsx`'s
Assign trip card ignored leave entirely, and helpers were unprotected on both.

The rule now, on **every** manual crew picker:

- **Mark, do not hide.** An on-leave option reads `NAME · on leave — <reason>` and the
  picked-crew warning repeats under the select. The dispatcher can still assign them —
  a driver back early from MC must stay assignable, and it is what the Crew Leave page
  has always promised. Only the AUTO assigner refuses to crew an on-leave person.
- **Drivers and helpers are treated identically** (mig 0208 made leave a crew concept,
  not a driver one).
- **Keyed on the row's own date.** `AutoSchedule`'s proposal spans many days, so the
  marking is computed per Assign-trip card from `trip.date`, not once at page level.
- **One shared predicate.** `frontend/src/vendor/shared/crew-leave.ts` — `findCrewLeave`
  / `isCrewOnLeave` / `crewLeaveLabel`, same inclusive-range ISO-string semantics as
  `scm/lib/driver-availability.ts`, 10 unit tests. Any new crew picker uses it; do not
  re-derive the date test inline, which is how the two surfaces diverged the first time.

`GET /drivers` and `GET /helpers` still take **no date parameter** — they are the
unified fleet roster. Leave comes from `GET /driver-leave` (`useDriverLeave`) and is
applied client-side by the shared predicate.

**Guardrails honoured:** reuses the established schedule path (no parallel
scheduler); reuses OUTSOURCE lorries (no parallel carrier master); everything
overridable on screen. `derivePlanningState` untouched; no `delivery_state` in any
SO-list select; `amended_delivery_date` only, never `customer_delivery_date`; not
the FIFO/costing money-path.

## Related

- `docs/delivery-tms-stage2-backend-spec.md` — the original build spec.
- `docs/delivery-planning-jobtypes-spec.md` — "Seven job types on one fleet";
  key file index at `:162`, migration numbering at `:177`.
- `docs/MULTICOMPANY-MODULE-MAP.md:28-39` — TMS is one global cross-company
  fleet with a shared board.
- `docs/generated/route-capability-matrix.csv` — the generated gate per route.
- `docs/modules/service-case.md` — where the ASSR legs on this board come from.
- `BUG-HISTORY.md` — read the delivery entries before touching this module.
## 3PL carriers own a FLEET, in the shared masters (2026-08-01, mig 0237)

Owner's rule, in his words: register the 3PL with its particulars and its fleet,
and *"3PL 的司机、Helper 以及他的 Fleet ... 就会自动进入到我们系统的 Fleet Module 里面 ...
系统会自动将其标记为 Outsource"*.

**One set of masters, not two.** A carrier's driver, helper and lorry rows go into
`scm.drivers` / `scm.helpers` / `scm.lorries` — the same tables as our own crew and
vehicles — carrying `threepl_company_id` and flagged outsource. A parallel 3PL
fleet was considered and rejected (owner's call, 2026-08-01): `scm.lorries` has
been THE fleet master since 0053, `scm.trips.is_outsourced` already derives from
`lorries.is_internal`, and Module C prices per carrier company. Forking the fleet
would fork assignment, costing and the rate card at once. Mig 0055 already dropped
a duplicate `public.lorries` once; this module does not repeat that.

**The outsource flag is owned by the ROUTES, in one place.**
`backend/src/scm/lib/threepl-link.ts` is a pure, unit-tested pair
(`resolveCarrierLink` for PATCH, `carrierLinkForInsert` for POST) that
`drivers.ts`, `helpers.ts` and `lorries.ts` all call. The rule:

- **Attaching a carrier forces outsource**, overriding any in-house flag the
  caller sent — a form cannot make ABC Logistics' lorry ours by ticking a box.
- **Detaching (explicit `null`)** clears the link and leaves the flag alone unless
  the caller sent one — a detached row is not automatically ours again.
- **Absent** touches neither field.

It is NOT a CHECK constraint or a trigger: a cross-column CHECK would have to pin
existing rows, and a trigger would be a second writer of a field the routes
already own. The cost is that a direct SQL write can still disagree; the benefit
is one testable rule instead of three handlers restating it. Tests: `threepl-link.test.ts`.

**Leave is still not recorded for a 3PL's crew.** `POST /driver-leave` refuses an
external driver (422 `external_driver`) and that is unchanged — a carrier's
attendance is their employer's roster, not ours.

**The rate card is per carrier company, one each.** Mig 0237 adds a PARTIAL unique
index on `(company_id, carrier_company_id) WHERE carrier_company_id IS NOT NULL`,
so the New Rate Card form no longer asks for a name — pick the 3PL and the server
names the card after the company, so the two can never disagree. Own-fleet cards
(`carrier_company_id IS NULL`) are unaffected and may still be many. The Rate Cards
list is now the CARRIER list: every registered 3PL appears whether or not it has a
card, and one with no card is a one-click create. A second card for the same
carrier returns 409 `duplicate_carrier`.


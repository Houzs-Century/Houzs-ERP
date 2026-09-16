# Delivery / TMS

Transportation module: the delivery board (what needs delivering), date and time arrangement, crew/lorry assignment, trips, packing lists, live driver GPS, and the fleet masters (drivers, helpers, lorries, 3PL carriers, regions, zones, residence rules, crew leave).
Used by dispatchers/logistics on desktop and by drivers, helpers and storekeepers on the phone run-sheet. One shared fleet and one queue across both companies.

## Statuses and flow

- The board has no table: `GET /delivery-planning` unions four sources per request:
  - Sales Orders not DRAFT/CANCELLED that carry `customer_delivery_date` or `processing_date` (paged past the 1,000-row cap).
  - Service Case legs from `public.assr_cases` (open, dated): one row per set date — `customer_pickup_at`, `inspection_visit_at` when `inspection_by = 'own'`, `do_date`; key `<ASSR-NO>#<job_kind>`; always `PENDING_DELIVERY`.
  - Manual DP orders (`scm.dp_orders` with no `so_doc_no` / `assr_case_id` / `do_id`, not DELIVERED/CANCELLED).
  - PMS project setup/dismantle windows (read-only crew mirror; edit in Projects).
  - A failing non-SO union logs and leaves SO rows intact.
- `scm.delivery_state` (`derivePlanningState` in `routes/delivery-planning.ts`, shared with the `/mfg-sales-orders` list): a stored header override wins; else `DELIVERED` (status DELIVERED, or delivered > 0 and remaining <= 0); `PENDING_SCHEDULE` (ready to ship, `isShipReady`); `OVERDUE` (not ready and <= 3 days to/past the effective date); `PENDING_DELIVERY` (otherwise).
- Effective delivery date = `amended_delivery_date ?? customer_delivery_date` (`effectiveSoDelivery`, `scm/shared/effective-delivery.ts`), the same function MRP, the stock allocator and the delivery agent use.
- Counts are computed on the region-filtered set BEFORE the state filter (tabs do not move badges).
- Pipeline, four pages over one shared board (`DeliveryPlanningBoard`):
  1. Delivery Planning (`DeliveryPlanning.tsx`) — full 4-state board.
  2. Delivery Date Arrangement (`AutoSchedule.tsx`) — dates only: "Propose dates" -> day/zone proposal (no lorry shown) -> Apply writes `amended_delivery_date`.
  3. Delivery Time Arrangement (`Trips.tsx`) — sequence only: "Propose time" -> anonymous "Trip 1 / Trip 2" runs with estimated windows -> Apply stages trip + stop order + dates through the schedule PATCH, no driver/helper. Manual "Schedule (N)" drawer also here.
  4. Last Mile Delivery (`FleetDay.tsx`) — crew: "Propose crew" -> per-trip Lorry, Driver 1/2, Helper 1/2 -> Apply `PATCH /trips/:id` + `PUT /delivery-orders-mfg/:id/crew` per live DO; 3PL overflow; day map; packing lists; run-sheet print (`FleetRunSheet.tsx`).
- Arrangement stage (`deriveArrangementStage`, `lib/arrangement-stage.ts`), only inside `PENDING_SCHEDULE`: `PENDING_DATE` (no amended date, not on a live trip), `PENDING_TIME` (date set, no live trip stop), `TIME_ARRANGED` (a DELIVERY `trip_stops` row on one of the SO's DOs whose trip is not CANCELLED; on-trip dominates a missing date). Server stamps `arrangement_stage`, `trip_id/no/date`, `trip_stop_no`, `trip_eta_offset_s`.
- A DP job sits in `PENDING_SCHEDULE` until scheduled, then `PENDING_DELIVERY`; ASSR and project rows stamp stage null.
- `scm.trip_status`: `PLANNED | IN_PROGRESS | COMPLETED | CANCELLED`. A trip = one lorry + one date; number `TRIP-YYMM-NNN`, one cross-company sequence (counter-claimed, never reused).
- Trips -> board reverse sync (`lib/tripReconcile.ts`): `DELETE /trips/:id/stops/:stopId`, `DELETE /trips/:id` (soft or `?hard=true`) and `PATCH /trips/:id/status` -> CANCELLED clear the `delivery_state` override on the stop's DO and parent SO.
- Phone run-sheet (`MobileDeliveryPlanning.tsx`): Today / Tomorrow / History by effective date; Start -> DO `IN_TRANSIT`; Mark arrived PATCHes the DO's `arrivalAt`; Complete opens `MobilePOD.tsx` (photo, signature, GPS) which sets `DELIVERED`. A stop with no DO offers "Create DO" to a user who may operate DOs, else tells them to ask Office.
- Packing list = a trip; scanning its QR advances every DO on the run (see Rules).

## Permissions

- Area `scm.transportation.drivers` gates all TMS mounts: `/drivers`, `/helpers`, `/lorries`, `/lorry-service-records`, `/lorry-capacity`, `/delivery-planning`, `/delivery-planning-regions` (openRead), `/delivery-residence-rules`, `/delivery-zones`, `/delivery-rate-cards`, `/threepl-companies`, `/driver-leave`, `/trips`, `/dp-orders`, `/delivery-messages`, `/scan-lorry-invoice`. GET = `view`, POST/PATCH/PUT/DELETE = `edit` (proposals are POSTs, so they need `edit`).
- Enforced per level only for `scm_l2_configured` users; others pass on `scm.access`; `*` bypasses. No per-endpoint `requirePermission` in this module.
- Frontend: TMS routes wrapped in `<ScmGuard area="scm.transportation.drivers">`; sidebar entries `hideForSalesRep`; phone Fleet/Drivers/Helpers/Regions rows `gateVia: "/scm/delivery-maintenance"` (must point at a live nav entry, pinned by `mobileMenuGates.test.ts`).
- Row scope `resolveDeliveryScope` (`lib/deliveryScope.ts`): a restricted-cohort user (Driver, Helper, Storekeeper, Storekeeper Supervisor per `positionPolicy.ts`) with a linked `scm.drivers`/`scm.helpers.user_id` sees only jobs assigned to them.
  - Driver/Helper with no fleet link fails CLOSED (empty board); Storekeepers with no link see all; a lookup error fails OPEN (all).
  - Enforced on the board read, `PATCH .../fields` (403 "You can only update a delivery job assigned to you."), trips list/detail/status, DP orders list/act.
  - The schedule PATCH is deliberately NOT row-scoped (one dispatcher schedules the whole operation).
- Phone Start / Arrived / POD open for `canOperateDeliveryOrders` OR a driver (`canDriverCompleteDelivery`, `scm.do.dispatch`; the server checks the DO is their own dispatched job). "Create DO" at a stop is `canOperateDeliveryOrders` only.
- Public QR scan needs no login: the token is the credential; routes are IP rate-limited.
- `GET /api/fleet/staff` (`users.read`, public roles Driver/Helper/Storekeeper) is a different crew concept feeding Projects pickers, not the SCM fleet.

## Rules that must not break

Dates and state
- Scheduling writes `amended_delivery_date`, never `customer_delivery_date`; the customer's original date is never overwritten.
- Never add `delivery_state` to a shared SO-list select (view trap); never re-derive planning state or arrangement stage on the client — read the stamped fields.
- `processing_date` means the SO's Processing Date; synthetic rows carry their leg date in it, so the "Processing Date" column renders on `so` rows only.

Region and zone
- Region comes from `customer_state` (fallback `customer_country`), normalised (`normState`), mapped via `scm.delivery_planning_regions` + `scm.state_delivery_regions`; unmapped -> KL if configured else first active; empty config -> fallback KL/SEL, Northern, Southern, East Coast, EM. Same function for all four row types. Postcode never decides region.
- Zone is separate: first two postcode digits -> one of 14 zones via `scm.delivery_zone_postcodes`, narrowest range wins, falling back to `DEFAULT_ZONE_PREFIX_MAP` (`lib/zone-classify.ts`).

Scheduling and trips
- ONE write path: `PATCH /delivery-planning/:type/:id/schedule` (`so | do | assr`) -> `scheduleOntoTrip` / `scheduleAssrOntoTrip` find-or-create the (lorry, date) trip and add a DELIVERY stop, optionally with `stopNo` / `etaOffsetS` / leg metrics. No parallel scheduler.
- One job = one stop: rescheduling deletes that job's stops on every other trip (SO/DO keyed on `do_id`/`so_id` via `staleStopSweepFor`, which refuses without a uuid; ASSR keyed on `assr_case_id`); a failed sweep is returned in `tripWiring.failed`, never silent.
- An SO with no DO gets a trip but NO stop (no uuid), so it cannot reach Time arranged; the response says so (`stopCreated: false`, `stopSkippedReason`). Cut the DO first; never invent a key.
- `is_outsourced` derives from the lorry's `is_internal`; `three_pl_cost_sen` is written only when creating an outsourced trip; helpers (`helper1Id/2Id`) only on trip create.
- Every `trips` / `trip_stops` read and write carries `scopeToAllowedCompanies` (shared queue = wider predicate, never none).
- Fleet masters (drivers, helpers, lorries) are deliberately not company-scoped; `company_id` there is a created-by stamp.
- Board Driver/Lorry cells are name-matched against the masters and keep an off-list current value selectable; DP rows show n/a; project crew is read-only; ASSR legs are assignable.
- `PUT /delivery-orders-mfg/:id/crew` is the only writer of `scm.delivery_order_crew` (driver 1/2, helper 1/2, lorry + snapshots) and syncs driver/vehicle onto the DO header.
- Service Case rows and the ASSR schedule write use `assrCompanySql` through `lib/assr-board-scope.ts` (never a local copy); an out-of-scope or closed/archived case is 404 and mints no trip. PMS project rows stay company-blind on purpose (shared fleet).
- Reverse reconcile: clears only headers that carry an override, clears the SO through `advanceSoGeneration` (stands down and reports on a lease/version conflict), keys on `do_id` only, leaves `amended_delivery_date` alone, and reports failure as `reconcile: { failed, reason }`.

Proposals (all display-only; Apply always goes through the schedule PATCH)
- `POST /delivery-zones/propose`, `/delivery-zones/sequence-assign`, `/trips/propose-schedule`, `/trips/:id/optimize-route` write nothing.
- Packing (`lib/capacity-pack.ts`, `set-count.ts`): sets = max(frames, mattresses) + sofas; accessory-only orders pack by revenue; per-lorry `max_sets` / `max_revenue_sen` / `capacity_layer`, else defaults 10 sets / RM30,000; Klang Valley zones pool, far zones run dedicated. `/propose` and `/sequence-assign` share `loadAndPack`.
- Auto crew (`lib/fleet-assign.ts`): excludes non-dispatchable lorries (fleet status), on-leave drivers and helpers; each crew member once per day; `maxTripsPerLorryPerDay` default 1; unfit groups spill to 3PL `overflow[]`.
- Sequencing (`lib/propose-route.ts`, `sequence-stops.ts`): earliest window is HARD (lorry waits), service minutes from `scm.delivery_residence_rules` by `building_type` (default 90, no window), a missed latest is flagged `windowViolated`, never hidden.
- Time page (`vendor/scm/lib/propose-time.ts`): one sequence-assign call per confirmed date (amended date, else live trip date; dateless orders skipped), depot = majority warehouse; every proposed stop stays on its confirmed date — overflow is listed for 3PL, never re-dated. Runs are anonymised (`anonymous-runs.ts`); estimated window = arrival -> finish + 15 min unload buffer.
- Last Mile: crew suggestions re-attach to the day's real trips by stop overlap (`lib/last-mile.ts` `matchCrewSuggestions`), never to a run that does not exist.
- Google: server `GOOGLE_MAPS_API_KEY` unset -> `{ configured: false }`, no Google call; geocoding is cache-first in `scm.geocode_cache` (not company-scoped); Distance Matrix only on an explicit propose click; ungeocoded stops are listed, never dropped. Browser `VITE_GOOGLE_MAPS_API_KEY` unset -> a note, everything else works.
- Day locks `scm.delivery_day_locks` per (company, warehouse, date): POST idempotent, DELETE unlocks.

Crew leave and 3PL
- `scm.driver_leave` rows name exactly one of driver/helper; an external/3PL driver is refused 422 `external_driver`.
- Only the AUTO assigner refuses on-leave crew; every manual picker MARKS (`NAME · on leave — reason`) and still allows the pick. Use the one predicate `frontend/src/vendor/shared/crew-leave.ts`; `GET /drivers` / `/helpers` take no date.
- A carrier's lorries/drivers/helpers live in the shared masters with `threepl_company_id`. Link rule in `lib/threepl-link.ts` (used by drivers/helpers/lorries routes): attaching forces outsource; explicit null detaches and keeps the flag unless one is sent; absent touches neither.
- 3PL company: unique name and SSM per company (409 `duplicate_name` / `duplicate_registration`); DELETE detaches its fleet, never deletes it. One rate card per carrier (409 `duplicate_carrier`).
- Lorry `lengthFt/widthFt/heightFt` all supplied -> `capacity_m3` re-derived.

HC delivery fields (`PATCH /delivery-planning/:type/:id/fields`)
- SO-context fields (possession date, house type, referral, replacement/disposal) write the SO header and need no DO; DO-execution fields (time range/confirmed, arrival, departure, shipout, customer-delivered date, port ETA, sub-status) write the latest DO and return `no_do_hint` when there is none.
- A genuine `replacementDisposal` change on a processing- or PO-locked SO -> 409 `so_locked_processing`. Both surfaces detect the lock with `procLockActive` (needs server-computed `po_locked` on the row) and send it as a header-only SO amendment (`useCreateAmendment`), warning as soon as the order is locked.
- Mobile sends a changed-only diff from `buildDeliveryFieldsPatch`; desktop posts the whole form.

Live GPS
- `POST /trips/:id/location`: own IN_PROGRESS trip only, range-validated, pings < 10 s apart ignored, bad pings rejected cleanly. `scm.trip_locations` is append-only.
- Browser capture posts ~25 s and stops when the trip ends or the page is hidden; the native app uses background location (distance filter) through the same endpoint. `simulated` fixes are recorded, never refused.
- Dispatcher map polls `/trips/:id/locations/latest` every 15 s; stale after 90 s. No websockets.

Packing lists and the run QR
- No `packing_lists` table — a packing list IS a trip row (it has `company_id` and `qr_token`).
- `GET /trips/packing?date=&warehouseId=`: one list per trip; every read scoped to allowed companies (`trip_stops` through its trips); ids chunked.
- Sheet order is the REVERSE of delivery order (`loadingOrder` in `vendor/scm/lib/packing-list-model.ts`), numbered by loading order only; copy is English; letterhead from `pdf-common.ts`.
- Status rollup: LOADED = Confirmed, DISPATCHED = Loaded, IN_TRANSIT = In Transit, SIGNED/DELIVERED/INVOICED = Delivered; no readable DO -> dash, never "0/0". Rack prints per DO line, not per piece.
- QR encodes `/d/<token>` (10-char base32; legacy 64-hex still resolves), minted lazily by `GET /api/scm/trips/:id/scan-token`, opened by `frontend/src/pages/PublicDoScan.tsx`.
- `POST /api/public/do-scan/:token/advance` on a trip token: stop order, strictly sequential, one refusal never aborts the rest, per-drop outcome `DONE | ALREADY_DONE | BLOCKED | FAILED` under `DONE | PARTIAL | NOTHING`, a re-scan never advances past the current rung.
- A drop on another company's books is `BLOCKED` and named by stop number only; all writes are scoped to the trip's company.

Desktop / mobile parity
- Intentional asymmetry: phone = driver run-sheet (day buckets, read-only crew, full board fetched as `?region=ALL&state=ALL`); desktop = planning board.
- Change together: state labels (`DeliveryPlanningBoard` `STATE_TABS` <-> `MobileDeliveryPlanning` `Bucket`; constants in `delivery-planning-queries.ts`); row fields (add to `PlanningOrder` first, then phone `BoardRow`); masters (`Fleet.tsx` <-> `MobileModuleList` configs); HC fields (`DeliveryFieldsDrawer.tsx` <-> `MobileDeliveryFieldsCard.tsx`); GPS (`LiveTripMap.tsx` <-> `MobileTrackingBanner.tsx`, shared `trip-locations-queries.ts` + backend `lib/tripLocation.ts`); status/POD (board <-> `MobileDeliveryPlanning` / `MobilePOD`).
- The board component is shared by four pages; a new column changes all four.

Board UI
- Option B map (`DeliveryMapPanel.tsx`, model `delivery-map-model.ts`): open/closed per page; compact columns are a render-time overlay (`visibleColumnsOverride` -> `overlayHidden`), never written to `layout.hidden`; any explicit column choice turns compact off. Geo read (`useDeliveryGeo` -> `GET /delivery-planning/geo`) is disabled while the panel is closed.
- Arrangement queues default-sort with `arrangementQueueCompare` only while no column sort is active; the main board keeps server order.
- Grid funnels are in-visit only (module memory in `dataGridFilterStorage`): kept across route changes, clean on a fresh page load / F5, never localStorage. Board state/region via `useStickyFilters` (URL wins).

## Gotchas

- Do not re-add `/scm/drivers`; `Drivers.tsx` is kept on disk only — the fleet lives in `/scm/fleet` / Coverage & Fleet.
- "No packing-list table" does not mean "no identity": the trip row is the packing list (this once skipped the public scan).
- Do not "fix" the SO-without-DO schedule by inventing a stop key; the orphan trip it leaves still counts in `/lorry-capacity`.
- A stop for the same document added by hand to a second trip is removed by the next board schedule — by design.
- No Trips UI calls cancel / remove-stop yet; when adding one, invalidate `['delivery-planning']`. Trip cancel does not clear a Service Case's date; a cancelled trip's `dp_no` still shows on the board.
- Raw `c.env.DB` SQL cannot use `scopeToAllowedCompanies`; keep the ASSR company predicate in `assr-board-scope.ts`.
- Never re-derive the leave date test inline; two pickers diverged that way.
- Do not invent fields the board feed lacks on the phone job card (emergency contact, move type, floor plan); service/project card variants have no backend source.
- A driver whose `user_id` link is missing sees an empty board — fix the fleet link (admin), do not widen the scope.
- The board has no server pagination or date bound (filters run in memory); `dp_orders` is capped at 1,000; the phone pays for the whole board.
- A vector map `mapId` ignores inline declutter styles; the panel relies on classic raster.
- `MobileDeliveryPlanning.tsx` sits at its file-size ceiling; put new card code in its own file (as `MobileDeliveryFieldsCard.tsx`).
- On a mixed-company run the scan moves only the trip company's drops; the other company's DOs need their own scans.

## Where the code is

Backend
- Routes: `backend/src/scm/routes/delivery-planning.ts` (board, geo, lines, fields, schedule), `trips.ts`, `trip-scan-token.ts`, `dp-orders.ts`, `delivery-zones.ts`, `delivery-planning-regions.ts`, `delivery-residence-rules.ts`, `drivers.ts`, `helpers.ts`, `lorries.ts`, `threepl-companies.ts`, `driver-leave.ts`, `lorry-capacity.ts`, `lorry-service-records.ts`, `delivery-rate-cards.ts`; `backend/src/routes/publicDoScan.ts`; mounts in `backend/src/scm/index.ts`.
- Libs: `backend/src/scm/lib/arrangement-stage.ts`, `tripReconcile.ts`, `deliveryScope.ts`, `assr-board-scope.ts`, `packing-list-view.ts`, `do-scan-token.ts`, `tripLocation.ts`, `zone-classify.ts`, `set-count.ts`, `capacity-pack.ts`, `fleet-assign.ts`, `fleet-availability.ts`, `driver-availability.ts`, `sequence-stops.ts`, `propose-route.ts`, `geocode.ts`, `fleet-day-view.ts`, `threepl-link.ts`, `planning-po-nos.ts`; `backend/src/scm/shared/effective-delivery.ts`; `backend/src/services/positionPolicy.ts`.
- Migrations: `backend/src/db/migrations-pg/0053_scm_delivery_planning_tms.sql` (base), `0159`, `0196`, `0197`, `0199`, `0205`, `0206`, `0208`, `0209`, `0210`, `0237`, `0253`, `0327_scm_fleet_user_link.sql`, `0329_scm_trip_public_scan_token.sql`.

Frontend
- Pages: `frontend/src/pages/scm-v2/DeliveryPlanning.tsx`, `AutoSchedule.tsx`, `Trips.tsx`, `FleetDay.tsx`, `FleetRunSheet.tsx`, `DpOrders.tsx`, `Fleet.tsx`, `DeliveryMaintenance.tsx`, `DeliveryPlanningRegions.tsx`, `DeliveryResidenceRules.tsx`, `DeliveryZones.tsx`, `DriverLeave.tsx`, `ThreePLCompanies.tsx`, `LorryCapacity.tsx`, `delivery-propose-ui.tsx`; `frontend/src/pages/PublicDoScan.tsx`.
- Components: `frontend/src/vendor/scm/components/DeliveryPlanningBoard.tsx`, `ScheduleTripDrawer.tsx`, `ScheduleRouteMap.tsx`, `DeliveryFieldsDrawer.tsx`, `NewDpOrderDrawer.tsx`, `ScheduleDpOrderDrawer.tsx`, `PackingListsSection.tsx`, `LiveTripMap.tsx`; `frontend/src/components/scm-v2/DeliveryMapPanel.tsx`.
- Logic: `frontend/src/vendor/scm/lib/delivery-planning-queries.ts`, `trips-queries.ts`, `trip-locations-queries.ts`, `native-location.ts`, `propose-time.ts`, `propose-days.ts`, `anonymous-runs.ts`, `last-mile.ts`, `arrangement-sort.ts`, `delivery-map-model.ts`, `delivery-geo-queries.ts`, `packing-list-model.ts`, `packing-list-pdf.ts`, `packing-scan-token-arm.ts`, `so-detail-gates.ts`; `frontend/src/vendor/shared/crew-leave.ts`.
- Mobile: `frontend/src/mobile/MobileDeliveryPlanning.tsx`, `MobileDeliveryFieldsCard.tsx`, `MobilePOD.tsx`, `MobileTrackingBanner.tsx`, `MobileModuleList.tsx`, `MobileApp.tsx`.

Endpoints: see `docs/generated/route-capability-matrix.csv`.

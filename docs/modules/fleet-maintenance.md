# Module: Fleet Maintenance & Compliance (Phase 1 + Phase 2 + Phase 3)

The lorry compliance + service-readiness system. It **builds ON the existing SCM
fleet foundation** — `scm.lorries` is THE vehicle master. Status is *derived*,
never typed.

> **Phase 1 scope.** The compliance vault (with reminders), the Fleet Health
> dashboard, and the derived-status state machine — all over the lorries that
> already exist. (§1–§7.)
>
> **Phase 2 scope (§9).** Per-component **preventive-maintenance plans**
> (`scm.lorry_maintenance_plans`) and daily **mileage capture**
> (`scm.lorry_mileage_readings`). Plans feed `deriveVehicleStatus()` →
> `SERVICE_DUE`; the latest mileage reading is the odometer the plans measure
> against.
>
> **Phase 3 scope (§10).** **Breakdown cases** (`scm.lorry_breakdown_cases`),
> **maintenance work orders** (`scm.lorry_work_orders` + `_work_order_parts`) with
> a state machine, and the **tyre/component SERIAL lifecycle**
> (`scm.lorry_components` + `_component_events`). These FEED the two status seams
> Phase 1 carried (`breakdownActive` + `openWorkOrder`) for real, and feed the
> real repair-spend / active-breakdown / downtime KPIs.

## 1. What it reuses (does NOT duplicate)

| Existing table | Role in Fleet Maintenance |
|---|---|
| `scm.lorries` (mig 0053, +0121) | THE vehicle master — plate, type, warehouse_id, active, model, and the flat `road_tax_expiry` / `insurance_expiry` / `puspakom_expiry` columns kept as the denormalized "current" value. Referenced by `scm.trips.lorry_id` + `scm.delivery_order_crew.lorry_id`, so Compliance-Blocked actually means dispatch can't use it. |
| `scm.lorry_maintenance` (mig 0053) | Out-of-service **windows** (`unavailable_from/to`). A lorry inside a current window derives `OUT_OF_SERVICE`. |
| `scm.lorry_service_records` (mig 0121) | Latest row → current mileage (`odometer_km`) + next service (`next_service_km`/`date`), and `cost_centi` → the this-month repair-spend + costliest-vehicle KPIs. |
| `scm.drivers` | People — `drivers.vehicle` holds the plate, joined to show the assigned driver. |
| `scm.warehouses` | Region/dispatch origin (warehouse `code`, e.g. KL/PG). |

`mig 0055` already dropped a duplicate `public.lorries` once — this module does
NOT create a parallel master.

## 2. The one new table (migration `0202_scm_lorry_compliance_vault.sql`)

> ⚠️ Migration number is a **placeholder** — `0200/0201` were taken by parallel
> branches; re-check and renumber to highest-on-main + 1 at MERGE (file header).

### `scm.lorry_compliance_documents` — the compliance vault
One row per issued/renewed document across **PUSPAKOM / ROAD_TAX / INSURANCE /
APAD / CROSS_BORDER**, each with document ref, issue + expiry dates, cost, owner,
and (PUSPAKOM) PASS/FAIL result + reinspection deadline. `lorry_id` FK →
`scm.lorries(id)` ON DELETE CASCADE. **Append-only**: renewing INSERTs a new row;
the current document per `(lorry, doc_type)` is the latest-expiring row.

**Company scope matches `scm.lorry_service_records`**, NOT a hard scope: the
fleet is unified across companies (`scm.lorries` has no `company_id`), so
`company_id` here is stamped on insert but never used to scope reads.

**Denormalization sync.** For ROAD_TAX / INSURANCE / PUSPAKOM the append route
updates the matching flat column on `scm.lorries` to the latest vault expiry, so
the existing Fleet compliance strip keeps working. APAD / CROSS_BORDER are
vault-only (no flat column). Where a lorry has no vault row yet, the dashboard
falls back to the flat column as the "current" value — existing lorries work
before any vault data is entered.

Seed data does NOT live in the migration — `backend/scripts/seed-fleet-
maintenance.mjs` matches lorries by plate and backfills vault rows (idempotent,
DRY-RUN by default; `CREATE_MISSING=1` mints absent lorries for empty local
envs only — never in prod, where duplicating a plate is forbidden).

## 3. Backend routes (`/api/fleet-maintenance`, `backend/src/scm/routes/fleet-maintenance.ts`)

Mounted at TOP LEVEL (outside `/api/scm`) so the gate is the flat `fleet.read` /
`fleet.write` permission ALONE (via `requireHouzsPerm`), not the coarse
`scm.access`. Uses the SCM supabase client (`supabaseAuth`), like the sibling
lorry routes.

| Route | Gate | What |
|---|---|---|
| `GET /dashboard` | `fleet.read` | All lorries + current compliance per type (vault-latest, else flat column) + derived status + KPI ribbon (incl. real this-month repair spend + costliest vehicle from service records). |
| `GET /vehicles/:id` | `fleet.read` | One lorry + full vault history per type + maintenance windows + latest service record. |
| `GET /reminders` | `fleet.read` | Fleet-wide actionable expiries, most urgent first (the seam a future notification job calls). |
| `POST /vehicles/:id/compliance` | `fleet.write` | **Append** a compliance document (renewal) + sync the flat column. |

The write surface is deliberately small: creating/editing a lorry stays in the
existing `/api/scm/lorries` route, mileage/next-service in `/api/scm/lorry-
service-records`, out-of-service windows in `scm.lorry_maintenance`. Fleet
Maintenance only OWNS the vault.

## 4. The derived-status state machine (`backend/src/services/fleet-status.ts`)

Pure, env-free, unit-tested (`backend/tests/fleetStatus.test.ts`). Two concerns:

- **`reminderLevel(daysRemaining)`** — `EXPIRED (<0) → ESCALATE (≤7, owns 7/3/1)
  → RED (≤14) → NOTIFY (≤30) → AMBER (≤45) → PREPARE (≤60) → OK`.
- **`deriveVehicleStatus(input)`** — precedence, highest wins: `OUT_OF_SERVICE`
  (a current `scm.lorry_maintenance` window) → `COMPLIANCE_BLOCKED` (expired doc
  / failed PUSPAKOM) → `BREAKDOWN` (seam) → `WAITING_PARTS` (seam) →
  `PLANNED_MAINTENANCE` (seam) → `SERVICE_DUE` (mileage/date vs the latest
  service record's next-service target) → `AVAILABLE`.

In Phase 1 only `AVAILABLE / SERVICE_DUE / COMPLIANCE_BLOCKED / OUT_OF_SERVICE`
are reachable — the three seam states are wired but their inputs (work orders /
breakdown cases) are not supplied yet (§6).

## 5. Rules that will bite you

- **Renewals are new rows.** Never `UPDATE` a vault row's expiry to renew.
- **A failed PUSPAKOM grounds the lorry** independent of the printed expiry until
  a fresh `PASS` row is appended.
- **Status is never stored.** Do not add a `status` column to `scm.lorries`.
- **The flat expiry columns are a cache.** The vault is the system of record for
  ROAD_TAX/INSURANCE/PUSPAKOM; the append route keeps the flat columns in sync.
  Do not write the flat columns directly for these types outside that route, or
  the cache and the vault will disagree.
- **Unified fleet.** `scm.lorries` and the vault are NOT company-scoped on read
  (a lorry's compliance is visible wherever the lorry is).

## 6. Status seams (Phase 3 now feeds them)

`deriveVehicleStatus()` accepts `openWorkOrder` + `breakdownActive`. As of Phase 3
(§10) these are supplied for real:

- `scm.lorry_work_orders` (open, `IN_REPAIR`/`WAITING_PARTS`) → `PLANNED_MAINTENANCE`
  / `WAITING_PARTS`, plus the "Open problem" / "Downtime" board columns.
- `scm.lorry_breakdown_cases` (CRITICAL, non-resolved) → `BREAKDOWN` + downtime.
- Preventive-maintenance plans (Phase 2) → `SERVICE_DUE`; mileage trip-capture GPS
  cross-check is Phase 4.
- **Notifications**: `GET /reminders` is the computation a future scheduled job
  rides onto the app's existing announcement/notification mechanism; a critical
  breakdown ALSO posts a private announcement to the reporter's reporting line
  (`postPersonalNotice`, `source='fleet_breakdown'`). No new push channel.

## 7. Frontend (`frontend/src/pages/FleetHealth.tsx`, `/fleet-health`)

Gated `Guard perm="fleet.read"`; nav entry in `Sidebar.tsx` (operations,
`Wrench`). Reuses the app's own design system (`StatCard`,
`ResizableDetailDrawer`, `PageHeader`, tone pills) — not the mockup's dark theme.
Region + status filters are URL state; region options are derived from the
warehouses actually present. Registered in `routing/routeManifest.ts` so the
mobile shell resolves it to a desktop-only dead-end (no mobile screen in Phase 1).

## 9. Phase 2 — preventive plans + mileage capture

### 9.1 New tables (migration `0203_scm_lorry_plans_mileage.sql`)

> ⚠️ Migration number is a **placeholder** — re-check and renumber to
> highest-on-main + 1 at MERGE (header carries `RE-CHECK NUMBER AT MERGE`).

**`scm.lorry_maintenance_plans` — one plan per COMPONENT per lorry.** Child of
`scm.lorries(id)` ON DELETE CASCADE, company-stamped-not-scoped like the vault.
Columns: `component` (CHECK against the twelve components — engine oil, oil +
filter, gearbox oil, brake inspection, brake pads, tyres, battery, alignment,
air-con, suspension, cooling system, PUSPAKOM prep), `interval_km`,
`interval_months` (at least one required — CHECK), `last_done_date`,
`last_done_km`, `workshop`, `est_cost_centi`, `notes`, `active`. A UNIQUE index
on `(lorry_id, component)` enforces the one-per-component rule; the write route
UPSERTs on that pair. **`next_due_km` / `next_due_date` are DERIVED, never
stored** (`last_done_km + interval_km` ; `last_done_date + interval_months`), so
they cannot drift from the inputs.

**`scm.lorry_mileage_readings` — the daily odometer capture.** Child of
`scm.lorries(id)`. Columns: `reading_date`, `odometer_km` (CHECK ≥ 0), `source`
(`DAY_COMPLETE` | `MANUAL` | `SERVICE`), `photo_ref` (R2 key of the dashboard
photo, nullable), `flagged` (set when the abnormal-jump guard tripped), `note`,
`entered_by`. A partial UNIQUE index on `(lorry_id, reading_date) WHERE source =
'DAY_COMPLETE'` enforces **one day-complete reading per lorry per day**;
MANUAL/SERVICE corrections are unconstrained.

Seed data is NOT in the migration — `backend/scripts/seed-fleet-plans.mjs`
inserts a sensible DEFAULT plan set per lorry (idempotent: only lorries with
zero plans; DRY-RUN default, `APPLY=1` writes, `SEED_LAST_DONE=1` seeds demo
last-done so due-bars show live on a local env).

### 9.2 Due derivation (`services/fleet-status.ts`, unit-tested)

- **`derivePlanDue(plan, currentKm, today)`** — a plan is due on **whichever
  comes first, km OR months**. `overdue` = past the target on either axis;
  `dueSoon` = within `SERVICE_DUE_KM_THRESHOLD` (1000 km) or
  `SERVICE_DUE_DAYS_THRESHOLD` (14 days) on either axis (so it is also true once
  overdue). `tone` = crit (overdue) / warn (due soon) / ok.
- **`addMonths()`** clamps to the target month's length (Jan 31 + 1 mo → Feb 28).
- **`deriveVehicleStatus()`** now takes `plans` and returns `SERVICE_DUE` when
  `anyPlanDue(...)` is true — alongside the legacy next-service-record path
  (both still work). Compliance-blocked / out-of-service still outrank it.

### 9.3 Mileage rules (`assessMileageReading()`, unit-tested)

- A reading **below** the latest odometer is a **ROLLBACK — rejected** (the
  write route returns `409 odometer_rollback`).
- An **abnormal one-day jump** (> `ABNORMAL_JUMP_KM_PER_DAY` × the day-gap,
  default 1500/day) is **accepted but `flagged`** for review — never silently
  taken.
- GPS distance (`scm.trip_locations`, Phase 4) may be shown as a cross-check but
  is **NEVER** written as the odometer.
- The odometer the plans measure against is the **latest mileage reading**,
  falling back to the latest service record's odometer.

### 9.4 New routes (`/api/fleet-maintenance`)

| Route | Gate | What |
|---|---|---|
| `POST /vehicles/:id/plans` | `fleet.write` | Create OR update (UPSERT on lorry+component) one component's plan. |
| `PATCH /plans/:planId` | `fleet.write` | Partial edit of a plan (intervals, last-done, active, cost…). |
| `POST /vehicles/:id/mileage` | `fleet.write` | Capture a daily reading. Runs the guards: rollback → 409; abnormal jump → 201 + `flagged`. |

`GET /dashboard` and `GET /vehicles/:id` now also return plan due-pictures +
latest mileage: the dashboard adds `serviceOverdue` to the KPIs and a `nextPlan`
+ `plansOverdue`/`plansDueSoon` per vehicle; the detail adds `plans[]` (with
derived due) + `mileage[]` (recent readings).

### 9.5 Frontend touch points

- **Desktop** `frontend/src/pages/FleetHealth.tsx` — the board's "Next service"
  column is the most-urgent plan (per component); the "Service due" KPI shows an
  overdue count; the detail drawer gains a **Preventive maintenance** section
  (per-component due-bars) and a **Mileage** section (recent readings, flagged).
- **Mobile** `frontend/src/mobile/MobileMileageCapture.tsx` — the driver's
  **mark day complete + odometer + photo** flow. Mounted for `/fleet-health` on
  a phone (desktop mounts the admin dashboard at the same URL); menu row "Fleet
  Mileage" in the Logistics group, gated on the `/fleet-health` nav entry
  (`fleet.read`). Uploads the photo to R2 (shared slip pipeline) then POSTs the
  reading. Plans admin stays desktop-only.

## 10. Phase 3 — breakdown cases, work orders, tyre/component lifecycle

### 10.1 New tables (migration `0204_scm_lorry_workorders_breakdowns_components.sql`)

> ⚠️ Migration number is a **placeholder** — header carries `RE-CHECK NUMBER AT
> MERGE`. At branch time main was at 0203; re-list the tree at merge and renumber
> to highest-on-main + 1 if 0204 was taken. All five tables are children of
> `scm.lorries` ON DELETE CASCADE, company-stamped-not-scoped like the Phase-1/2
> siblings. Money is BIGINT `*_centi`.

**`scm.lorry_breakdown_cases`** — a breakdown / roadside-incident log. Columns:
`occurred_at`, `gps_lat`/`gps_lng`, `fault_type`, `severity`
(`MINOR`|`MAJOR`|`CRITICAL`), `still_drivable`, `media_refs` (JSONB R2 keys),
`driver_description`, `towing_company`, `towing_cost_centi`, `workshop`,
`breakdown_start`, `recovery_time`, `affected_trip_id` (nullable FK
`scm.trips` ON DELETE SET NULL), `status` (`OPEN`|`TOWING`|`IN_WORKSHOP`|
`RESOLVED`). **A CRITICAL, non-RESOLVED case grounds the lorry** — it feeds
`breakdownActive` → `deriveVehicleStatus()` returns `BREAKDOWN` →
`canDispatch()` is false. This reuses the **established derived-status seam**; it
does NOT write a parallel `scm.lorry_maintenance` window and does NOT add a
status column (`BREAKDOWN` is more specific than `OUT_OF_SERVICE`, so the case
must NOT also open an OOS window or the machine would report `OUT_OF_SERVICE`).

**`scm.lorry_work_orders`** — the maintenance work order. State machine
(`status` CHECK): `REPORTED → DIAGNOSED → APPROVED → IN_REPAIR → WAITING_PARTS →
COMPLETED → VERIFIED`, with the `IN_REPAIR ⇄ WAITING_PARTS` loop and
`WAITING_PARTS → COMPLETED`. An OPEN WO in `IN_REPAIR` feeds
`PLANNED_MAINTENANCE`; in `WAITING_PARTS` feeds `WAITING_PARTS` (COMPLETED /
VERIFIED are closed and feed nothing). Money legs `labour_centi`,
`outside_service_centi`, `towing_centi`, `tax_centi`; **`total` is DERIVED**
(legs + parts, `workOrderTotalCenti()`), never stored. Other fields: `problem`,
`diagnosis`, `workshop`, `warranty_until`, `invoice_refs`/`quote_refs`/
`photo_refs` (JSONB), `reported_at`/`est_complete`/`actual_complete`,
`approved_by`/`verified_by`, `breakdown_case_id` (nullable FK — a WO may be
spawned from a breakdown), `component_id` (nullable FK — a WO may install/replace
a component). **`scm.lorry_work_order_parts`**: `name`, `part_no`, `qty`,
`unit_price_centi`, `serial`.

**`scm.lorry_components`** — tyre/battery/brake/etc. SERIAL lifecycle.
`component_type` (`TYRE`|`BATTERY`|`BRAKE_PADS`|`ALTERNATOR`|`STARTER`|`GEARBOX`|
`AIR_COMPRESSOR`|`OTHER`), `position` (`FRONT_L`|`FRONT_R`|`REAR_L`|`REAR_R`|
`NA`), `brand`/`model`/`size`/`serial`, `fitted_date`/`fitted_km`,
`purchase_price_centi`, `tread_depth` (nullable), `removed_date`/`removed_km`,
`warranty_until`, `status` (`ACTIVE`|`REMOVED`). A partial UNIQUE index on
`(lorry_id, position) WHERE status='ACTIVE' AND position<>'NA'` stops two active
tyres in one slot. **`km_used` and `cost_per_km` are DERIVED**
(`deriveComponentLife()`): `km_used = (removed_km | current odometer) −
fitted_km`; `cost_per_km = purchase_price_centi / km_used` (never divide by 0).
**`scm.lorry_component_events`**: `event_type` (`ROTATION`|`PUNCTURE`|`REPAIR`|
`INSPECTION`|`OTHER`), `event_date`, `odometer_km`, `to_position`, `cost_centi`,
`note` — answers "why repeated brakes in three months".

### 10.2 Pure logic (`services/fleet-status.ts`, unit-tested)

- `isCaseGrounding()` / `isBreakdownActive()` — a CRITICAL non-RESOLVED case
  grounds; MINOR/MAJOR are logged only. `breakdownDowntimeHours()` for the board.
- `WORK_ORDER_STATES` / `WORK_ORDER_TRANSITIONS` / `canTransitionWorkOrder()` —
  the state machine (illegal jump like `REPORTED → VERIFIED` is rejected).
  `isWorkOrderOpen()`, `workOrderSeam()` (WAITING_PARTS wins over PLANNED),
  `workOrderTotalCenti()`.
- `deriveComponentLife()` — `km_used` / `cost_per_km` / `under_warranty`.

### 10.3 New routes (`/api/fleet-maintenance`, all gated as shown)

| Route | Gate | What |
|---|---|---|
| `POST /vehicles/:id/breakdowns` | `fleet.write` | Log a case. If CRITICAL: find affected trips, suggest replacement lorries, notify the reporter's reporting line via `postPersonalNotice` (`source='fleet_breakdown'`). |
| `PATCH /breakdowns/:caseId` | `fleet.write` | Update / advance status / resolve (sets `recovery_time`). |
| `POST /vehicles/:id/work-orders` | `fleet.write` | Open a WO (starts `REPORTED`). |
| `PATCH /work-orders/:woId` | `fleet.write` | Edit fields (NOT status). |
| `POST /work-orders/:woId/transition` | `fleet.write` | The ONLY status path — validates against the state machine (`409 illegal_transition`). |
| `POST /work-orders/:woId/parts` | `fleet.write` | Add a part line. |
| `DELETE /work-orders/:woId/parts/:partId` | `fleet.write` | Remove a part line. |
| `POST /vehicles/:id/components` | `fleet.write` | Fit a component (`409 position_occupied`). |
| `PATCH /components/:componentId` | `fleet.write` | Update / remove a component. |
| `POST /components/:componentId/events` | `fleet.write` | Log rotation/puncture/repair/inspection. |

`GET /dashboard` now feeds the two seams per lorry, counts real active
breakdowns + open work orders, combines WO totals with service records for the
this-month repair-spend + costliest-vehicle KPIs, and returns per-vehicle
`downtimeHours` + `openProblem`. `GET /vehicles/:id` returns `breakdowns[]`,
`workOrders[]` (with parts + `nextStates`), and `components[]` (with events +
derived life).

### 10.4 Frontend touch points

- **Desktop** `frontend/src/pages/FleetHealth.tsx` — the board gains a
  **Downtime** column and a real Open-problem cell; the "Active breakdowns" KPI
  is clickable + shows open-WO count. The detail drawer gains **Breakdown &
  incidents** (report + status/resolve), **Work orders** (state-machine stepper +
  parts table + total), and **Tyres & components** (serial cards with km-used /
  cost-per-km, fit / remove / event-log).
- **Mobile** `frontend/src/mobile/MobileMileageCapture.tsx` — the driver's fleet
  screen gains a **Report breakdown** mode (fault, severity, still-drivable,
  description, best-effort GPS + scene photo) alongside the day-complete mileage
  capture. No new menu row (the existing Fleet Mileage surface is extended).

## 8. See also
- `backend/src/services/fleet-status.ts` + `backend/tests/fleetStatus.test.ts`
- `backend/scripts/seed-fleet-maintenance.mjs` (Phase 1 vault) · `seed-fleet-plans.mjs` (Phase 2 plans)
- `backend/src/scm/routes/lorries.ts`, `lorry-service-records.ts` (the sibling master + history)
- `frontend/src/pages/FleetHealth.tsx` (desktop) · `frontend/src/mobile/MobileMileageCapture.tsx` (mobile driver)
- `docs/modules/delivery-tms.md`, `docs/modules/warehouses.md`

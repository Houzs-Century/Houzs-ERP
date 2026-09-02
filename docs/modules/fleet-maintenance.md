# Module: Fleet Maintenance & Compliance (Phase 1 + Phase 2 + Phase 3)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

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
| `scm.lorry_service_records` (mig 0121) | Latest row → current mileage (`odometer_km`) + next service (`next_service_km`/`date`), and `cost_sen` → the this-month repair-spend + costliest-vehicle KPIs. |
| `scm.drivers` | People — `drivers.vehicle` holds the plate, joined to show the assigned driver. |
| `scm.warehouses` | Region/dispatch origin (warehouse `code`, e.g. KL/PG). |

`mig 0055` already dropped a duplicate `public.lorries` once — this module does
NOT create a parallel master.

## 2. The one new table (migration `0202_scm_lorry_compliance_vault.sql`)

> `0202_scm_lorry_compliance_vault.sql` is MERGED and APPLIED under this number.
> **Do NOT renumber it.** `pg-migrate` tracks applied files by full filename, so a
> rename makes it a new file and re-runs its SQL against a schema it has already
> changed.

### `scm.lorry_compliance_documents` — the compliance vault
One row per issued/renewed document across **PUSPAKOM / ROAD_TAX / INSURANCE /
APAD / CROSS_BORDER**, each with document ref, issue + expiry dates, cost, owner,
and (PUSPAKOM) PASS/FAIL result + reinspection deadline. `lorry_id` FK →
`scm.lorries(id)` ON DELETE CASCADE. **Append-only**: renewing INSERTs a new row;
the current document per `(lorry, doc_type)` is the latest-expiring row.

**Company scope — CORRECTED 2026-08-13 (unscoped-write sweep).** The previous
text here read: *"Company scope matches `scm.lorry_service_records`, NOT a hard
scope: the fleet is unified across companies (`scm.lorries` has no `company_id`),
so `company_id` here is stamped on insert but never used to scope reads."* Two of
those claims were wrong and one is now out of date:

- `scm.lorries` **does** carry `company_id` — migration `0083` adds it `NOT NULL`
  with a Houzs backfill wherever the relation is a TABLE (it is skipped only where
  `lorries` exists as a VIEW; that guard is why the column looked absent).
- The lorry MASTER is still deliberately unified — a vehicle is one vehicle, and
  every fleet read lists the whole fleet. That part stands.
- This module's OWN tables (the vault, its attachments, maintenance plans,
  mileage readings, breakdown cases, work orders + parts, components + events,
  workshops) are **per-company**: every insert stamps `activeCompanyId(c)`, and
  since the 2026-08-13 sweep **every write and every by-id read that gates a
  write is scoped with `scopeToCompany`**. The SCM supabase client is
  service-role, so RLS re-checks nothing; that predicate is the isolation.

KNOWN GAP, not yet closed: the LIST/DETAIL reads (`GET /dashboard`,
`GET /vehicles/:id`, `GET /reminders`) are still unscoped, so a both-company user
can be shown a work order they can no longer edit (the write 404s). Closing the
reads is a separate pass — see the unscoped-write sweep PR.

> **Two 2026-08-13 sweeps reached opposite conclusions here, and the merge kept
> the one the CODE agrees with.** A parallel audit read the same migration
> headers (`0202:29-34`, `0203:38-40`, `0204:42-43` — "STAMPED on insert for
> provenance but NOT used to scope reads") plus `GET /dashboard`, found no
> predicates anywhere, and REFUTED 13 fleet leads on that basis, changing
> nothing. It was right about the reads and wrong about the writes, because the
> other sweep had already scoped them: `fleet-maintenance.ts` now carries 13
> `scopeToCompany` calls while `GET /dashboard` still carries none. Both halves
> of that sentence are checkable, and together they are exactly the gap above.
>
> The lesson is the one `CLAUDE.md` already records and this file proves twice:
> the migration header is not the current behaviour, and neither is the column
> list. Read the path you are asking about.

> **`scm.workshops` is the sharpest case of "do not generalise the rule".** It is
> company-scoped ON READ, unlike everything else here: `GET /workshops` filters
> `.eq("company_id", activeCompanyId(c))` (`:2092`), and `mintWorkshopCode` /
> `mintRecordNo` mint per company (`:2073`, `:2083`) behind `UNIQUE (company_id,
> code)` (mig 0241). §11 introduces the workshop master and lists **none** of its
> three endpoints — `GET`, `POST` and `PATCH /workshops/:id` appear in no table
> in this document.


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
| `GET /dashboard` | `fleet.read` | Every ACTIVE, IN-HOUSE lorry only (`inHouseLorries`: `.eq("active", true)` + `is_internal` null-or-true, `fleet-maintenance.ts:231-232`, narrowed 2026-08-02) — an outsourced or deactivated lorry never reaches the board, though `GET /vehicles/:id` still reads it by id. Plus current compliance per type (vault-latest, else flat column) + derived status + KPI ribbon (incl. real this-month repair spend + costliest vehicle from service records). |
| `GET /vehicles/:id` | `fleet.read` | One lorry + full vault history per type + maintenance windows + latest service record. |
| `GET /reminders` | `fleet.read` | Fleet-wide actionable expiries, most urgent first. The computation is the exported `computeFleetReminders()` in the same file — the route AND the daily iOS push job (`services/pushFleetReminders.ts`, 08:00 MYT cron) both call it. Change the rules in one place. |
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
- **Unified fleet MASTER, per-company RECORDS.** `scm.lorries` is deliberately
  not company-scoped (a lorry is one lorry). The vault and every other table in
  this module ARE per-company: reads are still unscoped (known gap, §3), but as
  of 2026-08-13 every WRITE carries `scopeToCompany`. Do not "simplify" a write
  by dropping that predicate — it is the only isolation there is.

## 6. Status seams (Phase 3 now feeds them)

`deriveVehicleStatus()` accepts `openWorkOrder` + `breakdownActive`. As of Phase 3
(§10) these are supplied for real:

- `scm.lorry_work_orders` (open, `IN_REPAIR`/`WAITING_PARTS`) → `PLANNED_MAINTENANCE`
  / `WAITING_PARTS`, plus the "Open problem" / "Downtime" board columns.
- `scm.lorry_breakdown_cases` (CRITICAL, non-resolved) → `BREAKDOWN` + downtime.
- Preventive-maintenance plans (Phase 2) → `SERVICE_DUE`; mileage trip-capture GPS
  cross-check is Phase 4.
- **Notifications**: `computeFleetReminders()` (the `GET /reminders`
  computation) now HAS its scheduled consumer — the daily iOS push summary
  (`services/pushFleetReminders.ts`: one APNs alert per registered
  `push_devices` row whose user holds `fleet.read`, 08:00 MYT, dark until the
  `APNS_*` secrets exist). A critical breakdown ALSO posts a private
  announcement to the reporter's reporting line (`postPersonalNotice`,
  `source='fleet_breakdown'`).

## 7. Frontend (`frontend/src/pages/FleetHealth.tsx`, `/fleet-health`)

Gated `Guard perm="fleet.read"`; nav entry in `Sidebar.tsx` (operations,
`Wrench`). Reuses the app's own design system (`StatCard`,
`ResizableDetailDrawer`, `PageHeader`, tone pills) — not the mockup's dark theme.
Region + status filters are URL state; region options are derived from the
warehouses actually present. Registered in `routing/routeManifest.ts` so the
mobile shell resolves `/fleet-health` to the DRIVER'S MILEAGE-CAPTURE screen
(`MobileApp.tsx:132`, shipped with Phase 2) while desktop mounts this admin
dashboard at the same URL — one product, two presentations. See §9.5.

**The drawer is a quick look, not the record** — see section 12. Everything a
lorry has ever had lives on `/fleet-health/:lorryId`.

**Every write on this page says so when it is refused (2026-08-21).** Six of
them did not: the breakdown status dropdown, the work-order stepper, add part,
remove part, remove component and log component event all caught their rejection
with `catch { /* surfaced on reload */ }`. Nothing reloads — `onChanged()` is the
last statement inside the `try`, so a refusal skips it, and the breakdown
dropdown is a controlled `<select>` that keeps displaying the option the operator
picked because no render ever happens. They now set an error the card renders,
through this file's own `apiErrText`, matching the eight handlers that always
did. Pinned by `frontend/src/pages/fleetHealthWriteFailures.test.tsx`; the trace
is in `docs/bugs/0489-fleet-health-refused-six-writes-in-silence-under-a-comment-c.md`.

## 9. Phase 2 — preventive plans + mileage capture

### `scm.lorry_compliance_attachments` — the vault's FILES (mig 0238, 2026-08-01)

The vault stored a reference NUMBER (`document_ref` is text) and no file, and the
Fleet Health drawer rendered the history read-only — no add form, no file input —
while its own footer said "Renew a compliance document by adding a new row".
Owner, 2026-08-01: *"为什么我的 Compliance、Road Tax 这些都是不能 Upload 的呢？"*
Because it was never built. Mig 0238 and the endpoints below are that half.

`id, company_id, document_id -> lorry_compliance_documents(id) ON DELETE CASCADE,
r2_key, file_name, mime_type, size_bytes, uploaded_by, created_at`. UNIQUE on
`r2_key`; index on `(document_id, created_at)`.

**MANY files per renewal, not one column on the document.** A PUSPAKOM report runs
to several pages and an insurance renewal is cover note + schedule. Four flat
`file_*` columns would cap it at one and need this table anyway.

**The R2 key is SERVER-MINTED** — `fleet/compliance/<lorryId>/<docId>/<ts>.<ext>`,
built by the PUT handler. A client never supplies it, so a row can never point at
an arbitrary bucket object. Bucket is `POD_BUCKET`, the same one project and ASSR
attachments use; the contract copies `projects.ts /:id/attachments` exactly (PUT
raw binary, `?ext=&name=`).

| Method | Path | Notes |
|---|---|---|
| PUT | `/fleet-maintenance/vehicles/:id/compliance/:docId/attachments?ext=&name=` | `fleet.write`. Verifies the document belongs to the lorry in the path — a known `docId` must not let a caller hang a file off another lorry's renewal. PDF/JPG/PNG/WEBP/HEIC, 15MB |
| DELETE | `/fleet-maintenance/compliance-attachments/:attId` | `fleet.write`. Row first, R2 object second — a failed object delete leaves a harmless unreferenced blob, the reverse order would leave a row pointing at nothing |
| GET | `/fleet-maintenance/compliance-attachments/:key{.+}` | `fleet.read`. Streams it. Refuses any key outside the `fleet/compliance/` prefix |

The detail read (`GET /vehicles/:id`) groups the files onto their history rows, so
the drawer never joins two arrays itself.

**Also surfaced on the drawer, 2026-08-01:** the box dimensions
(`length_ft`/`width_ft`/`height_ft`, mig 0209 — stored since WS3, never shown) and
a note when an IN-HOUSE lorry has nothing on file for Road Tax / Insurance /
PUSPAKOM. That note **states** the gap rather than enforcing it: a hard
requirement would block editing the very rows that are incomplete, and the live
fleet has plenty of those. An outsourced lorry is the carrier's paperwork and is
not counted.

### 9.1 New tables (migration `0203_scm_lorry_plans_mileage.sql`)

> `0203_scm_lorry_plans_mileage.sql` is MERGED and APPLIED under this number.
> **Do NOT renumber it** — see the note under §2.

**`scm.lorry_maintenance_plans` — one plan per COMPONENT per lorry.** Child of
`scm.lorries(id)` ON DELETE CASCADE, company-stamped-not-scoped like the vault.
Columns: `component` (CHECK against the twelve components — engine oil, oil +
filter, gearbox oil, brake inspection, brake pads, tyres, battery, alignment,
air-con, suspension, cooling system, PUSPAKOM prep), `interval_km`,
`interval_months` (at least one required — CHECK), `last_done_date`,
`last_done_km`, `workshop`, `est_cost_sen`, `notes`, `active`. A UNIQUE index
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

> `0204_scm_lorry_workorders_breakdowns_components.sql` is MERGED and APPLIED
> under this number. **Do NOT renumber it** — see the note under §2. All five
> tables are children of
> `scm.lorries` ON DELETE CASCADE, company-stamped-not-scoped like the Phase-1/2
> siblings. Money is BIGINT `*_sen`.

**`scm.lorry_breakdown_cases`** — a breakdown / roadside-incident log. Columns:
`occurred_at`, `gps_lat`/`gps_lng`, `fault_type`, `severity`
(`MINOR`|`MAJOR`|`CRITICAL`), `still_drivable`, `media_refs` (JSONB R2 keys),
`driver_description`, `towing_company`, `towing_cost_sen`, `workshop`,
`breakdown_start`, `recovery_time`, `affected_trip_id` (nullable FK
`scm.trips` ON DELETE SET NULL), `status` (`OPEN`|`TOWING`|`IN_WORKSHOP`|
`RESOLVED`). **A CRITICAL, non-RESOLVED case grounds the lorry** — it feeds
`breakdownActive` → `deriveVehicleStatus()` returns `BREAKDOWN` →
`canDispatch()` is false. This reuses the **established derived-status seam**; it
does NOT write a parallel `scm.lorry_maintenance` window and does NOT add a
status column (`BREAKDOWN` is more specific than `OUT_OF_SERVICE`, so the case
must NOT also open an OOS window or the machine would report `OUT_OF_SERVICE`).

**`scm.lorry_work_orders`** — the maintenance work order. State machine
(`status` CHECK): `REPORTED → DIAGNOSED → QUOTED → APPROVED → IN_REPAIR →
WAITING_PARTS → COMPLETED → VERIFIED` — `QUOTED` arrived with mig 0247 (see
§10.2) — with the direct `DIAGNOSED → APPROVED` edge for unquoted jobs, the
`IN_REPAIR ⇄ WAITING_PARTS` loop and
`WAITING_PARTS → COMPLETED`. An OPEN WO in `IN_REPAIR` feeds
`PLANNED_MAINTENANCE`; in `WAITING_PARTS` feeds `WAITING_PARTS` (COMPLETED /
VERIFIED are closed and feed nothing). Money legs `labour_sen`,
`outside_service_sen`, `towing_sen`, `tax_sen`; **`total` is DERIVED**
(legs + parts, `workOrderTotalCenti()`), never stored. Other fields: `problem`,
`diagnosis`, `workshop`, `warranty_until`, `invoice_refs`/`quote_refs`/
`photo_refs` (JSONB), `reported_at`/`est_complete`/`actual_complete`,
`approved_by`/`verified_by`, `breakdown_case_id` (nullable FK — a WO may be
spawned from a breakdown), `component_id` (nullable FK — a WO may install/replace
a component). **`scm.lorry_work_order_parts`**: `name`, `part_no`, `qty`,
`unit_price_sen`, `serial`.

**`scm.lorry_components`** — tyre/battery/brake/etc. SERIAL lifecycle.
`component_type` (`TYRE`|`BATTERY`|`BRAKE_PADS`|`ALTERNATOR`|`STARTER`|`GEARBOX`|
`AIR_COMPRESSOR`|`OTHER`), `position` (`FRONT_L`|`FRONT_R`|`REAR_L`|`REAR_R`|
`NA`), `brand`/`model`/`size`/`serial`, `fitted_date`/`fitted_km`,
`purchase_price_sen`, `tread_depth` (nullable), `removed_date`/`removed_km`,
`warranty_until`, `status` (`ACTIVE`|`REMOVED`). A partial UNIQUE index on
`(lorry_id, position) WHERE status='ACTIVE' AND position<>'NA'` stops two active
tyres in one slot. **`km_used` and `cost_per_km` are DERIVED**
(`deriveComponentLife()`): `km_used = (removed_km | current odometer) −
fitted_km`; `cost_per_km = purchase_price_sen / km_used` (never divide by 0).
**`scm.lorry_component_events`**: `event_type` (`ROTATION`|`PUNCTURE`|`REPAIR`|
`INSPECTION`|`OTHER`), `event_date`, `odometer_km`, `to_position`, `cost_sen`,
`note` — answers "why repeated brakes in three months".

### 10.2 Pure logic (`services/fleet-status.ts`, unit-tested)

- `isCaseGrounding()` / `isBreakdownActive()` — a CRITICAL non-RESOLVED case
  grounds; MINOR/MAJOR are logged only. `breakdownDowntimeHours()` for the board.
- `WORK_ORDER_STATES` / `WORK_ORDER_TRANSITIONS` / `canTransitionWorkOrder()` —
  the state machine (illegal jump like `REPORTED → VERIFIED` is rejected).
  `isWorkOrderOpen()`, `workOrderSeam()` (WAITING_PARTS wins over PLANNED),
  `workOrderTotalCenti()`.

  ```
  Reported → Diagnosed → Quoted → Approved → In Repair → Completed → Verified
                    └──────────────┘              ⇅
                    (unquoted jobs)          Waiting Parts → Completed
  ```

  **`QUOTED` (mig 0247, 2026-08-03)** is where a job waits for the owner to
  accept the workshop's price. Owner: *"正常不是应该我 report 了这个问题，然后
  diagnose，然后 for quotation，然后 approve…"*. Before it, a job sat in
  `DIAGNOSED` whether the quote had arrived or not — while the work order had
  carried `quotation_no` since mig 0241. **`DIAGNOSED → APPROVED` is kept**: every
  work order already in `DIAGNOSED` was created when that was its only move, and
  a job small enough to approve on the spot should not have to fake a quotation.
  `QUOTED` is OPEN but feeds **no seam** — a lorry waiting on a price is still on
  the road.

  The list lives in three places by necessity (the machine, the migration CHECK,
  and the stepper, which needs the ORDER the API never sends).
  **`npm --prefix backend run audit:work-order-states`** compares all three and
  runs in `ci.yml`, `deploy.yml` and `deploy-staging.yml`. Mutation-verified:
  dropping the state from either the stepper or the CHECK fails the job and names
  which copy drifted.
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

## 11. The repair record — workshop master, billed lines, and OCR (mig 0241)

Owner, 2026-08-02, holding a real document (T FORCE AUTO SERVICES quotation
`WJO00403`, lorry VQE9058, RM22,208.50): every repair that costs money is one
record, and it must carry what the paper carries.

**`scm.workshops` is a new master.** The repair vendor used to be a free-text
`workshop` string on FOUR unrelated tables (work orders, breakdown cases,
maintenance plans, service records), so "what did we spend at this workshop"
was not a question the schema could answer. It is NOT filed under
`scm.suppliers` — that master feeds purchase orders, GRNs, the DP
supplier-pickup picker and the supplier portal, and a workshop is none of
those. Same reasoning `0210` used for `scm.threepl_companies`.

Codes are **minted, never typed** — `WS-001` per company (PAD=3 — only BD/WO pad to four, `fleet-code-mint.ts:29,36`; corrected 2026-08-12), `mintWorkshopCode`.
The `UNIQUE (company_id, code)` index is the real guard; a racing create loses
there and retries the mint. (The driver roster is what hand-typed codes look
like after a year: `DRV-001..007` beside `DRV-05`/`DRV-050`, one person three
times.)

**The header gained the vendor's own document numbers.** `quote_refs` /
`invoice_refs` hold R2 FILE KEYS — there was nowhere to put "WJO00403". One
repair carries BOTH numbers over its life (quotation at DIAGNOSED/APPROVED,
invoice at COMPLETED/VERIFIED), so `quotation_no` and `invoice_no` are two
columns on ONE record, not two records. Plus `advisor` (the workshop's, not
ours) and `document_date` (what the paper prints, which is not `reported_at`).

**Lines now have the four columns a real invoice prints**: `section`
(PART / LABOUR), `uom`, `discount_pct`, `amount_sen`.

- The discount is a **percentage, per line** — WJO00403 carries 15% on 14 of
  its 19 lines and none on the other 5.
- `amount_sen` is the **printed** amount and it WINS over the computation.
  The vendor's rounding is theirs; a record that quietly disagrees with the
  paper is worse than one that repeats it. NULL means "not printed, compute
  it", and `workOrderLineCenti` takes
  `amount ?? round(qty x unit x (1 - disc/100))`.

**LABOUR HAS TWO SHAPES AND THEY MUST NOT BOTH BE FILLED.** Pre-0241 rows put
labour in the header scalar `labour_sen`; new records put it in
LABOUR-section lines. `workOrderTotalCenti` sums both, so filling both counts
labour twice. A CHECK cannot express "not both" without pinning existing rows,
so **the parts route is the single writer that enforces it** — adding a LABOUR
line to a record whose `labour_sen > 0` is a 409 `labour_already_on_header`.

### OCR — `POST /api/scm/scan-lorry-invoice/extract`

`backend/src/scm/routes/scan-lorry-invoice.ts`. A **minimal sibling** of
`scan-payment.ts`, not a second `scan-so.ts`: one synchronous call, no
`scan_jobs` row, no queue, no reaper, no learning loop. scan-so needs all that
because a rep photographs a stack of slips on bad signal; a workshop invoice is
one document uploaded at a desk with someone watching the screen.

**It writes NOTHING.** It returns what the paper says and the operator confirms
it into a work order as a separate, explicit step. An OCR pass that silently
books a five-figure repair is not something anyone asked for.

**PDFs go straight in** — Anthropic takes a `document` content block, so there
is no rasteriser here and none is needed. The document that prompted this is a
PDF with a text layer; a phone photo of a paper invoice takes the same path as
an image block.

**It resolves no ids.** The workshop is returned as a NAME, the vehicle as a
PLATE. Matching those to `scm.workshops` and `scm.lorries` is the review
screen's job, because an OCR pass must never invent a foreign key.

**The reconciliation is the point.** The response carries
`totals.reconciles` — the sum of the extracted lines against the grand total
the model read from a DIFFERENT part of the page. An extraction that drops one
line of nineteen looks entirely plausible and is wrong by RM6,375; this is what
catches it. `null` means the document printed no total, which is **not** the
same as "checked and agreed" — do not render it as a tick.

Tests: `backend/tests/scanLorryInvoice.test.ts` replays WJO00403 end to end,
including the dropped-line case and the vendors who print no line amounts at
all. `backend/tests/fleetStatus.test.ts` reproduces its RM22,208.50 through the
stored line model.

## 12. The drawer is a quick look; the record is a page (2026-08-02)

Owner: *"这个 Fleet Health 不可能只是在右边展示... 它应该要支持展开... 要不然界面
会显得非常乱. 例如 Compliance 这些资料，就不需要在刚点开的时候直接显示在右边.
包括我的 New Work Order 和 Import Work Shop Document 都不需要在这边. 它应该只需要
看得到现在的 Mileage，以及下一次什么时候要去维修."*

The drawer had accumulated every phase's section — vault with per-document
renewal history and file attachments, work orders, tyres, plans, mileage history
— in a side panel you scrolled for a page and a half.

**The split is by QUESTION, not by size.**

| Surface | Answers | Carries |
|---|---|---|
| Drawer (`FleetHealth.tsx`) | *Can I use this lorry today?* | out-of-service / open-problem banner, current mileage, next service, breakdowns, a link to the record |
| Page (`LorryRecord.tsx`, `/fleet-health/:lorryId`) | *What is this lorry's history?* | vehicle dates, breakdowns, work orders, components, plans, mileage, the full compliance vault |

**New Work Order** and **Import Workshop Document** moved to the page with the
work-order section they belong to. They are not duplicated in the drawer.

**The page IMPORTS the sections; it does not re-implement them.** ~32
declarations in `FleetHealth.tsx` gained `export` for this (`PlansSection`,
`MileageSection`, `BreakdownSection`, `WorkOrdersSection`, `ComponentsSection`,
`AttachmentStrip`, `AddRenewalForm`, `MissingComplianceNote`, `Pill`, `money`,
`boxLabel`, `DOC_TYPES`, `DOC_LABEL`, `STATUS_TONE`, and the payload types).
Copying them by hand is how one copy quietly loses a fix. Both surfaces read the
same `GET /api/fleet-maintenance/vehicles/:id`, so there is one payload shape.

Gated exactly as `/fleet-health` is (`fleet.read`); registered in
`routing/routeManifest.ts`. Desktop-only — UNLIKE its parent `/fleet-health`,
which does have a mobile surface.

### The four dates a lorry's life is measured from (mig `0245`)

Owner: *"每一辆罗里都要有以下这些日期：1. 生产日期 2. 注册 (Register) 日期
3. 第一天上班的日期"*. `scm.lorries.purchase_date` (mig 0121) already existed and
is **none of those three**.

| Column | Answers | Why it is not one of the others |
|---|---|---|
| `manufacture_date` | how OLD the vehicle is | depreciation, and whether a part is still made for it |
| `registration_date` | the JPJ registration | road tax / insurance / PUSPAKOM cycles anchor here, not to our purchase |
| `in_service_date` | first day it worked FOR US | the denominator for cost-per-day — bought in March, idle until June, is not three months of use |
| `purchase_date` (0121) | when WE bought it | already present |

**All nullable, no backfill, and no ordering CHECK.** Nothing in the system can
infer any of them, and a guessed date silently becomes the basis of an age or a
cost-per-day figure nobody can trace. `manufacture <= registration <= in_service`
is tempting and wrong: a reconditioned import is registered here long after it
was built elsewhere, and a lorry can start work before its transfer paperwork
clears. The UI states the intent instead of the database refusing the row.

Edited on the lorry master (`scm-v2/LorryDetail.tsx`, Coverage & Fleet); read
back through `/api/fleet-maintenance/vehicles/:id` for the record page's Vehicle
section.

## 13. Three things the schema had and the screen did not (2026-08-03)

Each of these was a column or a route that already existed, with no way to reach
it from the UI. They are listed together because they are one failure mode.

### Preventive-maintenance plans were creatable only by script

The empty state read *"Seed the default set (backend/scripts/seed-fleet-plans.mjs)
or add plans via the API"* — instructions to run a Node script, shown to the
owner. Owner: *"我该怎么去用?"*. `POST /vehicles/:id/plans` and
`PATCH /plans/:planId` had existed since Phase 2; only the form was missing.

`PlansSection` now takes optional `vehicleId` / `components` / `onChanged`; given
all three it can add and edit, and without them it still renders read-only. The
form re-POSTs when editing because **the route UPSERTs on `(lorry, component)`** —
the component is the identity, so the picker is disabled while editing (changing
it would move the plan to a different component, not rename this one) and
components that already have a plan are not offered when adding.

The component list is **served, not mirrored**: `GET /vehicles/:id` now returns
`planComponents[]` from `PLAN_COMPONENTS` + `PLAN_COMPONENT_LABELS`. The list and
the migration's CHECK are already two copies; a third in the frontend would be
the one nobody updates.

### A repair and the breakdown that caused it were unrelated rows

`scm.lorry_work_orders.breakdown_case_id` has existed since mig `0204` and the
create route has always accepted `breakdownCaseId` — **no UI ever wrote it**.
Owner: *"它不是应该跟我们的 breakdown 还有 incident 有串联吗?"*.

The New Work Order form now offers the lorry's **open** cases (a resolved case is
almost always a mis-click, not a late link), and the work-order card shows the
case it came from. Same class as `aggregation` before mig 0244 and `is_own_fleet`
before 0246: a column with a UI and no writer.

### One click peeks, two clicks open

Owner: *"1. 单击：弹出一个 shortcut，让我简单看一个简介; 2. 双击：点进去看细节"* —
the Sales Order interaction, by name. A double click fires click, click, dblclick,
so the peek is held for 250ms and cancelled when the second click lands;
otherwise the drawer flashes open and the navigation pulls the page out from
under it. The timer is cleared on unmount — the suite leaked exactly this kind of
timer into a torn-down jsdom for a year (`BUG-HISTORY.md`, 2026-08-02).

Keyboard cannot double-click: **Enter** peeks, **Shift+Enter** opens the record.

## 14. Records you can name, and a page that folds (2026-08-03)

### BD-#### and WO-#### (mig `0248`)

Owner: *"每一个 Breakdown Incident 应该带出一个唯一的编号"* and *"你的 Works Order
也应该有一个编号... 需要清晰指示它对应的是哪一个 Breakdown 编号"*.

Both tables had only a UUID. The number on screen — `WJO00403` — is the
**workshop's own** quotation number, read off their document by the OCR
(`quotation_no`, mig 0241). It belongs to the vendor, it is not unique across
vendors, and a repair with no document has none. There was no way to refer to
one of our own records except by pointing at it.

| | |
|---|---|
| Minting | `scm/lib/fleet-code-mint.ts`, the same minter behind DRV / HLP / 3PL / WS. `PAD_BY_PREFIX` makes BD and WO **four** wide — a fleet accumulates work orders for a decade — and the migration's backfill LPADs to four to match. The two MUST agree or the register would read as two schemes. |
| Backfill | Per company by `(created_at, id)`, oldest first, so it reads like a register and re-running on a clone gives the same answer. |
| Uniqueness | Nullable column + **partial** unique index per company, exactly as mig 0242 did for `threepl_companies`. |
| Not a sequence | A Postgres sequence lives outside the app's own allocation rule and could not be reasoned about beside the other four codes. A lorry breaks down a few times a year, not a few times a second. |

`woNo` and `quotationNo` are both surfaced, and deliberately labelled as ours and
theirs — confusing the two is how a repair gets attributed to the wrong vendor.

### The page folds instead of sprawling

Owner: *"这个卡片或区域应该设计成可以展开和收起"*, *"要确保当资料密密麻麻、数据量
很大的时候，界面依然清晰"*, and on the Vehicle block, *"字太多、提示词也太多了"*.

`RecordCard` (exported from `FleetHealth.tsx`) is the one collapsible shell for
breakdowns, work orders and components. **Closed shows what you scan for** — the
number, a status badge, what it was, when — and the detail is one click away
rather than a scroll away. What opens by default is the rule, not a preference:

| Record | Open by default when |
|---|---|
| Breakdown | not `RESOLVED` — the case you opened the page for |
| Work order | still `open` (anything before COMPLETED) |
| Component | `ACTIVE` — a removed one is history |

Inside, `Detail` renders a label/value grid. It replaces the run-on
"a · b · c · d · e" line, which was unreadable the moment a record had more than
three facts.

The Vehicle block lost a sentence of explanation under every date plus a
paragraph under the row. That reasoning lives in mig 0245 and in section 12 —
which is where reasoning belongs; the screen shows the dates.

### Mileage can be recorded on screen

Owner: *"这部分应该用来记录每周的里程。比如我们每一次检测的记录：在什么时间、当时的
里程数是多少"*.

`POST /vehicles/:id/mileage` has always accepted `source: "MANUAL"` — the odometer
could be captured from the driver's phone on day-complete and **nowhere else**.
`MileageSection` now takes optional `vehicleId` / `onChanged` and grows a form.
The two rules the route enforces are stated before you hit them: a reading below
the last one is a rollback and is refused; an abnormal jump saves but is flagged.

## 15. What is editable, and what deliberately is not (2026-08-03)

Owner: *"这些数据我要怎么去编辑呢? 所有的内容都是可以编辑并保存的吗?"*. It was not
a full yes, and the gaps were all the same shape — a PATCH route that had accepted
the field since Phase 3, with nothing on screen sending it.

| Record | Editable on the record page | Where the write goes |
|---|---|---|
| Breakdown case | fault, severity, still-drivable, driver report, towing company + cost, workshop, status | `PATCH /breakdowns/:id` |
| Work order — header | problem, diagnosis, workshop, their quotation / invoice no, labour, outside service, towing, tax, warranty | `PATCH /work-orders/:id` |
| Work order — state | the stepper only, one legal transition at a time | `POST /work-orders/:id/transition` |
| Work order — lines | add / remove | `POST` / `DELETE .../parts` |
| Preventive plan | every field; the component is the identity so it is fixed while editing | `POST /vehicles/:id/plans` (UPSERT) |
| Mileage | append a reading | `POST /vehicles/:id/mileage` |
| Component | log an event, remove | `PATCH /components/:id`, `POST .../events` |
| Compliance vault | **append only** | `POST /vehicles/:id/compliance` |
| The lorry's own dates | **not here** — a link to Coverage & Fleet | `PATCH /api/scm/lorries/:id` |

**Two of those are refusals, not omissions.**

The **compliance vault is append-only by design** (§5). Renewing is a new row;
editing an expiry in place would destroy the audit trail the vault exists to be.

**The lorry master is the single writer for lorry columns.** A second editor over
`scm.lorries` on this page is how two screens start disagreeing, and it sits
behind a different permission — `scm.transportation.drivers`, not `fleet.write`.
So the record page links to Coverage & Fleet instead of duplicating the form.

**Severity is not cosmetic.** A CRITICAL, unresolved case is what grounds a lorry
(`isCaseGrounding`), so editing severity here can put a lorry back on the road.
The form says so.

**Header money vs line money.** The four money legs on a work order are added ON
TOP of the lines. The route refuses a non-zero header `labour_sen` on a work
order whose lines already carry LABOUR — the invariant that stops the workshop's
labour being counted twice — and the form states it rather than letting you find
out by 409.

## 8. See also
- `frontend/src/pages/LorryRecord.tsx` (the full record; sections imported from `FleetHealth.tsx`)
- `backend/scripts/check-work-order-states.mjs` (`audit:work-order-states` — the three copies of the state list)
- `backend/src/services/fleet-status.ts` + `backend/tests/fleetStatus.test.ts`
- `backend/scripts/seed-fleet-maintenance.mjs` (Phase 1 vault) · `seed-fleet-plans.mjs` (Phase 2 plans)
- `backend/src/scm/routes/lorries.ts`, `lorry-service-records.ts` (the sibling master + history)
- `frontend/src/pages/FleetHealth.tsx` (desktop) · `frontend/src/mobile/MobileMileageCapture.tsx` (mobile driver)
- `backend/src/scm/routes/scan-lorry-invoice.ts` + `backend/tests/scanLorryInvoice.test.ts` (repair-document OCR)
- `docs/modules/scan-to-so.md` (the full background pipeline this deliberately does NOT copy)
- `docs/modules/delivery-tms.md`, `docs/modules/warehouses.md`

## Plates are stored CANONICAL (2026-08-01)

`scm.lorries.plate` is `NOT NULL UNIQUE` (mig 0053) but the index compares the RAW
string, so `AKF 8100` and `AKF8100` were two lorries in production. `normalizePlate`
(`scm/lib/plate-normalize.ts`) strips everything that is not a letter or digit and
uppercases the rest; `lorries.ts` POST and PATCH store that form, so no new
duplicate of this shape can form.

Existing rows are cleaned by **Repair lorry plates (DRY-RUN gated)**
(`backend/scripts/repair-lorry-plates.mjs`), in two independently-runnable parts:

| Part | What it does | Risk |
|---|---|---|
| `renames` | Canonical form is unclaimed -> one UPDATE of one text column | Reversible, touches no FK |
| `merges` | Several rows for one vehicle -> re-point every referencing row, DELETE the loser | Not reversible |

The survivor is `pickSurvivor` — most-referenced wins (fewest rows move), ties break
active, then oldest, then id, so a dry run predicts the apply exactly. **Referencing
tables come from `pg_constraint` at run time, never from the migration tree.**

If you add a table with a `lorry_id` FK, the script picks it up automatically. Do
NOT hand-maintain a list here.

## Company scope — one transport company, one fleet

**Nothing in this module scopes a maintenance record to a company.** Not the
dashboard, not the by-id reads, not the by-id writes.

Owner, 2026-09-02, asked directly whether the records are shared or per-company:

> 「共用的，因为 TMS 是共用的。这个东西 TMS 就像我们的运输公司一样」

That covers the compliance vault and its attachments, maintenance plans, mileage
readings, breakdown cases, work orders and their parts, and components — the
same answer the vehicles, drivers and helpers already had.

`company_id` is still **STAMPED on insert**, because migs 0202 / 0203 / 0204 /
0238 require it for provenance. Stamped is not scoped, and
`backend/tests/fleetMaintenanceUnifiedScope.test.ts` pins both halves: no shared
table may be company-scoped, and the stamp may not be tidied away.

**`scm.workshops` is the ONE exception** and IS per-company (mig 0241). It is the
repair-shop master, not a maintenance record; the ruling was about the records
and did not reach it. Its handlers scope through `scopeToCompany`, which fails
closed — not through a hand-rolled `.eq("company_id", … ?? null)`, which matches
nothing and, on the code minters, reissued duplicate numbers
(`docs/bugs/0618-a-nullable-company-id-in-eq-matched-nothing-and-minted-dupli.md`).

**What this replaced.** Twelve by-id handlers had been scoping these tables while
`GET /dashboard` did not, so the dashboard listed rows that PATCH/DELETE then
404'd — the exact failure this file's own `company-scope-file:` marker predicted
in words. Trace, and the two docs that had disagreed with each other about it, in
`docs/bugs/0620-the-fleet-dashboard-listed-rows-nobody-could-open.md`.

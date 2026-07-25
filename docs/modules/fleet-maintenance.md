# Module: Fleet Maintenance & Compliance (Phase 1)

The lorry compliance + service-readiness system. It **builds ON the existing SCM
fleet foundation** — `scm.lorries` is THE vehicle master; the only genuinely-new
table is the compliance vault with renewal history. Status is *derived*, never
typed.

> **Phase 1 scope.** The compliance vault (with reminders), the Fleet Health
> dashboard, and the derived-status state machine — all over the lorries that
> already exist. Work orders, breakdown cases, tyre/component tracking and
> mileage trip-capture are LATER phases; their seams are in §6, not built.

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

## 6. Later-phase seams (documented, not built)

`deriveVehicleStatus()` already accepts `openWorkOrder` + `breakdownActive`; the
tables that will feed them are NOT created (no empty prod surface nobody writes):

- `fleet work orders` → `PLANNED_MAINTENANCE` / `WAITING_PARTS`, and the "Open
  problem" / "Downtime" board columns.
- `fleet breakdown cases` → `BREAKDOWN` + downtime.
- Preventive-maintenance plans, tyre/component tracking, mileage trip-capture.
- **Notifications**: `GET /reminders` is the computation a future scheduled job
  rides onto the app's existing announcement/notification mechanism. Phase 1
  surfaces reminders on the dashboard only (no new push channel).

## 7. Frontend (`frontend/src/pages/FleetHealth.tsx`, `/fleet-health`)

Gated `Guard perm="fleet.read"`; nav entry in `Sidebar.tsx` (operations,
`Wrench`). Reuses the app's own design system (`StatCard`,
`ResizableDetailDrawer`, `PageHeader`, tone pills) — not the mockup's dark theme.
Region + status filters are URL state; region options are derived from the
warehouses actually present. Registered in `routing/routeManifest.ts` so the
mobile shell resolves it to a desktop-only dead-end (no mobile screen in Phase 1).

## 8. See also
- `backend/src/services/fleet-status.ts` + `backend/tests/fleetStatus.test.ts`
- `backend/scripts/seed-fleet-maintenance.mjs`
- `backend/src/scm/routes/lorries.ts`, `lorry-service-records.ts` (the sibling master + history)
- `docs/modules/delivery-tms.md`, `docs/modules/warehouses.md`

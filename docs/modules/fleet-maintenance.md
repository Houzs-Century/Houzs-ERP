# Module: Fleet Maintenance & Compliance (Phase 1)

The lorry compliance + service-readiness system. A **self-contained native
module** — its own vehicle master, its own compliance vault with true renewal
history, and a Fleet Health dashboard. Status is *derived*, never typed.

> **Phase 1 scope.** Vehicle master, compliance vault (with reminders), the
> Fleet Health dashboard, and the derived-status state machine. Preventive-
> maintenance plans, work orders, breakdown cases, tyre/component tracking and
> mileage trip-capture are LATER phases — their seams are described in §6, not
> built.

## 1. Frontend

- **`frontend/src/pages/FleetHealth.tsx`** — the desktop ops screen, route
  `/fleet-health`, gated `Guard perm="fleet.read"` (App.tsx). Nav entry in
  `components/Sidebar.tsx` (operations section, `Wrench` icon, `perm:
  "fleet.read"`).
- Reuses the app's own design system: `StatCard` (KPI ribbon),
  `ResizableDetailDrawer` (the shared SCM detail-drawer chrome) for the
  per-lorry drawer, `PageHeader`, `Button`. Status + expiry pills follow the
  app tone vocabulary (no dark standalone theme).
- Region toggle (ALL / KL / PG) and the status filter live in the URL
  (`useSearchParams`) — URL-is-state.
- **The frontend never re-derives the rules.** The backend returns
  ready-to-render status, reminder levels and KPIs; the page only renders. The
  reminders strip is derived from the same dashboard payload so it can never
  disagree with the board.
- Mobile: `/fleet-health` is registered in `routing/routeManifest.ts`
  (`STAFF_ROUTE_PATTERNS`) so the phone shell resolves it to a correct
  "built for desktop" dead-end rather than misrouting. No mobile screen in
  Phase 1 (desktop ops tool).

## 2. Schema (migration `0200_fleet_maintenance_p1.sql`, `public` schema)

> ⚠️ The migration number is a **placeholder** — re-check and renumber to
> highest-on-main + 1 at MERGE time (see the file header).

### `public.fleet_vehicles` — the lorry master
`id` (bigserial), `company_id` (NOT NULL), `plate` (UNIQUE per company),
`region`, `driver_name`, `vehicle_type`, `model`, `current_mileage_km`,
`next_service_km`, `next_service_date`, `out_of_service` (bool) +
`out_of_service_reason`, `notes`, `active`, `created_at/updated_at/created_by`.

`out_of_service` is the **manual INPUT** to the status machine, not the status.

### `public.fleet_compliance_documents` — the compliance vault
One row = one issued/renewed document. **Append-only history**: to renew you
INSERT a new row; the prior row survives as history. Columns: `vehicle_id`
(FK → fleet_vehicles, ON DELETE CASCADE), `doc_type`
(`PUSPAKOM | ROAD_TAX | INSURANCE | APAD | CROSS_BORDER`, CHECK-constrained),
`document_ref`, `issue_date`, `expiry_date`, `cost_centi`, `owner`, `result`
(`PASS | FAIL`, PUSPAKOM only), `reinspection_deadline` (PUSPAKOM FAIL),
`notes`. The **current** document per `(vehicle, doc_type)` is the
latest-expiring row — computed, never a mutable "is_current" flag.

Seed data does NOT live in the migration — `backend/scripts/seed-fleet-
maintenance.mjs` loads the real Driver List fleet (idempotent, DRY-RUN by
default; `APPLY=1` writes).

## 3. Backend routes (`/api/fleet-maintenance`, `backend/src/routes/fleet-maintenance.ts`)

Company-scoped, gated by the flat `fleet.read` / `fleet.write` permissions
(`services/permissions.ts`). Data access via Drizzle (`getDb`).

| Route | Gate | What |
|---|---|---|
| `GET /dashboard` | `fleet.read` | Vehicles + current compliance per type + reminder levels + KPI ribbon counts. All derivation server-side. |
| `GET /vehicles/:id` | `fleet.read` | One vehicle + FULL compliance history per type (drawer). |
| `GET /reminders` | `fleet.read` | Fleet-wide actionable expiries (past the 60-day threshold / expired / failed), most-urgent first. The seam a future notification job calls. |
| `POST /vehicles` | `fleet.write` | Create a lorry. |
| `PATCH /vehicles/:id` | `fleet.write` | Edit master fields incl. the manual OOS flag. |
| `POST /vehicles/:id/compliance` | `fleet.write` | **Append** a compliance document (renewal). Never overwrites. |

## 4. The derived-status state machine (`backend/src/services/fleet-status.ts`)

Pure, env-free, unit-tested (`backend/tests/fleetStatus.test.ts`). Two concerns:

- **`reminderLevel(daysRemaining)`** — the escalating ladder:
  `EXPIRED (<0) → ESCALATE (≤7, owns 7/3/1) → RED (≤14) → NOTIFY (≤30) →
  AMBER (≤45) → PREPARE (≤60) → OK`.
- **`deriveVehicleStatus(input)`** — precedence, highest wins:
  `OUT_OF_SERVICE` (manual flag) → `COMPLIANCE_BLOCKED` (expired doc / failed
  PUSPAKOM — the owner's hard rule) → `BREAKDOWN` (seam) → `WAITING_PARTS`
  (seam) → `PLANNED_MAINTENANCE` (seam) → `SERVICE_DUE` (mileage within
  `SERVICE_DUE_KM_THRESHOLD` of, or past, next service; or next-service date
  within `SERVICE_DUE_DAYS_THRESHOLD`) → `AVAILABLE`.

In Phase 1 only `AVAILABLE / SERVICE_DUE / COMPLIANCE_BLOCKED / OUT_OF_SERVICE`
are reachable — the three seam states are wired but their inputs are never
supplied (see §6).

## 5. Rules that will bite you

- **Renewals are new rows.** Never `UPDATE` a compliance row's expiry to renew
  — that erases the history the owner wants. Append; the current doc is derived.
- **A failed PUSPAKOM grounds the lorry** independent of the printed expiry,
  until a fresh `PASS` row is appended.
- **Status is never stored.** Do not add a `status` column; it is computed at
  read time so it cannot drift from the facts.
- **Not `scm.lorries`.** This module is deliberately separate from the SCM lorry
  master (see below). It does not read or write `scm.*`.

### Relationship to `scm.lorries` — DEFERRED OWNER DECISION
The SCM Transportation subsystem already carries a lorry master (`scm.lorries`,
mig 0053/0121) with flat road-tax/insurance/puspakom expiry columns and
`scm.lorry_service_records` for repair history. Fleet Maintenance is intentionally
self-contained (own master; a vault with true renewal history + APAD +
cross-border + PUSPAKOM result/reinspection that the flat columns cannot hold).
**Reconciling the two masters is an owner call for a follow-up phase** — either
fold `scm.lorries` in (keying by plate), or make Fleet Maintenance the compliance
system of record and have SCM read it. Until then, the fleet exists in two places;
the seed script keys on plate so a later reconciliation can match.

## 6. Later-phase seams (documented, not built)

`deriveVehicleStatus()` already accepts `openWorkOrder` and `breakdownActive`;
the tables that will feed them are intentionally NOT created (no empty prod
surface nobody writes):

- `fleet_work_orders` — planned/unplanned jobs → `PLANNED_MAINTENANCE` /
  `WAITING_PARTS`, plus the "This-month repairs" + costliest-vehicle KPIs and
  the "Open problem" / "Downtime" board columns.
- `fleet_breakdown_cases` — active breakdowns → `BREAKDOWN` + downtime.
- `fleet_preventive_plans`, tyre/component tracking, mileage trip-capture.
- **Notifications**: `GET /reminders` is the computation a future scheduled job
  rides onto the app's existing announcement/notification mechanism. Phase 1
  surfaces reminders on the dashboard only (no new push channel).

## 7. See also
- `backend/src/services/fleet-status.ts` + `backend/tests/fleetStatus.test.ts`
- `backend/scripts/seed-fleet-maintenance.mjs`
- `docs/modules/delivery-tms.md`, `docs/modules/warehouses.md` (the SCM fleet side)

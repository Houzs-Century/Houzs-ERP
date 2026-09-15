# Fleet Maintenance & Compliance

The lorry compliance vault (road tax / insurance / PUSPAKOM / APAD /
cross-border), preventive-maintenance plans, daily mileage capture, breakdown
cases, maintenance work orders, and tyre/component serial lifecycle. Builds on
the existing `scm.lorries` vehicle master; used by fleet/transport admin
(desktop) and drivers (mobile mileage/breakdown capture).

## Statuses and flow

`deriveVehicleStatus()` (`backend/src/services/fleet-status.ts`) — status is
**always derived, never stored**; do not add a `status` column to
`scm.lorries`. Precedence, highest wins:

`OUT_OF_SERVICE` (a current `lorry_maintenance` window) → `COMPLIANCE_BLOCKED`
(an expired vault document, or a failed PUSPAKOM until a fresh PASS row is
appended) → `BREAKDOWN` (a CRITICAL, non-RESOLVED breakdown case) →
`WAITING_PARTS` / `PLANNED_MAINTENANCE` (an open work order in that state) →
`SERVICE_DUE` (mileage/date past a plan's or service record's target) →
`AVAILABLE`.

- **Compliance vault**: append-only, no status column — renewing INSERTs a
  new row; "current" = the latest-expiring row per `(lorry, doc_type)`.
- **Work order**: `REPORTED → DIAGNOSED → QUOTED → APPROVED → IN_REPAIR ⇄
  WAITING_PARTS → COMPLETED → VERIFIED`, plus a direct `DIAGNOSED → APPROVED`
  edge for jobs too small to quote. Only `POST /work-orders/:woId/transition`
  may move it (409 `illegal_transition` on a jump the machine refuses).
- **Breakdown case**: `OPEN → TOWING → IN_WORKSHOP → RESOLVED`. Only a
  CRITICAL, non-RESOLVED case grounds the lorry; MINOR/MAJOR are logged only.
- **Component**: `ACTIVE → REMOVED`; at most one ACTIVE component per
  `(lorry, position)` (position `NA` excluded).

## Permissions

- `fleet.read` / `fleet.write` — a flat permission via `requireHouzsPerm`,
  mounted at **top level** (`/api/fleet-maintenance`, outside `/api/scm`) —
  not gated by the coarse `scm.access` area guard.
- `scm.workshops` (the repair-vendor master) is read/written under the same
  two keys but is the one table in this module that is company-scoped.
- The lorry master itself (`scm.lorries` columns) is edited only through
  `/api/scm/lorries`, under `scm.transportation.drivers` — this module's
  pages link to "Coverage & Fleet" rather than duplicating that editor.

## Rules that must not break

- Renewals are **new rows** in the compliance vault — never `UPDATE` an
  existing row's expiry in place.
- The flat expiry columns on `scm.lorries` (`road_tax_expiry` etc.) are a
  **cache** kept in sync by the append route only — never write them
  directly elsewhere or the cache and the vault will disagree.
- `scm.lorries` is the unified vehicle master and is deliberately **not**
  company-scoped (a lorry is one lorry across companies).
- **Every other table in this module — the vault + its attachments, plans,
  mileage readings, breakdown cases, work orders + parts, components +
  events — is SHARED across companies, not per-company.** This is the
  current, owner-confirmed rule (2026-09-02: "共用的，因为 TMS 是共用的"),
  reversing an earlier fix that had scoped every write. `company_id` is
  still stamped on insert for provenance only and must never be used to
  filter a read or a write; `backend/tests/fleetMaintenanceUnifiedScope.test.ts`
  pins both halves (no shared table may be scoped, the stamp may not be
  removed).
- The **one exception** is `scm.workshops`, scoped via `scopeToCompany`
  (fails closed) — never a hand-rolled `.eq("company_id", … ?? null)`, which
  matches nothing and previously minted duplicate codes.
- A work order's total is **derived** (money legs + parts + lines), never
  stored.
- LABOUR must not be filled on both the header scalar (`labour_sen`) and a
  LABOUR-section line — adding a LABOUR line while the header scalar is > 0
  is refused (409 `labour_already_on_header`), or the repair's labour cost
  counts twice.
- A work-order line's `amount_sen`, when printed on the vendor's document,
  **wins over** the qty×unit×(1-discount%) computation — never silently
  recompute over a stated invoice figure.
- Mileage: a reading below the latest odometer is a rollback and is
  **refused** (409); an abnormal one-day jump is accepted but `flagged`,
  never silently taken; GPS distance may cross-check but is never written as
  the odometer.
- Plates are stored **canonical** (`normalizePlate`) — the lorry create/edit
  write path must always normalize before insert; do not compare or insert a
  raw plate string.
- All codes (workshop `WS-`, breakdown `BD-`, work order `WO-`, driver
  `DRV-`, helper `HLP-`, 3PL) are **minted** per company via
  `fleet-code-mint.ts`, never hand-typed; a racing create retries the mint.
- Migrations `0202` / `0203` / `0204` are merged and applied under those
  numbers — never renumber them (`pg-migrate` tracks by filename; a rename
  re-runs the SQL against an already-migrated schema).
- The work-order state list is kept identical across the state machine, the
  migration `CHECK`, and the frontend stepper — `audit:work-order-states`
  (CI) fails the build if any one drifts.

## Gotchas

- This module's own company-scope story has flipped twice — an early
  "every write is `scopeToCompany`" fix was itself reversed by the later,
  owner-confirmed "one shared fleet" ruling. Trust the **Rules** section
  above (2026-09-02), not a migration header or an older comment.
- Every drawer write handler must set a visible error on refusal — six of
  them once swallowed their rejection (`catch { /* surfaced on reload */ }`
  with nothing actually reloading), so a refused write looked like it
  succeeded.
- The Fleet Health **drawer** is a quick look ("can I use this lorry
  today?"); the full history lives on its own page, `/fleet-health/:lorryId`
  ("what is this lorry's history?"). Do not re-add history sections to the
  drawer — the page imports the drawer's section components rather than
  re-implementing them; keep it that way.
- Before adding a new route or table, check whether one already exists with
  no UI reaching it — preventive-maintenance plans, breakdown↔work-order
  linking, and manual mileage entry were each schema/route-complete for a
  release before any screen could reach them.
- Do not infer an ordering between a lorry's four dates
  (`manufacture_date`, `registration_date`, `in_service_date`,
  `purchase_date`) or add a CHECK across them — a reconditioned import can
  register long after manufacture, and none can be derived from the others.

## Where the code is

- `backend/src/scm/routes/fleet-maintenance.ts` — all routes.
- `backend/src/services/fleet-status.ts` — derived status, due/mileage/work
  order/component logic (pure, unit-tested).
- `backend/src/scm/routes/lorries.ts`, `lorry-service-records.ts` — the
  vehicle master and service-record sibling routes.
- `backend/src/scm/routes/scan-lorry-invoice.ts` — repair-document OCR
  (writes nothing).
- `frontend/src/pages/FleetHealth.tsx` — desktop board + drawer (section
  components exported for reuse).
- `frontend/src/pages/LorryRecord.tsx` — the full per-lorry record page.
- `frontend/src/mobile/MobileMileageCapture.tsx` — driver mileage +
  breakdown-report screen.
- `backend/scripts/seed-fleet-maintenance.mjs`,
  `backend/scripts/seed-fleet-plans.mjs` — idempotent seed scripts.
- `backend/scripts/check-work-order-states.mjs` — the 3-copy state-list
  audit.
- `backend/scripts/repair-lorry-plates.mjs` — canonical-plate cleanup.
- `backend/src/scm/lib/fleet-code-mint.ts`, `plate-normalize.ts` — code
  minting and plate normalization.

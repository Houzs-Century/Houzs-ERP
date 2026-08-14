# Delivery Planning + TMS — Stage 2 (Backend) build spec

**For:** the developer picking up the backend of the Delivery Planning + Driver/Helper/Lorry TMS module.
**Owner-approved** 2026-06-26 (UI mockup signed off). This is a 1:1 port of the **2990 ERP** module, adapted to Houzs conventions. Build it to mirror 2990 — do not redesign.

---

## 0. Status — what is DONE vs NOT done

| Stage | What | Status |
|---|---|---|
| **① Schema** | migration `backend/src/db/migrations-pg/0053_scm_delivery_planning_tms.sql` | **DONE — applied to prod + committed `28d061d`** |
| **② Backend** | the routes in this spec | **DONE — all 7 shipped and mounted (verified 2026-07-17)** |
| **③ Frontend** | Delivery Planning board page + separate Fleet page + Regions config + Lorry Capacity dashboard | NOT done (next stage) |
| **④ Deploy** | scoped staged deploy + sw bump | NOT done |

> **This spec is now a HISTORICAL record of stage ②, not a work order.** It said
> *"② Backend — NOT done — this is your job"* for some time after the routes had
> shipped, which is a trap for the next reader: building to it would have meant
> re-writing live code. Verified on `origin/main` 2026-07-17 — every target below
> exists and is mounted in `backend/src/scm/index.ts`:
> `delivery-planning.ts` (1449 ln), `delivery-planning-regions.ts` (301),
> `trips.ts` (393), `lorry-capacity.ts` (443), `helpers.ts` (95), `lorries.ts` (194),
> and `drivers.ts` (102, pre-existing). **Read the code, not this file.**

**The database is already built and live.** You do NOT write any migration. Every table/column below already exists in the `scm` schema in prod. Just build the routes that read/write them.

---

## 1. Source of truth — mirror these 2990 files

Repo: **`wenwei4046/2990s`** (local clone at `C:\Users\User\Desktop\2990s`). Read each file with `git -C C:\Users\User\Desktop\2990s show HEAD:<path>`.

| 2990 route file | Houzs target file | Mount path |
|---|---|---|
| `apps/api/src/routes/delivery-planning.ts` (1331 ln) | `backend/src/scm/routes/delivery-planning.ts` | `/delivery-planning` |
| `apps/api/src/routes/delivery-planning-regions.ts` (291 ln) | `backend/src/scm/routes/delivery-planning-regions.ts` | `/delivery-planning-regions` |
| `apps/api/src/routes/trips.ts` (371 ln) | `backend/src/scm/routes/trips.ts` | `/trips` |
| `apps/api/src/routes/lorry-capacity.ts` (436 ln) | `backend/src/scm/routes/lorry-capacity.ts` | `/lorry-capacity` |
| `apps/api/src/routes/helpers.ts` | `backend/src/scm/routes/helpers.ts` | `/helpers` |
| (2990 lorries CRUD — see lorry-capacity / a lorries route) | `backend/src/scm/routes/lorries.ts` | `/lorries` |
| `apps/api/src/routes/drivers.ts` | **already exists in Houzs** — only add `in_house` | (existing) |

All routes are Hono routers. **Copy the structure of an existing Houzs scm route** (e.g. `backend/src/scm/routes/delivery-orders-mfg.ts`) for the boilerplate: the Hono app, `const sb = c.get('supabase')`, `const user = c.get('user')`, error JSON shape, etc. The 2990 routes use the IDENTICAL pattern, so the port is mostly: copy 2990 file → fix imports → confirm table/column names → done.

---

## 2. Available schema (already in prod — do not re-create)

New `scm` tables: `helpers`, `lorries`, `trips`, `trip_stops`, `lorry_maintenance`, `delivery_legs`, `delivery_order_crew`, `delivery_planning_regions`, `state_delivery_regions`.
Extended: `scm.drivers` (+`in_house bool`).
New cols on `scm.mfg_sales_orders`: `delivery_state` (enum), `possession_date`, `house_type`, `replacement_disposal`, `referral`, `amend_date_from_customer`, `amended_delivery_date`, `amend_reason`.
New cols on `scm.delivery_orders`: `delivery_state` (enum), `time_range`, `time_confirmed`, `arrival_at`, `departure_at`, `shipout_date`, `customer_delivered_date`, `eta_arriving_port`, `delivery_substatus`, `arrives_em_warehouse_date`.

Enums: `scm.delivery_state` = `PENDING_DELIVERY | PENDING_SCHEDULE | OVERDUE | DELIVERED`; `scm.lorry_type`; `scm.delivery_leg_kind` (`transit|final`); `scm.delivery_leg_source` (`SO|DO`); `scm.trip_type`; `scm.trip_status`; `scm.trip_stop_type`.

Seeded regions (`scm.delivery_planning_regions`, editable in the Regions UI): `SELANGOR, KL, NORTHERN, SOUTHERN, EAST_COAST, EAST_MY`. 21 rows in `scm.state_delivery_regions` map each MY state name → a region. Region bucketing is **by `mfg_sales_orders.customer_state`** (the state NAME).

For exact column types/defaults, read `0053_scm_delivery_planning_tms.sql`.

---

## 3. The endpoints to build

### 3a. `delivery-planning.ts` → mount `/delivery-planning` (the board — most important)

| Method · path | Purpose | Key logic (mirror 2990) |
|---|---|---|
| `GET /` | The planning board data. Returns the orders bucketed by delivery_state + region, with crew/legs/days-left. | Read SO + DO from the **BASE tables** (`mfg_sales_orders`, `delivery_orders`) — NOT the payment-totals view (see §4 view-trap). Derive `delivery_state` (see below), region via `state_delivery_regions` lookup on `customer_state`, `days_left`/OVERDUE from the **effective delivery date** = `amended_delivery_date ?? customer_delivery_date`. Join `delivery_order_crew` + `delivery_legs`. Supports `?state=` / `?region=` filters. |
| `POST /legs` | Add a delivery leg (a multi-region trip hop for one order). | Insert into `scm.delivery_legs` (source_type SO/DO, source_id, leg_no, warehouse_id, leg_date, leg_kind). |
| `PATCH /legs/:id` | Edit a leg. | Update `scm.delivery_legs`. |
| `DELETE /legs/:id` | Remove a leg. | Delete from `scm.delivery_legs`. |
| `PATCH /:type/:id/fields` | Edit the HC raw-data fields. `:type` ∈ `so|do`. | `so` → update the HC SO cols on `mfg_sales_orders`; `do` → update the HC DO cols on `delivery_orders`. Whitelist `house_type` / `delivery_substatus` values in code (they are free TEXT in the DB). |
| `PATCH /:type/:id/schedule` | The "schedule" action — set the firm delivery date + crew. | **Write `amended_delivery_date`, NEVER `customer_delivery_date`** (the original customer pick is an audit anchor — see 2990 mig 0199). Set `delivery_state`. May upsert `delivery_order_crew`. |

**`delivery_state` derivation (mirror 2990's `GET /` exactly):**
- `DELIVERED` — the DO/SO is delivered (customer_delivered_date set, or DO status DELIVERED).
- `OVERDUE` — effective delivery date < today AND not delivered.
- `PENDING_SCHEDULE` — no firm trip/crew assigned yet (not scheduled).
- `PENDING_DELIVERY` — scheduled (crew/trip assigned, effective date today/future) but not yet delivered.

(The DB column `delivery_state` can be derived live OR persisted by the schedule action — 2990 derives it in the route. Follow 2990.)

**Convert-to-DO (single + multi-select):** the board lets the operator cut a DO from one or more SO lines. Reuse the existing Houzs `POST /delivery-orders-mfg/from-sos` endpoint (it already exists) — the board just calls it with the picked SO line ids. Do NOT rebuild DO creation.

### 3b. `delivery-planning-regions.ts` → mount `/delivery-planning-regions` (Regions config CRUD)

| Method · path | Purpose |
|---|---|
| `GET /` | List regions (`scm.delivery_planning_regions`, ordered by sort_order). |
| `POST /` | Create a region (code, name, sort_order). |
| `PATCH /:id` | Edit a region (name/sort_order/active). |
| `DELETE /:id` | Delete a region (CASCADE drops its state mappings). |
| `GET /states` | List all state→region mappings (`scm.state_delivery_regions`). |
| `GET /states/:stateKey` | The region(s) a given state maps to. |
| `PUT /states/:stateKey` | Replace a state's region set (multi — one state can map to several regions). |

### 3c. `trips.ts` → mount `/trips` (scheduling layer)

| Method · path | Purpose | Note |
|---|---|---|
| `GET /` | List trips (filter by date/lorry/status). | |
| `GET /:id` | Trip detail + its `trip_stops`. | |
| `POST /` | Create a trip. | **Mint `trip_no` = `TRIP-YYMM-NNN`** via the Houzs monthly doc-no minter (**max+1**, never count+1 — use the same helper the other scm docs use). Set `is_outsourced = NOT lorry.is_internal` snapshot at create time. |
| `PATCH /:id` | Edit trip (lorry/driver/helpers/date/notes). | |
| `PATCH /:id/status` | Advance trip status (PLANNED→IN_PROGRESS→COMPLETED / CANCELLED). | clock_in_at/clock_out_at on transitions. |
| `POST /:id/stops` | Add a stop (links a DO or SO + revenue_centi). | revenue_centi = the order's local_total_centi at scheduling time. |
| `DELETE /:id/stops/:stopId` | Remove a stop. | |
| `DELETE /:id` | Delete a trip (legs orphan back to unplanned via ON DELETE SET NULL). | |

### 3d. `lorry-capacity.ts` → mount `/lorry-capacity` (performance dashboard)

| Method · path | Purpose |
|---|---|
| `GET /` | The aggregation: per-lorry utilisation, trips, stops/orders per trip, revenue per trip, **In-house vs Outsource split**, repair days (from `lorry_maintenance`). Mirror 2990's aggregation query exactly. |
| `PATCH /lorries/:id/in-house` | Toggle a lorry in-house ↔ outsource (`lorries.is_internal`). |
| `PUT /lorries/:id/repair-days` | Set/replace a lorry's maintenance (unavailable_from/to) windows in `lorry_maintenance`. |

### 3e. Fleet master CRUD — `helpers.ts` + `lorries.ts` (drivers already exists)

Standard CRUD each (`GET /` list, `POST /` create, `PATCH /:id` edit, `DELETE /:id` or soft `active=false`):
- **`helpers`** — `scm.helpers` (helper_code, name, contact, ic_number, in_house, active). Mirror 2990 `helpers.ts`.
- **`lorries`** — `scm.lorries` (plate, type, is_internal, warehouse_id, capacity_m3/kg, active, notes). Mirror 2990's lorries CRUD.
- **`drivers`** — already exists in Houzs scm. Only ADD the `in_house` field to its create/edit payload + responses (the column now exists).

---

## 4. CRITICAL conventions & gotchas (read before coding)

1. **VIEW-TRAP (read `docs/api-fetch-hardening-coe.md` + the 2990 `docs/2026-06-26-so-list-view-trap-coe.md` [external]).** The SO list reads a **column-enumerated view** `scm.mfg_sales_orders_with_payment_totals` (94 cols, frozen at creation). The new SO cols (`delivery_state`, HC fields, amend dates) are deliberately **NOT** in that view. **NEVER add any of them to the shared SO-list `HEADER` select constant in `mfg-sales-orders.ts`** — doing so 500s the entire Sales Orders list. The planning board + SO detail read these straight off the BASE table `mfg_sales_orders`. (Add a guard comment on that HEADER constant noting this.) This is why stage ① did NOT recreate the view — keep it that way.
2. **Backend lives in `backend/src/scm/` — never `apps/api`.** Mount every new router in `backend/src/scm/index.ts` (find where the other routes are `app.route('/...', x)` and add yours: `/delivery-planning`, `/delivery-planning-regions`, `/trips`, `/lorry-capacity`, `/helpers`, `/lorries`).
3. **supabase-js, schema-scoped to `scm`.** `c.get('supabase')` returns the scm-scoped client, so `.from('trips')` = `scm.trips`. snake_case columns (no camelCase transform). Mirror the existing scm routes.
4. **Identity:** the scm auth middleware maps every caller to the system staff id (there is no per-user scm identity). `created_by`/`assigned_by` columns are plain UUID — set them to the system staff id (or leave null), same as the other scm docs. Do not block on per-user attribution.
5. **Doc-no minting (trips):** `TRIP-YYMM-NNN` via the existing Houzs monthly minter — **max(existing)+1**, never `count+1` (the count+1 bug class). Reuse the same helper `trips`' siblings use; do not hand-roll.
6. **Never overwrite `customer_delivery_date`.** The schedule action writes `amended_delivery_date`. The effective date for OVERDUE/days-left is `amended_delivery_date ?? customer_delivery_date`.
7. **Region fallback:** if a `customer_state` has no row in `state_delivery_regions`, bucket it into a sensible default (e.g. first/SELANGOR) or an "Unassigned" group — do not drop the order. Mirror 2990's fallback (it defaulted unmapped → KL).
8. **Migrate-before-deploy is already satisfied** (0053 is live). So you can deploy the backend whenever it's ready.
9. **English-only UI strings** (Houzs admin rule). Comments may be anything; user-facing text is English.
10. **No back-door data inserts.** Build the real endpoints; do not seed business rows by hand.

---

## 5. Verification (acceptance criteria)

- `cd backend && npx tsc --noEmit` is **green**.
- Smoke each route with a minted session token (mirror how the other scm routes are smoke-tested): `GET /api/scm/delivery-planning` 200; create a helper/lorry; create a trip (check `TRIP-YYMM-NNN`); `GET /api/scm/lorry-capacity` 200.
- **Regression-critical:** after deploy, open the **Sales Orders list** in the browser — it must still load (proves the view-trap was respected). If it shows "Failed to load", a new SO col leaked into the view-backed HEADER — revert that.
- Confirm `delivery_state` derivation matches 2990 on a few sample orders (one overdue, one scheduled, one delivered).

---

## 6. Deploy (stage 4 — after FE too, or backend-first)

Houzs prod = push to `main` (auto-deploys the `autocount-sync-api` worker + the Pages frontend). **Deploy discipline (important):** the local main tree lags `origin/main`; build in an isolated worktree from `origin/main`, apply ONLY your changed files, and capture the deploy diff **path-scoped** (`git diff origin/main -- <your files>`) — never a bare `git diff origin/main` (it reverts other people's work). Backend-only change needs no `sw.js` bump; any frontend change must bump `frontend/public/sw.js` VERSION once. Do not burst-deploy (churns the PWA service-worker cache).

---

*Schema (stage 1) is live; this spec is the backend (stage 2). Frontend (stage 3) mirrors the approved mockup: a Delivery Planning board (status tabs + region-by-state chips + DO table + expandable SO lines) and a SEPARATE Fleet page (Drivers/Helpers/Lorries tabs + in-house/outsource performance) — Fleet is its own nav item, NOT under the planning board.*

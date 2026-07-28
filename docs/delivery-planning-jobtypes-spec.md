# Delivery Planning — Seven Job Types on One Fleet (DP‑Order completion spec)

- **Status:** DRAFT for owner review (not started). Author: Claude, 2026‑07‑21.
- **Owner scope (Nico, 2026‑07‑20):** the Delivery Planning board must plan **seven fleet job types** that all compete for the same drivers/helpers/lorries: Delivery order, Setup project, Dismantle project, Supplier pickup, ASSR delivery, ASSR pickup, ASSR inspection.
- **Resolved decision (Nico, 2026‑07‑21):** *ASSR inspection = an on‑site inspection **visit** (a fleet job), gated to `inspection_by = 'own'` (we don't dispatch our fleet for a supplier‑done inspection).*
- **Precedent:** this continues the DP‑Order work spec'd 2026‑07‑18 (`scm.dp_orders`, mig 0129). It is **not** greenfield.
- All file/line references are **as of 2026‑07‑21** (clone HEAD `7426ce31`); verify against current `main` before editing — this repo moves fast.

---

## 1. Why this spec exists

The task reads as "build delivery planning," but the board and a **DP‑Order spine already exist and are ~60% done**. The real work is **finishing + unblocking** what's there and adding the one missing job type (INSPECTION). This spec records the verified current state so nobody re‑investigates, then lays out a phased plan.

---

## 2. Current state (verified 2026‑07‑21)

| # | Job type | Source master | Model | On board? | Schedulable? |
|---|---|---|---|---|---|
| 1 | Delivery order (SO/DO) | `scm.mfg_sales_orders` / `scm.delivery_orders` | A (native) | ✅ | ✅ (mints DP# onto `trip_stops`) |
| 2 | ASSR delivery | `assr_cases.do_date` | A (native) | ✅ | ✅ (date write‑back; no trip/crew yet) |
| 3 | ASSR pickup | `assr_cases.customer_pickup_at` | A (native) | ✅ | ✅ (date write‑back; no trip/crew yet) |
| 4 | Setup project | `public.projects` (via manual DP order) | B (`dp_orders`) | ⚠️ surfaces as a `dp` row | ❌ **no UI to schedule** |
| 5 | Dismantle project | `public.projects` (via manual DP order) | B (`dp_orders`) | ⚠️ | ❌ **no UI to schedule** |
| 6 | Supplier pickup | `scm.suppliers` (via manual DP order) | B (`dp_orders`) | ⚠️ | ❌ **no UI to schedule** |
| 7 | **ASSR inspection** | — | — | ❌ **does not exist** | ❌ |

### The three gaps

1. **DP orders cannot be scheduled from anywhere in the UI (most critical).** `POST /api/scm/dp-orders/:id/schedule` is fully implemented (mints the DP#, sets `SCHEDULED`, wires a `trip_stop`) — `backend/src/scm/routes/dp-orders.ts:347‑425` — but **has no frontend caller** (`frontend/src/vendor/scm/lib/delivery-planning-queries.ts` has `useCreateDpOrder`/`useCancelDpOrder` but **no** `useScheduleDpOrder`). The board's own schedule hook `useScheduleDelivery` targets `/delivery-planning/:type/:id/schedule`, which hard‑rejects anything but `so|do|assr` (`delivery-planning.ts:1548`). **Net effect:** Setup / Dismantle / Supplier‑pickup rows land as *Pending Schedule* and can never be scheduled or numbered by a user. The board even tells the operator to "schedule it from the DP Order" — a surface that does not exist (`DeliveryPlanning.tsx` DP cells, ~217‑226 / 256‑258).
2. **INSPECTION does not exist as a job type.** `scm.trip_stop_type` = `DELIVERY, PICKUP, SERVICE, SETUP, DISMANTLE` (`migrations-pg/0053…tms.sql:33`) + `SUPPLIER_PICKUP` (`0128`). The ASSR union keys only off `customer_pickup_at` / `do_date` (`delivery-planning.ts:991, 1014‑1016`). `assr_cases.qc_receipt_date` (office QC, mig `0062`) and `inspection_by` (mig `0073` / D1 `110`) exist but are never surfaced as a fleet job.
3. **Everything non‑SO is hand‑entered.** Setup/Dismantle are **not** auto‑sourced from the PMS `projects` setup/dismantle windows (columns `setup_start_at`, `setup_driver_user_id`, `setup_lorry_id`, `dismantle_*` all exist, unused by the board). Supplier‑pickup is **not** sourced from POs. Reaching the board = a human typing a source id into `NewDpOrderDrawer`.

### Known trap to preserve
The DP union **suppresses** any `dp_order` carrying `so_doc_no` / `assr_case_id` / `do_id` (`delivery-planning.ts:1123`, comment `1108‑1114`) so it can't double‑count a job already represented by its native SO/DO/ASSR row. Consequence: creating a `DELIVERY`/`PICKUP`/`SERVICE` DP order the "intended" way (with a source ref) makes it **silently vanish**. See P3.

---

## 3. Architecture — one board, two models (keep the hybrid)

Do **not** refactor the working SO/DO/ASSR delivery path into `dp_orders`. Keep the intentional hybrid:

- **Model A — native direct union + write‑back.** The board reads the source table directly and synthesizes a row; scheduling writes a date back to the source (and, for SO/DO, mints a DP# onto a `trip_stop`). Used by: **SO/DO, ASSR pickup, ASSR delivery, and (new) ASSR inspection.**
- **Model B — `dp_orders` spine.** For "extra" fleet jobs that have **no** native order document: **Setup, Dismantle, Supplier pickup.** A `dp_orders` row snapshots the party from its master (`dp-party.ts`); scheduling mints the DP# and wires a `trip_stop` (`dp-orders.ts:347‑425`).

**DP number is already unified.** `mintNextDpNo` scans **both** `dp_orders` and `trip_stops` (mig `0137` added `trip_stops.dp_no`), so a Model‑A SO/DO schedule and a Model‑B DP schedule draw from one `DP‑YYMMDD‑<plate><NN>` space with no collisions (`dp-orders.ts:362‑366`).

Rationale: minimal disruption to a live prod board, one DP# space, one board union. INSPECTION follows Model A because it is an ASSR leg exactly like pickup/delivery.

---

## 4. Target behaviour per job type

| Job type | Model | Board source | Schedule action | DP# |
|---|---|---|---|---|
| Delivery order | A | SO/DO union (unchanged) | `useScheduleDelivery('so'|'do')` | ✅ existing |
| ASSR delivery | A | `assr_cases.do_date` (unchanged) | `useScheduleDelivery('assr', jobKind:'delivery')` | via trip (P3) |
| ASSR pickup | A | `assr_cases.customer_pickup_at` (unchanged) | `useScheduleDelivery('assr', jobKind:'customer_pickup')` | via trip (P3) |
| **ASSR inspection** | A | `assr_cases.inspection_visit_at` **(new)**, gated `inspection_by='own'` | `useScheduleDelivery('assr', jobKind:'inspection')` **(new)** | via trip (P3) |
| Setup | B | `dp_orders` (project‑sourced) | `useScheduleDpOrder` **(new, P0)** | ✅ at schedule |
| Dismantle | B | `dp_orders` (project‑sourced) | `useScheduleDpOrder` **(new, P0)** | ✅ at schedule |
| Supplier pickup | B | `dp_orders` (supplier‑sourced) | `useScheduleDpOrder` **(new, P0)** | ✅ at schedule |

---

## 5. Phased plan

### P0 — Unblock DP scheduling  ·  highest ROI, backend already done  ·  ~0.5–1 day  ·  frontend‑only

Make the three built‑but‑dead job types (Setup/Dismantle/Supplier‑pickup) schedulable end‑to‑end by wiring the UI to the **existing** endpoint.

**Backend contract (already implemented — do not rebuild):**
`POST /api/scm/dp-orders/:id/schedule`, body `{ lorryId: uuid (required), tripDate: 'YYYY-MM-DD' (required), tripId?: uuid }` → mints `dp_no` from lorry plate + date, sets `status='SCHEDULED'`, and (when `tripId` given) inserts a `trip_stop` (`stop_type = job_type`). Returns `{ dpOrder, dp_no, tripStop:{ id, failed, reason? } }`. A header‑only schedule (no `tripId`) is valid.

**Changes:**
1. `frontend/src/vendor/scm/lib/delivery-planning-queries.ts` — add `useScheduleDpOrder`:
   ```ts
   // mutationFn: POST /dp-orders/:id/schedule  { lorryId, tripDate, tripId? }
   // onSuccess: qc.invalidateQueries({ queryKey: ['delivery-planning'] })
   // surface result.tripStop.failed via serviceNotify (mirror useScheduleDelivery's
   // onError — a wiring failure must never look like success)
   ```
2. `frontend/src/pages/scm-v2/DeliveryPlanning.tsx` — for `row_type === 'dp'` && `delivery_state === 'PENDING_SCHEDULE'`, add a **"Schedule…"** row action next to the existing "Cancel job" (context menu ~1323‑1324). It opens a small dialog:
   - **Lorry** select (from `lorries-queries.ts`), **Trip Date**, optional **Trip** (from `trips-queries.ts`).
   - Submit → `useScheduleDpOrder`. On `tripStop.failed`, toast the reason.
3. Verify the DP row's `delivery_state` derivation maps `dp_orders.status='SCHEDULED'` → a sensible board state (e.g. `PENDING_DELIVERY`) in the DP union (`delivery-planning.ts` ~1121+).

**Design note (chosen):** call the purpose‑built `/dp-orders/:id/schedule` directly (Option A). *Alternative rejected:* extending `/delivery-planning/:type/:id/schedule` to accept `'dp'` (Option B) unifies the hook but needs backend changes to a live endpoint and a payload reshape (that endpoint find‑or‑creates a trip from `driverId/lorryId/tripDate`; the DP endpoint takes `lorryId/tripDate/tripId`) — not worth the risk for P0.

**Acceptance:** create a Setup DP order → it shows *Pending Schedule* → Schedule with a lorry + date → it receives a `DP‑…` number, flips to scheduled, and (with a trip) appears as a stop on that trip. Cancel removes the stop.

### P1 — INSPECTION (on‑site visit, own‑only)  ·  ~1 day  ·  DB + backend + frontend

Add the missing 7th type as a Model‑A ASSR leg.

**DB (respect the D1‑vs‑PG split — `assr_cases` is mirrored in both):**
- `backend/src/db/migrations/127_assr_inspection_visit.sql` (**D1 test mirror**): `ALTER TABLE assr_cases ADD COLUMN inspection_visit_at TEXT;` (match `customer_pickup_at`'s type from `107`).
- `backend/src/db/migrations-pg/0140_assr_inspection_visit.sql` (**prod PG**): `ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_visit_at DATE;` (match `customer_pickup_at`'s PG type from `0064`).
- `backend/src/db/migrations-pg/0165_scm_trip_stop_type_inspection.sql` (**PG enum** — SHIPPED; drafted here as `0141`/renumbered `0158`, landed as `0165` after main's numbering advanced): `ALTER TYPE scm.trip_stop_type ADD VALUE IF NOT EXISTS 'INSPECTION';` (mirror `0128`). The P3 trip wiring itself landed via `0166_scm_trip_stops_assr_case.sql` + PR #947. *(The D1 mirror models `trip_stops.stop_type` as a CHECK constraint listing values — extend it too only if a test exercises an INSPECTION stop.)*

**Backend — `backend/src/scm/routes/delivery-planning.ts` (ASSR union + schedule):**
- ASSR union SELECT (~984‑991): add `inspection_visit_at` and `inspection_by` to the selected columns; extend the `WHERE (customer_pickup_at IS NOT NULL OR do_date IS NOT NULL)` with `OR (inspection_visit_at IS NOT NULL AND inspection_by = 'own')`.
- Leg builder (~1014‑1016): `if (a.inspection_visit_at && a.inspection_by === 'own') legs.push({ jobKind: 'inspection', date: a.inspection_visit_at });`
- Schedule zod (`jobKind`, ~1512): add `'inspection'` to the enum.
- Schedule write‑back column (~1567‑1570): `const col = p.jobKind === 'customer_pickup' ? 'customer_pickup_at' : p.jobKind === 'inspection' ? 'inspection_visit_at' : 'do_date';`

**Frontend — `delivery-planning-queries.ts` + board:**
- `AssrJobKind` (line 44): add `'inspection'` → `'customer_pickup' | 'delivery' | 'inspection'`. `ScheduleDeliveryVars.jobKind` picks it up automatically.
- Board: render an "Inspection" job chip/label for the inspection leg; allow scheduling it through the existing ASSR inline schedule path.
- (Optional) add `INSPECTION` to `DP_JOB_TYPES` + `DP_JOB_TYPE_LABEL` only if a **manual** DP inspection order is also wanted; the primary path is the ASSR leg.

**Where does `inspection_visit_at` get set?** It needs a writable date on the ASSR case (service‑case detail form) so a coordinator can set the visit date. Confirm the exact UI slot when implementing (likely alongside `customer_pickup_at` on the ASSR logistics section).

**Acceptance:** an ASSR case with `inspection_by='own'` and an `inspection_visit_at` shows a third **Inspection** row on the board, schedulable to a date; `inspection_by='supplier'` shows no inspection row.

### P2 — Auto‑sourcing (stop hand‑typing ids)  ·  ~2–3 days (excl. PO)

- **Setup / Dismantle from PMS projects (Model A direct union).** Union the projects' setup/dismantle windows onto the board directly (read `projects.setup_start_at` / `setup_driver_user_id` / `setup_lorry_id` and the `dismantle_*` equivalents), the same way the ASSR union reads `assr_cases`. Show the already‑assigned crew/lorry. This removes the hand‑created DP order for the common case; keep the manual DP‑order path for ad‑hoc project jobs. **Open decision:** where a board‑side schedule edit writes back — to the project's setup/dismantle fields, or PMS stays the owner and the board is a read‑only mirror. Recommend: write back to the project fields (single source), gated by PMS `SETUP_DISMANTLE` permission.
- **Supplier pickup from POs.** ⚠️ **Blocked on AutoCount** — PO/creditors are not restored (see memory `houzs-autocount-sync-disabled`). Keep manual DP‑order supplier pickups until PO data is back, then source pending supplier pickups from open POs.

### P3 — Cleanup & true "one fleet"

- **Fix the data sink.** `DELIVERY`/`PICKUP`/`SERVICE` DP orders carrying a source ref vanish under the union guard (`delivery-planning.ts:1123`). Simplest fix: **remove those three from the `NewDpOrderDrawer` create dropdown** (they're already covered by native SO/DO/ASSR rows), leaving the drawer to `SETUP`/`DISMANTLE`/`SUPPLIER_PICKUP` (+ optional manual `INSPECTION`). Keep the enum full; only the create UI narrows.
- **ASSR trip/crew wiring.** Today ASSR legs (pickup/delivery/inspection) set a date only — **no trip/crew, so they don't consume fleet capacity** (`delivery-planning.ts:1560‑1561`). Extend the ASSR schedule path to find‑or‑create a trip + append a stop (as SO/DO already do), so the board is a true single fleet schedule. This is the biggest lever toward Nico's "one fleet, one schedule" and could be pulled earlier if capacity accuracy matters.
- **Drawer picker/prefill.** Replace the raw‑id text box with a searchable picker (SO / supplier / project) + live party preview (`NewDpOrderDrawer.tsx` currently takes a free‑text id, no prefill).
- **(Optional) DP‑Order list page.** `GET /api/scm/dp-orders` has no consumer; a simple list makes unscheduled/hidden DP orders reachable outside the board.

---

## 6. Decisions

**Resolved**
- ASSR inspection = on‑site **visit**, fleet job, gated `inspection_by='own'`. ✔ (Nico 2026‑07‑21)
- Keep the **hybrid** (Model A for SO/DO/ASSR, Model B for the 3 extra types) — no full `dp_orders` unification. ✔ (recommended, low‑risk)
- P0 uses the existing `/dp-orders/:id/schedule` (Option A). ✔

**Open (need Nico when we reach them)**
- P2 setup/dismantle write‑back target: project fields vs PMS‑owned read‑only mirror.
- P2 supplier‑pickup PO sourcing: gated on AutoCount PO restore.
- P3: confirm removing `DELIVERY`/`PICKUP`/`SERVICE` from the create dropdown (vs keeping a smarter guard).

---

## 7. Out of scope / separate threads
- **Farra historical ASSR import** (`backend/scripts/import-assr-farra.mjs`, `assr-farra-mapping.md`, untracked in the tree) — a data backfill of 746 historical service cases; unrelated to this planning work. Its "phase 2" logistics columns could later feed inspection/pickup history, but not part of this spec.
- Full migration of SO/DO deliveries into `dp_orders` (explicitly rejected in §3).
- `scm.delivery_legs` multi‑hop (China‑PO transit) — dormant, unused.

---

## 8. Open‑questions checklist (tick, then tell Claude "spec ready")
- [ ] P0 scope OK: schedule dialog = **Lorry + Trip Date + optional Trip**? (or must it always require a Trip?)
- [ ] P1: is `inspection_visit_at` set on the **ASSR case detail** form (next to `customer_pickup_at`)? Any other place?
- [ ] P1: should a **manual** `INSPECTION` DP order also exist, or ASSR‑leg only? (default: ASSR‑leg only)
- [ ] P2: setup/dismantle board edits write back to **project fields** (recommended) or PMS stays owner?
- [ ] P3: OK to drop `DELIVERY`/`PICKUP`/`SERVICE` from the New‑DP‑Order dropdown?
- [ ] Sequence confirm: **P0 → P1 → P2 → P3** (each shippable via `main`, own PR)?

---

## Appendix A — key file index (verify vs current `main`)

| Concern | File | Anchor |
|---|---|---|
| DP‑order route (create/list/patch/cancel/**schedule**) | `backend/src/scm/routes/dp-orders.ts` | schedule `347‑425`, create `189‑231` |
| DP party auto‑fill | `backend/src/scm/lib/dp-party.ts` | `snapshotFrom{So,Supplier,Project,Assr}` |
| DP number mint (shared registry) | `backend/src/scm/lib/dp-no-mint.ts` | `mintNextDpNo`, `plateForLorry` |
| `dp_orders` table | `backend/src/db/migrations-pg/0129_scm_dp_orders.sql` | full |
| Board assembly (SO/DO/ASSR/DP union, schedule PATCH) | `backend/src/scm/routes/delivery-planning.ts` | ASSR `950‑1145`, DP `1109‑1205`, schedule `1498‑1600`, guard `1123`, SO/DO mint `~1831` |
| TMS schema + enums | `backend/src/db/migrations-pg/0053_scm_delivery_planning_tms.sql` | `trip_stop_type` `33` |
| Board hooks (queries/mutations) | `frontend/src/vendor/scm/lib/delivery-planning-queries.ts` | `useScheduleDelivery` `354`, `useCreate/CancelDpOrder` `304/314`, `DP_JOB_TYPES` `264` |
| Board page | `frontend/src/pages/scm-v2/DeliveryPlanning.tsx` | DP cells `217‑226/256‑258`, ctx menu `1323‑1324`, New‑DP button `1109` |
| New‑DP drawer | `frontend/src/vendor/scm/components/NewDpOrderDrawer.tsx` | source‑kind dropdown |
| ASSR inspection fields | `migrations-pg/0073` (`inspection_by`) · D1 `110`; `0062` (`qc_receipt_date`) · D1 `105` |

## Appendix B — migration numbering (next free)
- STALE SNAPSHOT (2026-07-18) — the numbers below were "next free" when this spec was written and are long taken. What shipped: `0140_assr_inspection_visit`, and the INSPECTION enum as **`0165`** (not `0141` — renumbered twice as main advanced), with `0166_scm_trip_stops_assr_case` for the P3 trip wiring. Always take the next free number at implementation time; never trust a spec's snapshot.
- D1 test mirror `backend/src/db/migrations/`: next = **127**.
- Prod PG `backend/src/db/migrations-pg/`: next = **0140** (then `0141` for the enum).

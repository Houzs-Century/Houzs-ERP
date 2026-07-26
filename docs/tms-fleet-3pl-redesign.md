# TMS / Fleet / 3PL redesign — design + workstreams

**Date:** 2026-07-26 · **Owner decisions captured in chat, this session.**

This is the design of record for a batch of owner-driven changes to the
Transportation module: navigation cleanup, crew leave, per-lorry region + box
dimensions, and a proper 3PL-company layer with company-scoped rate cards. It is
split into four independently-shippable workstreams (WS1–WS4). WS1 has shipped;
the rest are queued.

Read `docs/modules/delivery-tms.md` before touching any of this — update it in
the same PR that changes a module surface (owner rule).

---

## Owner decisions (locked)

| Question | Decision |
|---|---|
| Rate Card basis | **Per 3PL company** — a solo operator is a one-lorry company. Not per-lorry. |
| Cross-region ("outstation") surcharge | **Both**: a per-**trip** fixed outstation base fee (by destination state) **plus** an optional per-**order** surcharge on top. |
| Minimum charge | **Not doing it** for now — pure item/set pricing. |
| Setup & Dismantle | **Uniform flat per company** (one setup fee, one dismantle fee; not per item). |
| Residence types | Already **API-driven** (mig 0196, `/delivery-residence-rules`, full CRUD). No change needed — confirmation only. |
| Crew Leave scope | **Anyone in the Driver list OR Helper list.** Storekeepers are already in the Helper list (storekeeper = helper), so they are covered automatically. No special-casing. |

### Fleet vs Fleet Health — the distinction the owner asked about

Both surfaces have "record" affordances, which confused the owner. They are not
duplicates:

- **Fleet** (`/scm/fleet`, `Fleet.tsx` + `LorryDetail.tsx` drawer) = the
  **registry / record**. Add a lorry; edit its compliance dates, purchase,
  capacity; log each workshop visit. One lorry at a time.
- **Fleet Health** (`/fleet-health`, `FleetHealth.tsx`) = the **read-only
  board**. It reads every lorry's data and surfaces what needs attention across
  the whole fleet (expiring docs, breakdowns, open work orders, service due).

WS1 makes this legible in the nav: Fleet Health sits up top as the daily board;
Fleet is filed under Maintenance as the registry.

---

## WS1 — Nav reorg (SHIPPED)

Pure `Sidebar.tsx` NAV_TABS change, no DB/route change.

Transportation group is now:

```
Delivery Planning
Auto-Schedule
Trips
Fleet Map
Fleet Health          (pulled up from a former top-level item; keeps fleet.read)
Lorry Capacity
Driver Leave          (renamed to "Crew Leave" in WS2 when it covers helpers)
Maintenance  (fold, groupId scm-transportation-maintenance)
    Regions
    Residence Rules
    Fleet             (the lorry/driver/helper registry)
    Delivery Zones
    Rate Cards
```

Verified: `tsc --noEmit` clean; `navFilter.test.ts` + `routeManifestDrift.test.ts`
green (the mounted `/fleet-health` route is unchanged — only its nav entry moved).

---

## WS2 — Crew Leave (driver + helper)

**Goal:** leave applies to drivers AND helpers; an on-leave person is removed
from that day's trip assignment picker automatically (not merely de-prioritised
in AUTO).

- **Data:** generalise `scm.driver_leave` (mig 0206) to reference either a driver
  or a helper — add a `crew_kind` ('driver' | 'helper') + keep the id, or a
  nullable `helper_id` alongside `driver_id`. Decide at build time; prefer a
  single `crew_kind` + `crew_id` to keep the availability query uniform.
- **Backend:** `driver-leave.ts` route accepts helpers; the availability
  exclusion (`driver-availability.ts` / `fleet-assign.ts`) must also drop
  on-leave helpers.
- **Trip picker:** the assignment screen's driver/helper dropdowns must **filter
  out** on-leave people for the selected date (today the copy says "AUTO pick
  only — dispatcher can override"; owner wants them gone from the list). Confirm
  whether a hard filter or a disabled+labelled option — owner said "名字自动被
  移除" = removed, so hard-filter, but keep an explicit "on leave" affordance so
  it is not silently missing.
- **Nav/label:** rename "Driver Leave" → "Crew Leave".
- **Members rule:** check `Positions.tsx` / members config for who qualifies as a
  driver/helper before wiring the picker source.

---

## WS3 — Lorry region + box dimensions → auto capacity

**Goal:** each lorry has a region (warehouse) and L×W×H; the box auto-computes a
volumetric ceiling; dispatch only offers lorries whose region matches the trip.

- **Region:** `scm.lorries.warehouse_id` already exists (the region = warehouse
  KL/PG model). Make it **editable in the `LorryDetail` drawer** (today it is
  only set on create). Then **region-gate lorry selection** in dispatch/assign so
  a KL trip only lists KL lorries. Source of truth: warehouse_id.
- **Dimensions → cap:** add `length_ft`, `width_ft`, `height_ft` to
  `scm.lorries`; compute Cap(m³) = L×W×H(ft) × 0.0283168, shown as
  "auto-calculated from L×W×H" (mirror the HookkaERP pattern the owner referenced).
  Feed this into the capacity ceiling alongside the existing `max_sets` /
  `max_revenue_centi` / `capacity_layer` (mig 0205) — add a `volume` layer option.
- **Drawer:** the `LorryDetail` "Delivery capacity" edit block gains region +
  L/W/H fields; Cap(m³) is derived, not entered.

---

## WS4 — 3PL company master + company-scoped rate cards

**Goal:** a real 3PL-company layer. Today outsource lorries are just lorries
tagged `type='OUTSOURCE'` with no company grouping; rate cards key off individual
lorry plates (`0207`). This adds the missing company entity.

- **Company master:** new `scm.threepl_companies` (name, contact). A solo
  operator is a one-lorry company.
- **Ownership + auto-sync:** lorries / drivers / helpers created under a company
  carry its id and appear automatically in the Fleet / Driver / Helper lists
  (they already surface there via the OUTSOURCE tag; add the company link + a
  "create under company" flow so the company is the entry point).
- **Rate card by company:** move the rate-card carrier key from **lorry** to
  **company** (`0207`'s `carrier` becomes a company ref). Every lorry under the
  company inherits the one card.
- **Outstation surcharge (both layers):** per-trip fixed outstation base fee
  keyed by destination state, PLUS an optional per-order surcharge. Extend the
  rate-card rule types (there is already an `Outstation zone` rule) to carry a
  trip-level base and an order-level add.
- **Setup / Dismantle:** one flat company-level fee each (rule types already
  exist as `Setup` / `Dismantle` — enforce company-uniform, not per-item).
- **Min charge:** drop the MIN CHARGE field from the rate-card form (owner
  decided against it). Leave the column nullable/hidden rather than deleting data.
- **Cost path unchanged:** delivery cost stays a reported cost rolled toward COGS;
  it does NOT touch the FIFO lot/consumption triggers (existing guardrail).

---

## Build order & gate

WS1 (done) → WS2 → WS3 → WS4. Each is its own worktree → PR → gate-merge to prod
(main has no branch protection — re-check CI green immediately before merge, take
the migration number at merge time, confirm the backend job says `success`).
Owner has authorised straight-to-prod gate-merges for this work.

> ## Corrections — 2026-08-12 code-read sweep
>
> 1. OUTSTATION_TRIP now prices INSIDE computeDeliveryCost via CostOptions.perTrip (delivery-rate-card.ts:239-253,:360-372; both callers pass perTrip:true) so min/cap/rounding cover it — “added afterwards” let a capped card bill above its own cap and is retired.
> 2. Rule-type table omits SUPPLIER_PICKUP (mig 0243 CHECK + rate-rule-taxonomy.ts:64-70). REAL CODE DRIFT flagged separately: the route zod and calculator union still exclude it.
> 3. 3PL reconcile matches by COMPANY card first (trip.lorry_id → lorries.threepl_company_id → card.carrier_company_id, routes:519-532); per-lorry card is the fallback.
> 4. Nav is Transportation › Maintenance › “Carriers & Rates”, icon Handshake (Sidebar.tsx:571).
> 5. The test file holds 43 cases now, not 18.
> 6. Sofas ARE tier-counted on the reconcile path: derived setCount = max(frames,mattresses)+sofas (set-count.ts, fed at routes:621,637); §3's exclusion holds for the calculator contract only.

# Module: Delivery Rate-Card & Cost Reconciliation (Fleet Module C)

Per-module technical doc — the delivery-COST layer that sits alongside the TMS
(see `docs/modules/delivery-tms.md` for the dispatch board / trips / fleet). This
is the FINAL TMS module: it verifies a 3PL's billed charge against a configured
rate card and attaches the precise delivery cost toward COGS.

Verified against branch `feat/fleet-c-ratecard`. Migration `0207` (RE-CHECK the
number at merge — it was the next free above `0206` at branch time).

> Conventions: everything here lives in the **`scm`** schema and is served under
> `/api/scm/delivery-rate-cards` behind `scmAreaGuard('scm.transportation.drivers')`
> — the same Transportation area as the rest of the fleet. Money is integer sen
> (`*_centi`). It is **cost verification + COGS attribution, NOT customer billing**,
> and it does **NOT** touch the FIFO lot / consumption money-path triggers.

---

## 1. What it is for (owner's words)

When a 3PL bills Houzs, instantly verify the charge against a configured rate
card (no manual invoice matching) and roll the precise delivery cost into COGS.
Different 3PLs have different price cards. Own-fleet also gets a card (from its
cost structure) so a 3PL drop and an own-fleet drop are comparable per drop.

## 2. Data model (migration 0207)

Two additive tables, scoped per company.

### `scm.delivery_rate_cards` — one card per carrier
| Column | Notes |
|---|---|
| `id` uuid PK | |
| `company_id` bigint | per-company scope |
| `name` text | UNIQUE per (company_id, name) |
| `carrier_lorry_id` uuid null | FK `scm.lorries` — legacy per-lorry key / own-fleet lorry. Kept for back-compat |
| **`carrier_company_id` uuid null (mig 0211, WS4b)** | FK `scm.threepl_companies` — the card is now priced PER 3PL COMPANY; every lorry under it inherits. The create/edit "carrier" dropdown lists companies (from `GET /meta`'s `companies[]`). Reconcile resolves `trip.lorry_id -> lorries.threepl_company_id -> carrier_company_id` (falls back to `carrier_lorry_id`) |
| `carrier_label` text null | free-text carrier when not modelled as a lorry |
| `min_charge_centi` | still stored, but the **form no longer exposes it** (owner dropped min-charge, WS4b); the calculator honours it if a legacy row has one |
| `is_own_fleet` bool | **DERIVED, never sent by a client** — `carrier_company_id IS NULL`, enforced by a CHECK (mig 0246). The routes write it beside the carrier and the create/patch schemas do not accept it |
| `basis` text | `ITEM` \| `SET` (set = frame+mattress) — what the positional tiers count |
| `aggregation` text | `UNIT` \| `DROP` \| `CUSTOMER` \| `TRIP` (mig 0244) — the unit the tier ladder COUNTS. Default `UNIT` |
| `min_charge_centi` / `cap_centi` bigint null | optional envelope |
| `rounding` text | `NONE` \| `NEAREST_10C` \| `NEAREST_RM` |
| `is_active` bool, `notes` text | |

### `scm.delivery_rate_rules` — the priced rules a card is built from
One row per priced rule; `rule_type` selects the dimension.

| `rule_type` | positioning columns | meaning |
|---|---|---|
| `POSITIONAL_TIER` | `tier_position` (1,2,3=3rd+) | price of the Nth charging unit at a drop |
| `OVERAGE` | `tier_position` = cap N | each unit beyond N is a flat surcharge (caps the tier ladder) |
| `SOFA_BRACKET` | `bracket_min`..`bracket_max` (null=open) | sofa priced by compartment band; one bracket per sofa, additive |
| `OUTSTATION` | `zone` | destination-zone surcharge, per ORDER / costing unit (priced inside `computeDeliveryCost`) |
| `OUTSTATION_TRIP` (mig 0212, WS4c) | `zone` | FIXED fee per TRIP by destination zone, applied ONCE per trip regardless of drop count. Priced OUTSIDE `computeDeliveryCost` (it is not per-drop): the reconcile adds `tripOutstationFeeCenti(rules, destinationZone)` once after the per-drop total. The two OUTSTATION rule types are the owner's two outstation layers (per-order + per-trip) and can both sit on one card |
| `DISPOSE` / `SETUP` / `DISMANTLE` | — | occurrence charge (rate × count) |
| `SERVICE` / `PICKUP` / `INSPECTION` / `TRANSFER` | — | the owner's order-type charges, own rate each |

`amount_centi` is the price; `params` jsonb is an additive escape hatch the
calculator ignores if unknown.

## 3. The pure calculator — `backend/src/scm/lib/delivery-rate-card.ts`

`computeDeliveryCost(card, facts)` is PURE (no DB, no clock) and unit-tested
(`delivery-rate-card.test.ts`, 18 cases). It prices, in order: charging-unit
positional tiers (+ overage cap) → sofa compartment brackets → outstation zone →
dispose → setup → dismantle → service/pickup/inspection/transfer, then the
min/cap/rounding envelope. Returns an itemised `{ totalCenti, subtotalCenti,
lines[] }`.

**Separation of concerns:** the tiers count over `setCount`/`itemCount`, which
EXCLUDE sofas — a sofa is priced only by its compartment bracket. This matches
the owner's worked example, which the test asserts to the sen:

```
1st set RM120 + 2nd set RM80 + sofa 3-comp (2-4 band) RM90
  + outstation Melaka RM150 + setup RM50 + dismantle RM40 + dispose RM30 = RM560
```

## 4. Routes (`backend/src/scm/routes/delivery-rate-cards.ts`)

| Method + path | Purpose |
|---|---|
| `GET /delivery-rate-cards` | list cards (+ rule counts) |
| `GET /delivery-rate-cards/:id` | a card + its rules |
| `POST/PATCH/DELETE /delivery-rate-cards[/:id]` | card CRUD |
| `POST/PATCH/DELETE /delivery-rate-cards/:id/rules[/:ruleId]` | rule CRUD |
| `POST /delivery-rate-cards/:id/compute` | run the pure calculator for a set of facts → itemised breakdown |
| `GET /delivery-rate-cards/reconcile?from&to` | 3PL charge reconciliation (below) |
| `GET /delivery-rate-cards/meta` | carriers (lorries) + zones for the editor selects |

`/meta` and `/reconcile` are registered before `/:id` (single-segment collision,
mirrors trips `/day`).

## 5. Reconciliation — `GET /reconcile`

Lists OUTSOURCE trips (`is_outsourced=true`) that carry a captured billed cost
(`scm.trips.three_pl_cost_centi`, set in Fleet A3), matches each to its carrier's
rate card (by `carrier_lorry_id = trip.lorry_id`), derives the drop's facts from
the trip's stops, computes the EXPECTED cost, and flags the delta
(`billed - expected`). Example: billed RM620 vs expected RM560 → **+RM60 flagged**.

**What is auto-derived vs not.** Set count (from the stops' SO lines via
`deriveSetCount`) and destination zone (from the stops' SO postcodes via the A1
`zoneForAddress`) are derived automatically — the set-tier + outstation portion,
the bulk of a 3PL charge. Occurrence charges (setup/dismantle/dispose/service…)
and sofa compartments are NOT reliably present in the trip data model, so they
default to 0 and each row carries `factsComplete=false`; the dispatcher refines
them in the calculator. This is deliberate and honest, not a stub.

## 6. COGS-attribution seam (left for owner review)

The computed / reconciled delivery cost is surfaced read-only in the
reconciliation view (`expectedCenti` per trip, with its itemised `breakdown`) and
is available to any DO/trip margin surface that wants it. Per the money-engine's
separation of concerns, it is an **attached** delivery cost reported alongside —
it deliberately does **NOT** write into the FIFO lot/consumption triggers or the
money-path write path.

**The seam to wire, when the owner decides where the number lands:** the
per-trip `expectedCenti` (or the reconciled/agreed billed cost) is the delivery
cost to roll into the DO/SO COGS surface. It should attach at the DO/SO level
(the drop the trip served), reported next to the existing product COGS, not
folded into a FIFO lot. Until that decision is made it stays read-only here.

## 7. Frontend

| Surface | File |
|---|---|
| Admin page (Cards + Reconciliation tabs) | `frontend/src/pages/scm-v2/DeliveryRateCards.tsx` |
| Query hooks | `frontend/src/vendor/scm/lib/delivery-rate-card-queries.ts` |
| Route | `/scm/delivery-rate-cards` (App.tsx, `ScmGuard area="scm.transportation.drivers"`) |
| Nav | Sidebar → Transportation → "Rate Cards" (Calculator icon) |

The Cards tab: pick/create a card, edit its dimensions + rules, and a live
**cost calculator** prices a set of facts against the card (the worked example
lands on RM560). The Reconciliation tab: the `/reconcile` table with
computed-expected vs billed and the flagged delta.

### The carrier is a FACT in the editor, not a control (2026-08-02)

Owner: *"这个 OwnFleet Card 为什么会叫 OwnFleet 呢? 如果是 OwnFleet 的话，当我在
create 这一个 3PL 的 company 的时候，我就会直接 create 掉了"* and *"我都开着这一间
公司了，你还给我 3PL company 那边给我去选，那不是有问题吗?"*

The editor used to carry BOTH a "3PL company (carrier)" dropdown and an
"Own-fleet card" checkbox, on a card you reached by clicking that carrier in the
list beside it. Two controls, one question, and either could make the card
disagree with its own heading — MSJ TRANSPORT's card, carrier set, ticked
"Own-fleet".

- The checkbox is **gone**. Own fleet IS "no carrier"; `is_own_fleet` is derived
  server-side and constrained (mig 0246). `NewRateCard` no longer carries it.
- The carrier is **shown, not re-picked**. One card per company is already a
  partial unique index (mig 0237), and the carrier list IS the card list, so
  re-selecting here could only ever create a contradiction. To price a different
  carrier, open that carrier.
- The create drawer's "Charge per" now offers all four aggregation units and
  defaults to `UNIT`. It offered only DROP/CUSTOMER and defaulted to DROP, so
  every card born there started on a setting the calculator does not price the
  way the label reads.

## 8. Seed

`backend/scripts/seed-delivery-rate-cards.mjs` installs a sample card that IS the
worked example (RM560). DRY-RUN by default; `APPLY=1` writes; idempotent by
(company_id, name). Seeds are scripts, not migrations (repo rule).

## 9. Verification (this branch)

- Backend `npm run typecheck` clean; `npm run audit:routes` → "current" (1010
  routes); `delivery-rate-card.test.ts` 18/18 incl. the RM560 example + tiers /
  cap+overage / sofa brackets / outstation / min-cap-rounding.
- Frontend `tsc -b` + `vite build` clean; `routeManifestDrift.test.ts` green
  (staff 133, contract 141).
- Honest limit: not run against a live DB / auth — the reconciliation fact
  derivation and the CRUD writes are typechecked, not exercised against Postgres.

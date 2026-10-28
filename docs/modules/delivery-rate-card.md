# Delivery Rate-Card & Cost Reconciliation

The delivery-COST layer alongside the TMS (`docs/modules/delivery-tms.md` covers dispatch/trips/fleet). Verifies a 3PL's billed charge against a configured rate card and attaches the precise delivery cost toward COGS — cost verification, not customer billing. It does not touch the FIFO lot/consumption money-path triggers.

## Statuses and flow

A card (`scm.delivery_rate_cards`) is priced PER 3PL COMPANY (`carrier_company_id`; every lorry under that company inherits it) or is an own-fleet card (`is_own_fleet` — DERIVED server-side as `carrier_company_id IS NULL`, DB-constrained, never client-set). One card per company is enforced by a unique index. A card is built from priced rules (`scm.delivery_rate_rules`): `POSITIONAL_TIER` + `OVERAGE` (per-drop charging-unit ladder), `SOFA_BRACKET` (sofa priced by compartment band, additive), `OUTSTATION` (per-order zone surcharge) and `OUTSTATION_TRIP` (fixed per-trip zone fee), `DISPOSE`/`SETUP`/`DISMANTLE` (occurrence charges), `SERVICE`/`PICKUP`/`INSPECTION`/`TRANSFER` (order-type charges).

The pure calculator (`computeDeliveryCost`) prices, in order: positional tiers + overage cap -> sofa brackets -> outstation zone -> dispose -> setup -> dismantle -> service/pickup/inspection/transfer -> the fixed per-trip outstation fee (only when `opts.perTrip`) -> the min/cap/rounding envelope. On its own contract, the tier count (`setCount`/`itemCount`) EXCLUDES sofas (a sofa is priced only by its bracket) — but the reconciliation path's derived `setCount` folds sofas in (`max(frames, mattresses) + sofas`) before calling the calculator, so the two callers count sofas differently by design.

Reconciliation (`GET /reconcile?from&to`) lists outsourced trips with a captured billed cost, matches each to its carrier's active card (`trip.lorry_id -> lorries.threepl_company_id -> card.carrier_company_id`, falling back to a per-lorry card), computes the expected cost ONCE per trip (not per drop and summed), and flags the delta. Set count and destination zone (the farthest zone the trip touches) are auto-derived from the trip's stops; occurrence charges and sofa compartments are NOT reliably present in the trip data model and default to 0 with `factsComplete=false` — the dispatcher fills them in manually. This is a deliberate, honest gap, not a stub.

## Permissions

- Served under `/api/scm/delivery-rate-cards` behind `scmAreaGuard('scm.transportation.drivers')` — the same Transportation area as the rest of the fleet, for both cards and reconciliation.

## Rules that must not break

- `is_own_fleet` must stay derived (`carrier_company_id IS NULL`) — never accept it from a client payload; the DB CHECK is the backstop but the create/patch schemas should never offer the field.
- The per-trip outstation fee (`OUTSTATION_TRIP`) must be priced INSIDE `computeDeliveryCost` before the min/cap/rounding envelope, not bolted on afterward — applying it outside the envelope lets a capped card bill above its own cap.
- Reconciliation's zone must be the FARTHEST zone the trip touches, never just the first stop returned by the query — a multi-zone trip priced on an arbitrary stop's zone re-runs differently each time.
- The reconciliation cost is computed once per TRIP and must not be computed per drop and summed — `dropCount`/`customerCount`/`setCount` are trip-level aggregates by design.
- The computed/reconciled delivery cost stays read-only and outside the FIFO/COGS write path until the owner decides where it attaches — do not wire `expectedCenti` into a lot or consumption trigger without that decision.

## Gotchas

- `SUPPLIER_PICKUP` is a valid `rule_type` at the database constraint level but is still excluded from the route's validation schema and the calculator's type union — it cannot actually be used end-to-end yet; don't assume every DB-allowed rule type is wired through the app.
- Occurrence charges (setup/dismantle/dispose/service) and sofa compartments are not auto-derivable from a trip's stops today — a reconciliation row with `factsComplete=false` is expected and normal, not a bug to chase.
- The carrier on a card's editor is a fact to look at, not a control to re-pick — one card per company already exists as a unique index, so re-selecting a carrier there could only ever create a contradiction; open the carrier's own card to price it differently.
- The `min_charge_sen` field is no longer exposed in the create/edit form, but the calculator still honours a nonzero value on a legacy row — don't assume every card's envelope is empty just because the form has nothing to show for it.

## Where the code is

- `backend/src/scm/lib/delivery-rate-card.ts` — the pure calculator, `computeDeliveryCost`.
- `backend/src/scm/lib/set-count.ts` — the reconciliation's sofa-inclusive `setCount` derivation.
- `backend/src/scm/routes/delivery-rate-cards.ts` — card/rule CRUD, `/compute`, `/reconcile`, `/meta`.
- `frontend/src/pages/scm-v2/DeliveryRateCards.tsx` — admin page (Cards + Reconciliation tabs).
- `frontend/src/vendor/scm/lib/delivery-rate-card-queries.ts` — query hooks.
- `backend/scripts/seed-delivery-rate-cards.mjs` — sample card seed (DRY-RUN by default).

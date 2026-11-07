# Delivery Rate-Card & Cost Reconciliation

The delivery-COST layer alongside the TMS (`docs/modules/delivery-tms.md` covers dispatch/trips/fleet). Verifies a 3PL's billed charge against a configured rate card and attaches the precise delivery cost toward COGS — cost verification, not customer billing. It does not touch the FIFO lot/consumption money-path triggers.

## Statuses and flow

A card (`scm.delivery_rate_cards`) is priced PER 3PL COMPANY (`carrier_company_id`; every lorry under that company inherits it) or is an own-fleet card (`is_own_fleet` — DERIVED server-side as `carrier_company_id IS NULL`, DB-constrained, never client-set). One card per company is enforced by a unique index. A card is built from priced rules (`scm.delivery_rate_rules`): `POSITIONAL_TIER` + `OVERAGE` (per-drop charging-unit ladder), `SOFA_BRACKET` (sofa priced by compartment band, additive), `OUTSTATION` (per-order zone surcharge) and `OUTSTATION_TRIP` (fixed per-trip zone fee), `DISPOSE`/`SETUP`/`DISMANTLE` (occurrence charges), `SERVICE`/`PICKUP`/`INSPECTION`/`SUPPLIER_PICKUP`/`TRANSFER` (order-type charges). The route's accepted rule types ARE `RATE_RULE_TYPES` from `lib/rate-rule-taxonomy.ts` (held to the DB CHECK by `audit:job-types`) — never a local copy. A 3PL company that has a card cannot be deleted (409 `has_rate_card`); a card left without a carrier by an earlier delete shows under Needs a carrier and is moved with PATCH `carrierCompanyId` (must be this company's carrier; the card takes its name).

The pure calculator (`computeDeliveryCost`) prices, in order: positional tiers + overage cap -> sofa brackets -> outstation zone -> dispose -> setup -> dismantle -> service/pickup/inspection/supplier pickup/transfer -> the fixed per-trip outstation fee (only when `opts.perTrip`) -> the min/cap/rounding envelope. On its own contract, the tier count (`setCount`/`itemCount`) EXCLUDES sofas (a sofa is priced only by its bracket) — but the reconciliation path's derived `setCount` folds sofas in (`max(frames, mattresses) + sofas`) before calling the calculator, so the two callers count sofas differently by design.

Reconciliation (`GET /reconcile?from&to`) lists outsourced trips with a captured billed cost, matches each to its carrier's active card (`trip.lorry_id -> lorries.threepl_company_id -> card.carrier_company_id`, falling back to a per-lorry card), computes the expected cost ONCE per trip (not per drop and summed), and flags the delta. Set count and destination zone (the farthest zone the trip touches) are auto-derived from the trip's stops; occurrence charges and sofa compartments are NOT reliably present in the trip data model and default to 0 with `factsComplete=false` — the dispatcher fills them in manually. This is a deliberate, honest gap, not a stub. 3PL work is rarely planned as trips, so the Reconciliation tab leads with the per-DO billed cost from `/threepl-do-charges` (the 3PL invoices tab: keyed in, or read off an AP invoice's bill), rolled up per 3PL; the trip table follows. Keying in a DO that already has a row for that 3PL answers 409 `already_keyed` until the client resends with `replace: true`.

## Permissions

- Served under `/api/scm/delivery-rate-cards` behind `scmAreaGuard('scm.transportation.drivers')` — the same Transportation area as the rest of the fleet, for both cards and reconciliation.

## Rules that must not break

- `is_own_fleet` must stay derived (`carrier_company_id IS NULL`) — never accept it from a client payload; the DB CHECK is the backstop but the create/patch schemas should never offer the field.
- The per-trip outstation fee (`OUTSTATION_TRIP`) must be priced INSIDE `computeDeliveryCost` before the min/cap/rounding envelope, not bolted on afterward — applying it outside the envelope lets a capped card bill above its own cap.
- Reconciliation's zone must be the FARTHEST zone the trip touches, never just the first stop returned by the query — a multi-zone trip priced on an arbitrary stop's zone re-runs differently each time.
- The reconciliation cost is computed once per TRIP and must not be computed per drop and summed — `dropCount`/`customerCount`/`setCount` are trip-level aggregates by design.
- The computed/reconciled delivery cost stays read-only and outside the FIFO/COGS write path until the owner decides where it attaches — do not wire `expectedCenti` into a lot or consumption trigger without that decision.

## Gotchas

- Occurrence charges (setup/dismantle/dispose/service) and sofa compartments are not auto-derivable from a trip's stops today — a reconciliation row with `factsComplete=false` is expected and normal, not a bug to chase.
- The carrier on a card's editor is a fact to look at, not a control to re-pick — one card per company already exists as a unique index, so re-selecting a carrier there could only ever create a contradiction; open the carrier's own card to price it differently.
- A card's name is copied from its company at create; the page shows the company's current name, so a renamed carrier reads right on screen while the stored name may lag.

## Where the code is

- `backend/src/scm/lib/delivery-rate-card.ts` — the pure calculator, `computeDeliveryCost`.
- `backend/src/scm/lib/set-count.ts` — the reconciliation's sofa-inclusive `setCount` derivation.
- `backend/src/scm/routes/delivery-rate-cards.ts` — card/rule CRUD, `/compute`, `/reconcile`, `/meta`.
- `frontend/src/pages/scm-v2/DeliveryRateCards.tsx` — Carriers & Rates page (Rate Cards, 3PL invoices, Reconciliation tabs).
- `frontend/src/vendor/scm/lib/delivery-rate-card-queries.ts` — query hooks.
- `backend/scripts/seed-delivery-rate-cards.mjs` — sample card seed (DRY-RUN by default).

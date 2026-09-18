# Consignment Status Alignment

Six consignment documents clone the sales/purchase chain's tables and reuse their exact Postgres status enums, but the UI and automation that drive sales-chain statuses were not carried over. This page tracks what is actually live today versus what the database merely allows, and known gaps that block treating the two chains as equivalent.

| Consignment doc | Mirrors | Table (status type) |
|---|---|---|
| Consignment Order (CO) | Sales Order | `consignment_sales_orders` (`mfg_so_status`) |
| Consignment Note (CN) | Delivery Order | `consignment_delivery_orders` (`do_status`) |
| Consignment Return (CR) | Delivery Return | `consignment_delivery_returns` (`delivery_return_status`) |
| PC Order (PCO) | Purchase Order | `purchase_consignment_orders` (`po_status`) |
| PC Receive (PCR) | GRN | `purchase_consignment_receives` (`grn_status`) |
| PC Return (PCT) | Purchase Return | `purchase_consignment_returns` (`purchase_return_status`) |

The consignment chain has no invoice document — there is no fact an `INVOICED` status could ever point to on any of the six.

## Statuses and flow

- CO today only ever reaches `CONFIRMED` (on create) or `CANCELLED` (list right-click) — the shared enum accepts all nine Sales Order values (`ON_HOLD`, `IN_PRODUCTION`, `READY_TO_SHIP`, `SHIPPED`, `DELIVERED`, `INVOICED` included) but nothing writes them.
- CN today only ever reaches `DISPATCHED` (written at create — consignment goods count as "out" the moment the note is raised, there is no `LOADED`/confirm step) or `CANCELLED`.
- `READY_TO_SHIP` and `DELIVERED` have no automation for CO: `so-stock-allocation.ts` and `so-delivery-sync.ts` do not read any consignment table.
- PCO / PCR already accept `ON_HOLD` in their shared enum (inherited from the PO/GRN migrations) but no button anywhere sets it yet.

## Rules that must not break

- Consignment order/note/return line `item_group` is resolved server-side from `mfg_products.category` by item code (`resolveItemGroups` / `lib/sku-category.ts`), company-scoped — never trust the client-supplied `itemGroup` for the stock-bucket key.
- Header date-pair PATCHes (processing/delivery date) go through `effectiveDateAfterPatch` (`scm/lib/date-coerce.ts`) — `undefined` means "not mentioned", `null` or `""` both mean "clear". Do not treat `null` as "not mentioned".

## Gotchas

- The status PATCH endpoints (CO, CN, CR) accept any string the Postgres enum allows, uppercased, with no legal-value whitelist or transition table — a status with no UI button (e.g. CO's `ON_HOLD`) can still be set through the API alone.
- `purchase-consignment-receives.ts`'s `recomputePcoReceived` only excludes `CANCELLED` POs from its recompute, not `ON_HOLD` — putting a PCO on hold and then receiving against it silently clears the hold. Treat PCO Hold as unsafe to rely on until this is fixed.
- CO cancellation is not final (the list has a "Reopen SO" action that revives a cancelled CO) — unlike the Sales Order, where cancellation is final. Do not assume a cancelled CO is permanently closed.
- CN, CR and PCT list pages each keep their own copy of the status-label dictionary instead of reading a shared one — a vocabulary change made in one place is not guaranteed to reach all three.
- Some list tabs (CR's `REFUNDED`, PCR's `CLOSED`, PCT's `COMPLETED`) have no button anywhere that can produce that status — an empty tab does not prove nothing belongs there, it may mean nothing can reach it yet.
- Before adding Hold or new status automation to any of the six documents, confirm scope with the owner — Delivery Order and Delivery Return themselves have no Hold status either (only the mig-0324 flag columns), so "aligning" consignment alone can create a new mismatch rather than close one.

## Where the code is

- `backend/src/scm/routes/consignment-orders.ts`, `consignment-notes.ts`, `consignment-returns.ts` — CO/CN/CR write paths.
- `backend/src/scm/routes/purchase-consignment-receives.ts` — PCR, `recomputePcoReceived`.
- `backend/src/scm/lib/sku-category.ts` — `resolveItemGroups`, the shared category resolver.
- `frontend/src/pages/scm-v2/ConsignmentOrders.tsx` — CO list, status labels, right-click menu.
- `backend/scripts/check-consignment-status-census.mjs` — read-only census of live status values and row counts per document.

# Warehouses

`scm.warehouses` — the master list of physical stock locations. Small table, but load-bearing: every stock movement, Delivery Order, GRN, SO reserve, inventory balance and venue resolve reads from it.

## Statuses and flow

`type` (`scm.warehouse_type` enum) is the canonical classification — five values, each with its own cross-company sharing rule:

| Type | Meaning | Sharing |
|---|---|---|
| `warehouse` | pure stock location | both companies |
| `showroom` | sales point, feeds the venue list | company-specific |
| `display` | display stock at a partner site, must not net into sellable inventory | HOUZS-only |
| `service` | repair / customer-service centre | both companies |
| `others` | HQ or anything else | HOUZS-only |

`is_showroom` is a legacy boolean kept for backward-compatible readers (venue-binding resolver, Members page, an inventory OR-include) — it is DERIVED from `type` by a database trigger, not an independent fact.

Racks (`scm.warehouse_racks`) live one level under a warehouse, unique per `(warehouse_id, rack)`; a rack can carry a `zone` override of its default number-based zone grouping. A cross-company, read-only view backs an "All Companies" rack tab and the mobile rack-lookup screen — there is no cross-company write; editing, stock and zone stay per-company.

One building is one `scm.warehouses` record PER COMPANY with the same `code` (KL WAREHOUSE under HOUZS and under 2990), and a shelf is one rack row per record, so a shelf both companies receive on must carry the label under each record. `POST /warehouse/racks` (single or seed) takes `alsoSiblingCompanies: true` to fan the label out to the other allowed companies' active warehouses of the same code as well, each row stamped with THAT warehouse's `company_id` (`lib/rack-sibling-warehouses.ts`); the desktop New rack / Seed racks "Apply to" has the matching checkbox. Rename and delete stay per record. On 2026-10-05 2990's KL WAREHOUSE was seeded with HOUZS's 76 labels (Rack L1.1–L21.2, R1.1–R17.2) so 2990 receipts can be racked on the shared shelves; a rack added later to one company without the checkbox is a shelf the other cannot pick.

`stock_bucket` (mig 20260921T2000; null / `customer` / `display` / `service`) names the CLOSING STOCK the month-end close books a warehouse's goods on; blank follows the type (warehouse, others → customer; showroom, display → display; service → service — `backend/src/scm/lib/stock-bucket.ts`). HOUZS's two Cash & Carry segment locations carry `customer` (owner 2026-09-21). Set it on the warehouse form.

## Rules that must not break

- Set `type`, never `is_showroom` directly — a trigger overwrites `is_showroom` from `type` on every insert/update, so a raw update of the flag alone is silently reverted.
- Every read and write on `scm.warehouses` (and racks) must be company-scoped — an unscoped query can promote, demote or delete another company's default warehouse.
- The NON-SELLING warehouse set (`{showroom, display, service}`) lives in exactly one module (`non-selling-warehouse.ts`) — import it, never re-declare it; a duplicate declaration fails the build.
- Classify a lot as consignment by its SOURCE document (`isConsignmentLotSource`), never by the warehouse's own `is_consignment` flag — a receipt mis-posted into a normal warehouse would otherwise leak supplier-owned stock into owned value.
- A positive stock ADJUSTMENT or STOCK_TAKE variance must resolve a real unit cost (typed, else weighted average of other priced open lots, else last-known cost) or be refused (`422 cost_required`) — never silently open a lot at RM0.
- New Stock Adjustment is a line-by-line table (like Stock Transfer): Qty is SIGNED — positive increases (found / recount up), negative decreases (write-off / damage / loss). There is NO increase/decrease toggle; the sign IS the direction, sent verbatim as `qtyDelta` (the POST has always taken a signed delta). A sofa/bedframe INCREASE still needs its variant axes + (sofa) batch; a DECREASE still picks the exact open lot — both in the row's expandable detail. qty 0 or no SKU is invalid.
- Do not delete a warehouse with movement history — the FK from `inventory_movements`/`lots`/`cogs` refuses it (409 `in_use`); deactivate instead.

## Gotchas

- Use the shared `warehouseLabel` rule (code first, then name) via its frontend mirror — don't hand-write a `?.name || ?.code` fallback; a corpus test fails the build on any new private copy.
- Read warehouses through `useWarehouses()` — its 5-minute staleness is intentional and shared; don't add a per-page fetch.
- `CONSIGN-OUT` is a 2990-only, inactive historical placeholder — do not copy it to HOUZS in a future unification pass.
- Filter `type='showroom'` for "sales point", `type='warehouse'` for "stock location", or `is_active=true` alone for "everything selectable" — don't reuse `is_showroom` for a new consumer.
- Rack labels carry no implicit prefix — the grid renders the stored `rack` string verbatim, so a seeded label must already contain everything that should show.
- On mobile, racks are read-only lookup (plus create) — rename, re-zone, batch-edit and delete are still desktop-only.
- Rack QR stickers (Warehouse page → Print labels, A4 2x5; one rack from its slot drawer's **Print label**, or the selected racks from the batch bar's **Print labels**) encode `HZRACK:<rack label>`, NOT the rack row id: one shelf label is fanned out to a row per warehouse record, so a scanner must resolve the label inside the GRN's own warehouse. Do not switch the payload to an id — every sticker already on a shelf would stop matching.

## Where the code is

- `backend/src/scm/routes/inventory.ts` — warehouse CRUD, valuation, racks.
- `backend/src/scm/lib/warehouse-label.ts`, `frontend/src/vendor/scm/lib/warehouse-label.ts` — the shared display rule (byte-identical pair).
- `backend/src/scm/lib/non-selling-warehouse.ts` — the non-selling type set.
- `backend/src/scm/shared/adjustment-cost.ts` — variance cost resolution.
- `frontend/src/pages/scm-v2/Warehouses.tsx`, `CrossCompanyRacks.tsx` — desktop surfaces.
- `frontend/src/mobile/MobileRacks.tsx` — mobile rack lookup.
- `frontend/src/vendor/scm/lib/rack-label-pdf.ts` — rack QR sticker sheet; `rack-qr.ts` — the `HZRACK:` payload and how a scan resolves to a rack.
- `frontend/src/vendor/scm/lib/inventory-queries.ts` — `useWarehouses`.

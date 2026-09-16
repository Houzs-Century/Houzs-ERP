# Combo Pricing

Prices a whole COMBINATION of sofa modules instead of summing the modules individually, and overrides per-model compartment pricing when a line's module set matches. Everything goes through `/api/scm/sofa-combos`.

## Statuses and flow

- A combo's scope is a tuple: `base_model` + `modules` (canonicalised into an order-independent set via `comboSlotsKey`) + `tier` (`PRICE_1`/`PRICE_2`/`PRICE_3`/null) + `customer_id` (null = every customer) + `supplier_id` (null = the master/sales-side reference price; a uuid = that supplier's cost).
- Editing is append-only and effective-dated: `PUT /:id` is a convenience alias for `POST` — it INSERTs a new row with a fresher `effective_from` rather than updating in place, and the latest row in scope wins at lookup. The combo's identity lives in its scope tuple, not its row id. `DELETE` is a soft delete (`deleted_at`).
- The master combo COST (`prices_by_height` on the `supplier_id NULL` row) **auto-derives from the most-expensive supplier combo** for the same scope tuple, on a supplier-scope combo write, when the `scm.auto_derive_product_cost` flag is ON (cost-only — the master `selling_prices_by_height` is never touched). The old manual per-model "anchor to one supplier" mirror was removed (owner 2026-09-16): it was redundant with the derivation and held 0 rows.

## Permissions

- All writes gate on `requireWriteRole` (the `scm_config_write` permission). This checks permission ONLY, not tenancy — every by-id write (`PUT`/`DELETE /:id`) must separately company-scope its read of the target row, or an edit can clone another company's combo tuple into the active company.

## Rules that must not break

- Combos must load and match at `PRICE_1` only (`computeSofaSellingSen` pins it) — module seat prices load at `PRICE_1` and every combo is authored at `PRICE_1`; matching against any other tier would make the server price a-la-carte while the POS applied the combo, and the drift gate would then reject a correct order.
- `computeSofaSellingSen` is the one authoritative selling-total function, shared by the server's drift gate and the POS configurator — never fork a second pricing calculation for either surface.
- The compartment list a Model offers when PRICING an existing build is derived from its module SKUs, never from the maintenance `sofaCompartments` pool — that pool is only a shortcut for OPENING/authoring codes.
- Combo COST derivation is flag-gated (`scm.auto_derive_product_cost`, OFF by default) and cost-only: it writes the master `prices_by_height`, never `selling_prices_by_height`. A SKU/combo with no supplier price derives nothing (a gap, left as-is).
- Both by-id write paths (`PUT /:id`, `DELETE /:id`) must scope their target read to the active company — a foreign id must resolve to nothing (404), never another company's row.

## Gotchas

- The route file's own header is out of date in places — it still advertises a `copy-to-customer` endpoint that was removed, and cites a migration number that belongs to a different repo's numbering. Verify against the route file itself, not the header comment.
- The COST derivation appends a fresh effective-dated master row only when the derived cost actually changed (deduped), so a no-op supplier re-save adds no row.
- The supplier-scoped half of `sofa_combo_pricing` is the majority of the table's rows in production — treat supplier-cost combos as the common case, not an edge case, when reasoning about this data.

## Where the code is

- `backend/src/scm/routes/sofa-combos.ts` — main API surface; combo cost auto-derives from the max supplier (flag-gated).
- `backend/src/scm/shared/sofa-build.ts` — `computeSofaSellingSen`, the compartment-from-SKU derivation.
- `frontend/src/vendor/scm/lib/sofa-combos-queries.ts` — query hooks.
- `frontend/src/vendor/scm/components/SofaComboTab.tsx`

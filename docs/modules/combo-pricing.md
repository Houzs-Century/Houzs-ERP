# Combo Pricing

Prices a whole COMBINATION of sofa modules instead of summing the modules individually, and overrides per-model compartment pricing when a line's module set matches. Two tables with two owners:

- `scm.sofa_combo_pricing` via `/api/scm/sofa-combos` — Houzs's combos: supplier cost, the master cost anchor, and company 1's selling price.
- `scm.pos_sofa_combos` via `/api/scm/pos-pools/sofa-combos` — the '2990' company's SELLING combos, authored on the 2990 POS. No cost column. Owner ruling: Houzs combos are Houzs's cost, 2990 combos are the POS's selling price, the two sets may differ, and Houzs may not change 2990's.

## Statuses and flow

- A combo's scope is a tuple: `base_model` + `modules` (canonicalised into an order-independent set via `comboSlotsKey`) + `tier` (`PRICE_1`/`PRICE_2`/`PRICE_3`/null) + `customer_id` (null = every customer) + `supplier_id` (null = the master/sales-side reference price; a uuid = that supplier's cost).
- Editing is append-only and effective-dated: `PUT /:id` is a convenience alias for `POST` — it INSERTs a new row with a fresher `effective_from` rather than updating in place, and the latest row in scope wins at lookup. The combo's identity lives in its scope tuple, not its row id. `DELETE` is a soft delete (`deleted_at`).
- The master combo COST (`prices_by_height` on the `supplier_id NULL` row) **auto-derives from the most-expensive supplier combo** for the same scope tuple, on a supplier-scope combo write, when the `scm.auto_derive_product_cost` flag is ON (cost-only — the master `selling_prices_by_height` is never touched). The old manual per-model "anchor to one supplier" mirror was removed (owner 2026-09-16): it was redundant with the derivation and held 0 rows.

## Permissions

- `scm.pos_sofa_combos` is written ONLY by `scm.pos_sofa_combo_insert` / `scm.pos_sofa_combo_retire` (SECURITY DEFINER, EXECUTE for service_role only), which the `/pos-pools/sofa-combos` writes call with the real caller. service_role has SELECT only; a trigger refuses every other writer, every DELETE / TRUNCATE, and any change except retiring. Every create / retire is in `scm.pos_sofa_combo_audit`.

- All writes gate on `requireWriteRole` (the `scm_config_write` permission). This checks permission ONLY, not tenancy — every by-id write (`PUT`/`DELETE /:id`) must separately company-scope its read of the target row, or an edit can clone another company's combo tuple into the active company.

## Rules that must not break

- A SELLING reader gets combos from `loadSellingSofaCombos` (`lib/pos-sofa-combos.ts`): the '2990' company reads `pos_sofa_combos`, other companies the `sofa_combo_pricing` master rows. Never price a 2990 line from `sofa_combo_pricing` — its company-2 rows are Houzs cost work. A failed `pos_sofa_combos` read throws; it must not fall back to pricing a-la-carte.
- Lookups by combo id (PWP rules, special-delivery targets) read BOTH tables (`loadLiveCombosByIds`, `loadComboModulesById`) — a POS combo created after the split exists only in `pos_sofa_combos`.
- The SO cost spread keeps `loadMasterSofaCombos` (Houzs's table) for every company.

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

- `backend/src/scm/lib/pos-sofa-combos.ts` — which table a reader uses; `backend/src/scm/routes/pos-sofa-combos.ts` — the POS's list / history / create / edit / retire.

- `backend/src/scm/routes/sofa-combos.ts` — main API surface; combo cost auto-derives from the max supplier (flag-gated).
- `backend/src/scm/shared/sofa-build.ts` — `computeSofaSellingSen`, the compartment-from-SKU derivation.
- `frontend/src/vendor/scm/lib/sofa-combos-queries.ts` — query hooks.
- `frontend/src/vendor/scm/components/SofaComboTab.tsx`

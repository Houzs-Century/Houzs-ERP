# Combo Pricing

Prices a whole COMBINATION of sofa modules instead of summing the modules individually, and overrides per-model compartment pricing when a line's module set matches. Everything goes through `/api/scm/sofa-combos`.

## Statuses and flow

- A combo's scope is a tuple: `base_model` + `modules` (canonicalised into an order-independent set via `comboSlotsKey`) + `tier` (`PRICE_1`/`PRICE_2`/`PRICE_3`/null) + `customer_id` (null = every customer) + `supplier_id` (null = the master/sales-side reference price; a uuid = that supplier's cost).
- Editing is append-only and effective-dated: `PUT /:id` is a convenience alias for `POST` — it INSERTs a new row with a fresher `effective_from` rather than updating in place, and the latest row in scope wins at lookup. The combo's identity lives in its scope tuple, not its row id. `DELETE` is a soft delete (`deleted_at`).
- An **anchor** pins one `base_model` to ONE supplier. While anchored, every combo CREATE and price EDIT mirrors bidirectionally between the master row (`supplier_id NULL`) and that supplier's row (also append-only), so the Product-Maintenance cost reference and the anchored supplier's cost stay in lock-step. Mirroring is best-effort — the primary write already succeeded, so a mirror failure reports `mirrored:false` rather than failing the caller.

## Permissions

- All writes gate on `requireWriteRole` (the `scm_config_write` permission). This checks permission ONLY, not tenancy — every by-id write (`PUT`/`DELETE /:id`) must separately company-scope its read of the target row, or an edit can clone another company's combo tuple into the active company.

## Rules that must not break

- Combos must load and match at `PRICE_1` only (`computeSofaSellingSen` pins it) — module seat prices load at `PRICE_1` and every combo is authored at `PRICE_1`; matching against any other tier would make the server price a-la-carte while the POS applied the combo, and the drift gate would then reject a correct order.
- `computeSofaSellingSen` is the one authoritative selling-total function, shared by the server's drift gate and the POS configurator — never fork a second pricing calculation for either surface.
- The compartment list a Model offers when PRICING an existing build is derived from its module SKUs, never from the maintenance `sofaCompartments` pool — that pool is only a shortcut for OPENING/authoring codes.
- The anchor table's unique key (`company_id, base_model`) is load-bearing for the upsert's `ON CONFLICT` clause — if it ever changes, the route's `onConflict` target must change in the same PR, or every anchor write starts failing.
- Both by-id write paths (`PUT /:id`, `DELETE /:id`) must scope their target read to the active company — a foreign id must resolve to nothing (404), never another company's row.

## Gotchas

- The route file's own header is out of date in places — it still advertises a `copy-to-customer` endpoint that was removed, and cites a migration number that belongs to a different repo's numbering. Verify against the route file itself, not the header comment.
- Anchoring a model is not a no-op for one with a long price history — mirroring INSERTs, so both the master and the anchored supplier's side accumulate a growing set of effective-dated rows once anchoring is turned on.
- There is no FK from an anchor to `scm.suppliers` — a stale `supplier_id` on an anchor simply reads as unset in the UI rather than erroring.
- The supplier-scoped half of `sofa_combo_pricing` is the majority of the table's rows in production — treat supplier-cost combos as the common case, not an edge case, when reasoning about this data.

## Where the code is

- `backend/src/scm/routes/sofa-combos.ts` — main API surface, anchor mirroring.
- `backend/src/scm/shared/sofa-build.ts` — `computeSofaSellingSen`, the compartment-from-SKU derivation.
- `frontend/src/vendor/scm/lib/sofa-combos-queries.ts` — query hooks.
- `frontend/src/vendor/scm/components/SofaComboTab.tsx` — the anchor UI control.

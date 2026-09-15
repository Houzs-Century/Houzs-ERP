# Delivery Return

Goods coming back from a customer — the mirror of the Delivery Order (a DO moves stock OUT, a DR brings it IN). The return names the Delivery Order it came from, its lines name the DO lines, and posting it puts stock back into a warehouse at the cost it left at. Mirror module: `docs/modules/purchase-return.md`.

## Statuses and flow

DB enum `scm.delivery_return_status`, default `PENDING` (no code path writes it — a DR is `RECEIVED` from the create insert, so it is never "pending" in practice). `RECEIVED -> INSPECTED / REFUNDED` (via `PATCH /:id/status`, stamps timestamps); `CREDIT_NOTED` / `REJECTED` are valid enum members with no special handling; `CANCELLED` is reachable from any state via the status PATCH and is **FINAL** — any transition out of it is refused (409 `dr_cancelled_final`); raise a new return instead of un-cancelling.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List, `?status=` filter, sales-scoped |
| GET | `/returnable-do-lines` | Picker for "from DO" — only `delivered` lines (a loaded, not-yet-delivered DO is not returnable) |
| GET | `/:id` | Header + lines |
| POST | `/` | Create |
| POST | `/from-do`, `/from-dos` | Convert DO line(s) into a return (same handler) |
| PATCH | `/:id` | Update header |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | Add / update / remove a line |
| PATCH | `/:id/status` | Status transition, incl. CANCEL |
| GET | `/export/rows` | One row per line export (all matching rows, not just the loaded page) |

No dedicated mobile screen — the generic `MobileModuleList` / `MobileModuleDetail` render it.

## Permissions

- One guard over the whole router: `scm.sales.returns` (`scmAreaGuard`), covers both read and write.
- List and detail are additionally row-scoped to the caller's **sales** scope (`resolveSalesScopeIds` / `salesDocOutOfScope`) — own + downline only, unless the caller can view all sales.

## Rules that must not break

- Every non-service return line with `qty_returned > 0` moves stock IN — this is not paperwork.
- A line naming no DO line (`do_item_id` null) is refused outright on create and add-item (409 `do_link_required`) — the column stays nullable in the DDL for legacy rows only.
- `resyncInventoryForReturn` is a delta walk to a computed TARGET per `(warehouse, product, variant_key, batch_no)`, not an incremental adjustment — a CANCELLED return's target is zero, draining every bucket back out.
- SERVICE lines never write stock IN, checked via `isServiceLine` (item_group + code) with a catalog fallback (`findServiceLineCodes`); if that check itself fails, all four write paths refuse the line (409 `service_check_failed`) rather than admit it unchecked.
- `variant_key` is built from the line's stored `item_group`, which write paths rewrite server-side from `mfg_products.category` (company-scoped) rather than trusting the request — keeps a return's stock in the same bucket the goods left from.
- Every write path accepting a `do_item_id` must confirm the linked DO line is the SAME PRODUCT (409 `link_material_mismatch`), checked before any quantity cap — a valid but wrong-product link would draw down the wrong source line.
- Source-cost reads and the "live documents" pickers (`checkCrOverRemaining`, returnable/deliverable line lists) must be company-scoped and paginated — an unpaged or unscoped read can leak another tenant's cost or let an over-return guard silently pass.
- The incoming status is normalised (trim + uppercase) once before any gate reads it — comparing the raw request value against gates that expect the persisted (already-normalised) shape misses the idempotent CANCEL echo entirely.

## Gotchas

- `do_item_id` is nullable in the schema but treat it as required — the API refuses a null on every write path regardless of what the DDL allows.
- Never add an incremental `+qty` inventory write beside `resyncInventoryForReturn` — the two will double-apply.
- Use `c.get('houzsUser')?.id` for scope checks inside `/api/scm/*`, never `c.get('user').id` (the bridge's pinned identity, not the caller's).
- There is no mobile-specific screen for this module — don't build one assuming the desktop/mobile parity rule applies here.
- No status whitelist is enforced beyond the DB enum, and there is no line-level status lock — a CANCELLED or REFUNDED return's lines are still editable through the item endpoints; don't assume the status protects them.
- The cancel-final refusal puts its message in `reason`, while DO/CN/PC siblings use `message` — a generic error-body reader will show blank for one of them.

## Where the code is

- `backend/src/scm/routes/delivery-returns.ts` — main API surface.
- `backend/src/scm/routes/delivery-return-exports.ts` — line-level export.
- `backend/src/scm/lib/return-unlinked-lines.ts` — unlinked-line detection.
- `backend/src/scm/lib/line-link-item-identity.ts` — same-product link guard.
- `backend/src/scm/lib/delivery-return-list-read.ts` — list read shape.
- `backend/src/scm/lib/source-cost.ts` — company-scoped source cost lookup.
- `frontend/src/pages/scm-v2/DeliveryReturnsListV2.tsx`, `DeliveryReturnDetailV2.tsx`, `DeliveryReturnNew.tsx`, `DeliveryReturnFromDo.tsx` — desktop surfaces.

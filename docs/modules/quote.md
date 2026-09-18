# Quote

A saved POS cart, priced and named to a customer, that has not yet become an order — the only pre-sale document in the SCM surface. A quote never reaches AutoCount; nothing syncs until it becomes a Sales Order. What a quote becomes: `docs/modules/sales-order.md`.

## Statuses and flow

"Open" means `promoted_to_order_id IS NULL AND cancelled_at IS NULL` — both conditions, not just the first. `POST /` saves the current cart as a quote (server-mints the id as `QU-XXXXXXXX`); `PATCH /:id` updates an OPEN quote's cart in place (customer name/phone are left alone, and a promoted or cancelled quote 404s `not_found_or_converted`); `PATCH /:id/cancel` retires it — idempotent (an already-cancelled quote returns 200 unchanged), refuses an already-promoted quote (409 `already_converted` — "cancel the order, not the quote"). There is no delete; cancel is the only retirement path.

**There is no frontend for this module yet** — no desktop page, no mobile screen, no query hook anywhere in `frontend/src` calls `/api/scm/quotes`. It is an API-only port waiting for the POS UI that will consume it; a change here breaks no screen today, but whatever screen arrives first will be the first real exercise of these endpoints.

## Permissions

- `scmAreaGuard("scm.sales.orders", { writeLevel: "view" })` — deliberately lets anyone with VIEW on Sales Orders write here, not only those with write access, because a pre-sale cart is something any salesperson who can see orders should be able to save. The real access control is the row-level scoping below, not this gate.
- Row-level: a view-all caller (`scm.so.view_all`, or a director position) sees every quote; everyone else sees only their own plus their `manager_id` downline — the same rule and helper the sibling sales lists (SO/DO/SI/DR) use.

## Rules that must not break

- `created_by` must be resolved to the caller's REAL `scm.staff` uuid (`resolveCallerStaffId`), never left as the SCM auth bridge's pinned shared system-staff id — it is the row-visibility key, and a quote stamped with the system id is only visible to a view-all caller.
- Pass the real Houzs integer user id (`c.get('houzsUser')?.id`) to the sales-scope resolver, never `c.get('user').id` — the latter is the pinned system staff uuid and is the documented cause of a 500 for a non-admin caller.
- `PATCH /:id` must only ever touch the cart — customer name/phone/email are not editable through this route.
- A promoted quote must never be cancellable — the resulting Sales Order is the live document from that point on.
- There is no RLS on `scm.quotes` (service-role client) — the area guard plus the handler's own row-level filter ARE the entire access boundary; don't add a query path that skips the row-level filter.

## Gotchas

- `expires_at` is declared on the table but written and filtered by nothing — don't build expiry behaviour assuming it already works.
- `showroom_id` is permanently NULL on every row — `company_id` scoping replaced it; the column is kept only for wire-shape compatibility with the ported 2990 code.
- Quote rows written before the `created_by` fix carry the pinned system uuid (no linked staff `user_id`) and are deliberately not backfilled — they are visible only to a view-all caller, which is expected for old rows, not a bug.
- `cancelled_by` and `created_by` intentionally have no FK to `scm.staff` — the auth bridge can pin a caller to a seeded system-staff row that a foreign key would otherwise reject.

## Where the code is

- `backend/src/scm/routes/quotes.ts` — the full API surface.

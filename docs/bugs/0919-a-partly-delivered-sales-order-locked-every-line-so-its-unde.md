## A partly delivered Sales Order locked every line, so its undelivered lines could not be edited [high]

<!-- area: Sales Order -->

**Symptom.** The owner, 2026-09-15, on orders that were partly delivered and then
had their processing and delivery dates opened again:
「这种 partially processed 的，它送完货后，我又把它的 processing 和 delivery 打开，
那就代表它又可以 proceed 了吗？」 The order could not be edited at all — not the
lines still waiting to be delivered, not a new line. His rule:
「如果已经送货了的，你就 remain 着，可能要放灰色之类的，设置成不可以被 edit」 and
「它为什么可以 edit 的原理，是因为它还有东西可以被 convert」.

Measured on production 2026-09-15 (read-only DSN): 63 live orders had at least
one line on a live Delivery Order / Sales Invoice and at least one line that was
not (11 CONFIRMED, 4 IN_PRODUCTION, 23 READY_TO_SHIP, 25 DELIVERED).

**Root cause (traced).** The downstream lock answered an ORDER question for a
LINE write. `soHasDownstream` (`backend/src/scm/lib/downstream-lock.ts`) counts
live `delivery_orders` / `sales_invoices` by `so_doc_no` and returns one refusal
for the whole order; every SO line route (`POST /:docNo/items`,
`PATCH`/`DELETE /:docNo/items/:itemId`, the three TBC routes) and the amendment
submit 409'd on it. The screens mirrored it: `isLocked(status, has_children)` in
`vendor/scm/lib/so-detail-gates.ts` locked the desktop editor and
`setLineLocked(... has_children)` the phone editor. Nothing in the chain looked at
WHICH line a delivery order carried.

Three smaller holes sat beside it and are closed by the same rule:
- the header Delivery Date cascade (`scm.apply_so_header_cas`, migration 0330)
  rewrote `line_delivery_date` on EVERY line, delivered ones included, and
  `applySoAmendment` did the same for an approved date / State change;
- `POST /:docNo/items/:itemId/override` (admin price override) had no downstream
  check at all, so a delivered line's price could be changed;
- the free-gift reconciler could delete a gift line that had already shipped, and
  the delivery-fee rebuild could rewrite a fee line already on a DO.

**Fix.** One rule, `backend/src/scm/shared/so-line-freeze.ts` (byte-identical
copy in `frontend/src/vendor/shared/`): a line is FROZEN when a non-CANCELLED
delivery order line (DRAFT counts) or sales invoice line names it; partly
delivered is wholly frozen; a live downstream line naming no SO line freezes
every line (fail closed); the order stays open while any live line is unfrozen.
- Server: `readSoLineFreeze` + `soLineWriteRefusal` replace the order-wide
  refusal on every line write (409 `so_line_frozen`); a fully frozen order still
  refuses a new line (409 `so_has_downstream`). The amendment submit and
  `applySoAmendment` refuse a change to a frozen line and skip frozen lines in
  their cascades. Cancel and the header identity lock keep `soHasDownstream`.
- Migration `20260915T1200_scm_so_header_cas_skip_frozen_lines.sql`: the header
  CAS no longer moves a frozen line's delivery date or warehouse.
- Detail payload: `downstream_frozen` per line, `downstream_fully_frozen` on the
  header; desktop and phone grey the frozen line and disable it, keep siblings
  and Add Line open, and disable exactly the identity fields the server refuses.

Pinned: `backend/tests/soLineFreezeRoutes.test.ts` — against the unfixed route
8 of 10 fail (`so_has_downstream` where `so_line_frozen` / 204 was expected),
all 10 pass after. `backend/src/scm/shared/so-line-freeze.test.ts`,
`backend/src/scm/lib/downstream-lock.line-freeze.test.ts`,
`backend/tests-pg/soHeaderCasSkipsFrozenLines.pg.test.ts` (the SQL cascade, real
Postgres in CI), `frontend/src/pages/scm-v2/SalesOrderDetail.frozenLines.test.tsx`,
`frontend/src/mobile/MobileNewSO.frozenLines.test.tsx`,
`frontend/src/vendor/shared/so-line-freeze.canonical.test.ts`.

**Ref.** fix/so-per-line-delivery-freeze, 2026-09-15.

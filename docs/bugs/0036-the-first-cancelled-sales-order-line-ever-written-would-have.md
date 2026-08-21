## The first cancelled sales-order line ever written would have printed on a customer PDF, and could have made a sofa order permanently un-shippable [high]

**Symptom** - none seen yet by staff, and that is the point: the two conditions
were created hours apart by two changes that did not know about each other, on
two live orders (`HC-SO-012624`, `HC-SO-013167`).

**Root cause (traced, not guessed)** - `scm.mfg_sales_order_items.cancelled` has
existed for a long time and ~85 places filter on it, but until 2026-08-10
**nothing had ever written it and production held zero such rows**, so no reader
had ever been exercised with one. `restore-deleted-so-lines.mjs` (PR #1937, run
31424084270) then reinstated two hard-deleted sofa modules as `cancelled = true`
- correctly, under the owner's rule 不可以删只可以 cancel - and became the first
writer. Two readers were wrong for a cancelled row:

- `sofa-batch-guard.findIncompleteSofaSets` defines a sofa set as every line of
  the SO with `stock_status = 'READY'`, with no cancelled filter. A cancelled
  line can never appear on a DO, so it would be missing from every delivery and
  the guard would refuse **every DO for that Sales Order** with 409
  `sofa_partial_set`, naming an item the operator had already removed.
  `HC-SO-012624` is `READY_TO_SHIP` with two READY sofa modules, so it was one
  column away from being un-deliverable. It escaped only because the restore
  script enumerates its INSERT columns and never writes `stock_status`, leaving
  the row on the column default instead of the READY sibling's value - and
  `so-stock-allocation` filters `cancelled = false`, so nothing would ever have
  moved it. Avoided by an omission in a repair script, not by any guard.
- `GET /mfg-sales-orders/:docNo` returns cancelled rows deliberately (they are
  the order's history), and `sales-order-pdf.ts` had no notion of `cancelled`
  and totalled every row handed to it. Only `SalesOrderDetailV2.tsx` filtered.
  The mobile detail, the SO list bulk print and both consignment callsites did
  not, so a phantom sofa module printed on a customer-facing document. RM 0 in
  this instance only because the importer puts a build's whole price on its
  first piece.

**Fix** - both reads in `findIncompleteSofaSets` now filter `cancelled = false`,
so the set definition no longer depends on how a row was written.
`renderSalesOrderInto` - the single function the one-doc and combined generators
both render through - drops cancelled rows, putting the gate in one place
instead of five; `MobileSODetail` also filters at the use site so the phone and
desktop V2 agree. The two production rows were left exactly as they are:
un-cancelling puts a phantom module back into a live order, and deleting them
again is what caused this. `backend/scripts/check-cancelled-so-line-readers.mjs`
+ **Cancelled SO line — reader check (read-only)** replays each guard's own
predicate against the live rows so the next person measures instead of arguing.

**Ref** - 2026-08-11, PR #1956. Evidence and the remaining gaps in
`docs/autocount-line-retirement-plan.md`.

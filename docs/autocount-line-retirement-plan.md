# Line retirement — what has to change before a line can be cancelled instead of deleted

**Status: NOT SHIPPED. This is the evidence for why, and the order to do it in.**

Date: 2026-08-11.

---

## The rule and the gap

The owner's rule is that nothing is ever deleted, only cancelled. Two ERP routes
break it today, and both hard-delete the row:

| route | file | what it does now |
|---|---|---|
| `DELETE /:docNo/items/:itemId` | `backend/src/scm/routes/mfg-sales-orders.ts` (delete executes ~line 8403) | hard-deletes a sales-order line |
| `DELETE /:id/items/:itemId` | `backend/src/scm/routes/mfg-purchase-orders.ts` (~line 3140) | hard-deletes a purchase-order line |

There is a third, and it is not operator-driven, which makes it worse:
`backend/src/scm/lib/free-gift-reconcile.ts:127` hard-deletes free-gift lines
behind the operator's back.

The AutoCount half already exists. `AcSyncService` accepts `Retire: true` on an
`/edit` line and applies `Qty = 0` + `Transferable = false` + an
`[ERP-CANCELLED]` `Desc2` marker — the only shape the 2.2 SDK allows, since no
detail class exposes a line-level `Cancelled` and only `SalesOrder` has
`DeleteDetail`. **What is missing is the ERP flag to drive it from.**

---

## Why this was not shipped in the same pass as the guard

Because a half-converted soft-cancel is **worse than the hard delete it
replaces**. The hard delete is at least consistent: the row is gone, so every
reader agrees it is gone. A retained `cancelled = true` row is only correct if
every reader excludes it, and today many do not.

Two full sweeps were run against the tree on 2026-08-11. Both found gaps that
would cause real damage on the day the first cancelled row appears.

### Sales orders — the column exists, the writers do not

`scm.mfg_sales_order_items.cancelled boolean NOT NULL DEFAULT false` already
exists in production. About 85 places filter on it. But:

- **nothing in the codebase ever writes `cancelled = true`**, and
- **production has zero rows with it set** (verified by read, 2026-08-11).

So no reader has ever been exercised with a cancelled line. Converting the
delete would create the first ones. The gaps that matter most:

| # | where | what breaks |
|---|---|---|
| 1 | `scm/lib/so-stock-allocation.ts` — correctly EXCLUDES cancelled | and therefore never re-derives those rows, so `stock_status`, `stock_qty_ready` and `allocated_batch_no` freeze at their last live value. Nothing clears them on cancel. |
| 2 | `scm/lib/sofa-batch-guard.ts` `findIncompleteSofaSets` | defines the set as every line with `stock_status = 'READY'`, no cancelled filter. With (1), a sofa module cancelled while READY becomes a permanent phantom set member and **every DO for that SO is refused** `sofa_partial_set`, naming an item the operator already removed. |
| 3 | `scm/lib/amendment-po-followup.ts` and `scm/lib/so-revision.ts` | build `currentIdSet` with no cancelled filter, then compute `removed = prev \ current`. A soft-cancelled line stays in `current` forever, so it is **never classified REMOVED** — its bound PO line is never orphaned, never warned about. The supplier keeps building the item the customer cancelled. Today the hard delete plus `ON DELETE SET NULL` does this implicitly. |
| 4 | `frontend/src/mobile/MobileSODetail.tsx`, `MfgSalesOrdersListV2.tsx` bulk print, and `frontend/src/vendor/scm/lib/sales-order-pdf.ts` | the PDF generator has no notion of `cancelled` and totals every row handed to it. Desktop filters; **mobile does not**. A cancelled line is printed and charged on a customer-facing document. |
| 5 | `scm/routes/mfg-purchase-orders.ts` `/from-sos` picks and the bulk PO create | no cancelled check, so a cancelled SO line stays purchasable. |
| 6 | `scm/lib/free-gift-reconcile.ts` | builds `existing` from non-cancelled rows only, so cancelling a GIFT line makes it regenerate on the next edit; and its `max(line_no)` over non-cancelled rows can collide with a retained row's number. |

Confirm/readiness gates, DO creation and SO->PO convert were checked and are
**already correct**.

### Purchase orders — the column does not exist at all

`scm.purchase_order_items` has **no** `cancelled` column, so this half needs a
migration plus every reader taught to exclude one. The sweep found ~80 reads.
Load-bearing ones:

- `recomputePoTotals` and `recomputePoExpectedAt` — a cancelled line keeps
  contributing money and can keep dragging the header ETA earlier.
- `recomputeSoPicked` — a cancelled PO line keeps holding SO quota, so the SO
  line never reappears in the From-SO picker. The hard delete gives this for
  free today.
- `grns.ts` PO completion (`every(received_qty >= qty)`) — a cancelled,
  never-received line means the PO **can never reach RECEIVED**. The same logic
  is duplicated in SQL in `0231_po_received_qty_backfill.sql` and in the view
  `scm.v_po_outstanding` (`0084_multicompany_views.sql`).
- `grns.ts` `/outstanding-po-items` — a cancelled line stays receivable.
- MRP supply, `do-live-allocator`, inventory "incoming", `po-so-coverage`,
  `procurement-learning`.
- `0235_scm_po_item_allocations.sql` has a `BEFORE UPDATE OF qty` trigger that
  will fire if the cancel also zeroes qty.

---

## Order to do it in

Ship as **two** PRs, SO first. Each must be complete on its own side.

### PR 1 — sales-order lines

1. On cancel, reset the derived columns in the same statement:
   `stock_status`, `stock_qty_ready → 0`, `allocated_batch_no → NULL`,
   `po_qty_picked → 0`. This alone kills gaps 1, 2 and most of 5.
2. Make `removedSoItemIds` cancelled-aware in **both**
   `amendment-po-followup.ts` and `so-revision.ts` (gap 3). This is the one that
   costs real money at the supplier; do not defer it.
3. Filter `cancelled` **inside** `sales-order-pdf.ts` (gap 4), not at each of the
   four callsites — one gate, not four chances to forget.
4. Wire the existing `soLinkTargetRefusal` into `/from-sos` picks and the bulk PO
   create (gap 5).
5. `free-gift-reconcile.ts`: soft-cancel gifts instead of deleting, include
   cancelled gifts in `existing`, take `max(line_no)` over all rows (gap 6).
6. Only then convert `DELETE /:docNo/items/:itemId` to
   `UPDATE ... SET cancelled = true`.
7. Keep the create-rollback deletes untouched. supabase-js has no transaction and
   those deletes are the only thing preventing headerless orphan documents.

### PR 2 — purchase-order lines

1. Migration adding `cancelled boolean NOT NULL DEFAULT false` to
   `scm.purchase_order_items`. Take the number at merge time.
2. Update `scm.v_po_outstanding` in the same migration.
3. Teach the load-bearing readers listed above, PO completion first.
4. Then convert `DELETE /:id/items/:itemId`.

### PR 3 — drive the AutoCount retirement

Only after 1 and 2. Send `Retire: true` on a cancelled line in `composeEdit`,
instead of omitting the line. Requires the line to still carry its
`linked_ac_dtlkey`, which is exactly why line identity had to come first.

---

## One trap to remember

A retained cancelled row keeps its `linked_ac_dtlkey`. If the operator re-adds
the same item and a later backfill assigns that same AutoCount `DtlKey` to the
new row, **two ERP rows point at one AutoCount line** and an edit addresses it
from both. Nothing enforces uniqueness today — there is no unique index on
`linked_ac_dtlkey`. Either clear the key when a line is cancelled, or add a
partial unique index. Clearing it is simpler and loses nothing: a retired line
never needs to be addressed again after the retirement itself has synced.

---

## See also

- `docs/modules/autocount-writeback.md` section 7a — line identity and the refusal
- `docs/autocount-service-deploy.md` — the `Retire: true` contract and how to
  verify it against a test book

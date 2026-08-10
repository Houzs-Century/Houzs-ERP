# Line retirement — what has to change before a line can be cancelled instead of deleted

**Status: NOT SHIPPED. This is the evidence for why, and the order to do it in.**

Date: 2026-08-11.

---

## ⚠️ The "zero cancelled rows" premise is FALSE as of 2026-08-10

This plan was written believing no reader had ever met a cancelled sales-order
line. **Production now holds two**, created hours before this plan, by a repair
that did not know this study existed (and vice versa):

| document | line | why it is cancelled |
|---|---|---|
| `HC-SO-012624` | `9050-2S`, qty 1, unit 0, total 0 | hard-DELETED by `apply-sofa-compartment-corrections.mjs` in run 31393696809, reinstated CANCELLED by `restore-deleted-so-lines.mjs` (PR #1937, run 31424084270) under the owner's rule 不可以删只可以 cancel |
| `HC-SO-013167` | `8030-1S`, qty 1, unit 0, total 0 | same |

Both are sofa modules — exactly the shape gap 2 below describes. So the gaps
stopped being hypothetical the moment those rows landed. What was actually
observed, and what was done about it, is in
**[Observed on the first two cancelled rows](#observed-on-the-first-two-cancelled-rows)**
at the foot of this file. Read that before acting on anything above it.

Anyone extending this plan should note the mechanism that made the collision
possible, because it is not specific to sofas: the restore inserts an explicit
column list that does **not** include `stock_status`, `allocated_batch_no`,
`warehouse_id` or `linked_ac_dtlkey`, so a restored row lands on the column
defaults rather than inheriting the sibling's derived state. That is what
decides whether gap 2 bites, and it was luck rather than design.

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

- **no ERP ROUTE ever writes `cancelled = true`** — still true; the two rows
  that exist were written by a one-shot repair script, not by the application,
  so the operator-facing retirement path is still unbuilt, and
- ~~**production has zero rows with it set**~~ — **FALSE since 2026-08-10.**
  Two rows exist; see the correction at the top of this file. The original
  reading (2026-08-11, earlier the same day) was correct when taken and was
  overtaken within hours.

The gaps below were therefore written as predictions and are now partly
measured. Gaps 2 and 4 have been closed in code (see the foot of this file);
the rest still stand. The gaps that matter most:

| # | where | what breaks |
|---|---|---|
| 1 | `scm/lib/so-stock-allocation.ts` — correctly EXCLUDES cancelled | and therefore never re-derives those rows, so `stock_status`, `stock_qty_ready` and `allocated_batch_no` freeze at their last live value. Nothing clears them on cancel. |
| 2 | ~~`scm/lib/sofa-batch-guard.ts` `findIncompleteSofaSets`~~ **CLOSED** | defined the set as every line with `stock_status = 'READY'`, no cancelled filter. With (1), a sofa module cancelled while READY became a permanent phantom set member and **every DO for that SO was refused** `sofa_partial_set`, naming an item the operator already removed. Both of its reads now filter `cancelled = false`. |
| 3 | `scm/lib/amendment-po-followup.ts` and `scm/lib/so-revision.ts` | build `currentIdSet` with no cancelled filter, then compute `removed = prev \ current`. A soft-cancelled line stays in `current` forever, so it is **never classified REMOVED** — its bound PO line is never orphaned, never warned about. The supplier keeps building the item the customer cancelled. Today the hard delete plus `ON DELETE SET NULL` does this implicitly. |
| 4 | ~~`frontend/src/mobile/MobileSODetail.tsx`, `MfgSalesOrdersListV2.tsx` bulk print, and `frontend/src/vendor/scm/lib/sales-order-pdf.ts`~~ **CLOSED** | the PDF generator had no notion of `cancelled` and totalled every row handed to it. Only `SalesOrderDetailV2.tsx` filtered; mobile detail, the list bulk print (`fetchSoBundle` returns `detail.items` verbatim) and both consignment callsites did not. `renderSalesOrderInto` — the one function the single and combined generators share — now drops cancelled rows, so the gate is one place instead of five. `MobileSODetail` also filters at the use site, matching desktop V2. |
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
3. ~~Filter `cancelled` **inside** `sales-order-pdf.ts` (gap 4), not at each of the
   four callsites — one gate, not four chances to forget.~~ **DONE** — done
   ahead of the rest because the two rows that already exist are printable
   today. Step 1 is now the only thing standing between here and a safe
   conversion, and gap 2 no longer depends on it for correctness.
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

## Observed on the first two cancelled rows

Date: 2026-08-11. Everything here is a production read, not a reading of the
code. The standing tool is **Actions → Cancelled SO line — reader check
(read-only)** (`backend/scripts/check-cancelled-so-line-readers.mjs`), which
replays each guard's own predicate against the live rows instead of arguing
about them. Re-run it before touching any of this.

### The documents

| | `HC-SO-012624` | `HC-SO-013167` |
|---|---|---|
| header status | `READY_TO_SHIP` | `CONFIRMED` |
| lines | `9050-1A(LHF)` READY · `9050-2A(RHF)` READY · **`9050-2S` CANCELLED** · `DISPOSE` PENDING | `8030-1A(RHF)` PENDING · **`8030-1S` CANCELLED** · `8030-2A(LHF)` PENDING |
| delivery orders | none | none |

`HC-SO-012624` is the live risk: it is `READY_TO_SHIP` with two READY sofa
modules, so it is the one an operator would try to deliver.

### Gap 2 (`sofa_partial_set`) — was NOT live, and is now impossible

The set `findIncompleteSofaSets` builds is `stock_status = 'READY'` AND sofa.
The restored rows escaped it only because `restore-deleted-so-lines.mjs`
enumerates its INSERT columns and never writes `stock_status`, so both landed on
the column default rather than inheriting the READY sibling's value. Nothing
would then have moved them: `so-stock-allocation.ts` filters `cancelled = false`
and so never re-derives them (that is gap 1, still open).

So the shipping block was avoided by an omission in a repair script, not by any
guard. It would have bitten the first time a row was cancelled while READY —
which is exactly what converting `DELETE /:docNo/items/:itemId` would do. Both
of the function's reads now filter `cancelled = false`, so the set definition no
longer depends on how a row got written.

### Gap 3 (supplier-side PO orphan) — not live for these two

`removed = prevLineIds \ currentIdSet` is driven by `so_revisions.snapshot`, and
the orphan step then follows `purchase_order_items.so_item_id`. Neither can
reach these rows: the restore inserted **new** uuids, so no earlier snapshot
names them, and the original ids were `ON DELETE SET NULL`-ed off the PO lines
when the hard delete ran. There is no supplier obligation left pointing at a
cancelled line on either document, so there is nothing for the orphan pass to
skip. The gap itself is untouched and still blocks conversion.

### Gap 4 (customer PDF) — WAS live, on both documents

`GET /mfg-sales-orders/:docNo` applies no cancelled filter — deliberately, since
the detail screen may want the history — so both restored rows were in the
payload every print path consumes. Printing either document from the phone, or
from the desktop list's bulk print, put a phantom sofa module on a customer
document. The money was RM 0 in this instance because the importer puts a
build's whole price on its first piece; the row was still there, and the next
one need not be free. Fixed as described in gap 4 above (PR #1956).

### What was NOT changed, and why

The two rows were left exactly as they are. Un-cancelling them would put a
phantom module back into a live order; deleting them again is the thing the
owner's rule forbids and is what caused this. Teaching the readers is the
durable fix and was needed before retirement could ship anyway.

## See also

- `docs/modules/autocount-writeback.md` section 7a — line identity and the refusal
- `docs/autocount-service-deploy.md` — the `Retire: true` contract and how to
  verify it against a test book
- `backend/scripts/restore-deleted-so-lines.mjs` — what created the two rows
- `backend/scripts/check-cancelled-so-line-readers.mjs` — the standing evidence tool

# Module: Salesperson handover (SCM)

> **Line numbers here are INDICATIVE.** Resolve a route to its current line with
> the generated artifact, which is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Moving a salesperson's Sales Orders to another salesperson. Written 2026-08-17
when the owner asked, on a resignation: *"如果第一个销售人员PIC辞职，销售订单是否
可以分配给第二个人PIC来更新销售订单"*.

Read `sales-order.md` first — this module only moves ONE column on an order, but
that column decides who can see it.

---

## 1. Why this needed a module at all

`mfg_sales_orders.salesperson_id` is not decoration. It is the key SO row-level
visibility filters on (`sales-order.md` §2, the `scopeIds` `in('salesperson_id', …)`
on the list, detail, count and money queries). So an order left on a departed rep
is not merely mis-labelled — **it is invisible to the person now answering that
customer**, and it stays in the departed rep's My-Cases-style scope.

Two things blocked the fix before 2026-08-17:

1. **`salesperson_id` was in the SO identity lock** — frozen once a non-cancelled
   DO / SI existed. That was collateral, not intent: a Delivery Order and a Sales
   Invoice snapshot the customer, the addresses and the money. Neither snapshots
   *who sold it*. The owner ruled the column out of the lock; everything else in
   `SO_IDENTITY_LOCK_COLS` stays frozen.
2. **The header PATCH had no server-side permission check.** It mapped
   `salespersonId` straight through and relied on the SO Detail page disabling
   the select. The route's scope check only proves the order is the caller's
   OWN, so a self-scoped salesperson could hand their own order to anybody.

Both now live in `backend/src/scm/shared/so-identity-lock.ts`, which is the file
to read before changing any of this.

## 2. The `agent` carve-out — the part that is easy to break

`agent` is the AutoCount rep NAME on the header, and it IS identity-locked.
`scm/lib/so-agent.ts` (`followSalespersonToAgent`) makes it follow a reassigned
salesperson so the account book, the SO list and the Detail Listing stop naming
the previous rep.

Those two facts fight each other: unlocking `salesperson_id` alone is dead on
arrival, because handing over a delivered order also writes the new name into
`agent` and the lock 409s on THAT instead. So the header PATCH records whether
`agent` changed *only* because it followed the salesperson, and
`changedIdentityLockCols(updates, before, { agentFollowedSalesperson })` exempts
exactly that case. A client-authored `agent` never sets the flag and stays
locked.

If a future change moves the follow, moves the lock check, or reorders them, this
carve-out is what silently breaks — the symptom is a 409 `so_identity_locked`
naming `agent` on an otherwise legitimate handover.

## 3. Surface

| Method | Path | Permission | Purpose |
|--------|------|-----------|---------|
| GET | `/api/scm/so-handover/preview?from=<staffId>` | `scm.so.attribute_other` | Every SO in the active company currently attributed to that staff id: `{ from, total, truncated, batchMax, orders[] }`, capped at 500 |
| POST | `/api/scm/so-handover/apply` | `scm.so.attribute_other` | Moves a named batch: `{ fromStaffId, toStaffId, docNos[] }` → `{ moved[], skipped[] }` |

Both in `backend/src/scm/routes/so-handover.ts`, mounted in `scm/index.ts` behind
the `scm.sales.orders` area guard. The preview is gated too — it enumerates
another salesperson's order book.

Also reachable per-order: the header PATCH (`salespersonId`) from SO Detail, same
permission, same audit. On a hard-locked (DO/SI) order the page-level **Edit**
button opens for a caller who may re-attribute, and only the Salesperson field
opts out of the lock — every other field stays disabled, so **Override** is still
the door for addresses and lines.

### Refusals

| Status | Body | When |
|---|---|---|
| 403 | `forbidden` | caller lacks `scm.so.attribute_other` |
| 403 | `forbidden_attribute_other` | same, via the header PATCH |
| 400 | `missing_staff` / `same_staff` / `no_orders` / `too_many_orders` | payload guard, `parseHandoverBody` |
| 409 | company-unresolved refusal | no active company on the request |

## 4. Why apply() is shaped the way it is

- **The operator sees the list first.** Three steps — pick who is leaving, read
  the exact orders, pick who takes them. Reassignment is bulk and irreversible-ish
  (an undo is another handover), so the middle step is the product, not a
  formality.
- **`docNos` is explicit, never "everything for this staff id".** The preview can
  be minutes old, so `apply` re-reads each order and **skips any whose
  `salesperson_id` is no longer `fromStaffId`**, reporting the reason. Without
  that re-check a stale tab could move an order somebody else had just claimed.
- **25 per batch** (`HANDOVER_BATCH_MAX`). Each order costs a read, a write, an
  audit row and an AutoCount enqueue; the UI loops batches and shows progress. A
  60-order POST that 524s halfway is worse than four clean batches.
- **Per-order reporting, not a count.** `{ moved, skipped }` — a handover that
  half-applied in silence is how an order goes missing from both reps' lists.
- **No financial column is written.** Commission is booked off the DO / SI
  snapshots, which keep the rep who sold the order; moving the SO re-books
  nothing.

## 5. What each moved order writes

| Sink | What lands |
|---|---|
| `mfg_sales_orders` | `salesperson_id` = new staff; `agent` = new staff's name (skipped when that name cannot be read — a stale name beats an empty one) |
| `mfg_so_audit_log` | `recordSoAudit` `UPDATE_DETAILS`, field changes `salespersonId` and `agent` with from → to, note `Salesperson handover` |
| AutoCount outbox | `enqueueEdit({ docType: 'SO', touchedFields: ['agent'] })` — see `autocount-writeback.md`; without it the account book keeps naming the departed rep |

## 6. Frontend

`frontend/src/pages/scm-v2/SalespersonHandover.tsx`, rendered as a collapsible
section on **SO Maintenance** (`/scm/sales-orders/maintenance`) behind the same
permission the API enforces.

- **From** reads the FULL roster (`useStaff`) — the person handing over is usually
  deactivated already, and an active-only list would hide the exact case this
  tool exists for. Inactive people are labelled.
- **To** reads `usePickableStaff` (company-scoped, active only), so an order can
  never land on a departed or cross-company rep.
- Both pickers are the house `SearchableSelect`.

## 7. Tests

| File | Pins |
|---|---|
| `backend/src/scm/shared/so-identity-lock.test.ts` | what still freezes, that `salesperson_id` does not, the `agent` carve-out, and that the carve-out smuggles nothing else through |
| `backend/src/scm/routes/so-handover.test.ts` | the payload guard: both staff ids required, no self-handover, dedupe, the batch cap |
| `frontend/src/pages/scm-v2/SalespersonHandover.test.tsx` | the preview is a GET before any write, the 25-per-batch chunking, and that skips are reported rather than swallowed |

# Unlinked Document Lines — One Sales Order Delivered Twice COE (Correction of Error)

**Date:** 2026-08-04
**Trigger:** Owner, on the Delivery Order list: *"为什么一张SO可以开两张DO？？"*, then *"GR 也是"*. A read-only production check answered that `2990-SO-2606-019` had **one** delivery order. He replied: *"你在说瞎话吗？昨天明明两个 DO 都是送了一次，明明已经 duplicated 了啊。那你昨天检查，不是浪费你的时间吗？你还说没有，现在库存有没有乱，我都不知道"* — and he was right. Two DISPATCHED delivery orders name that SO, and his Stock Breakdown shows the same pillow leaving the shelf twice.
**Status:** Root cause TRACED. Exposure SIZED against production: **exactly one** affected document on the delivery side, **none** on the receiving side. Go-forward guard shipped on both sides. Remediation (cancelling the duplicate) is an owner action in the app, deliberately not automated.

---

## 1. Incident — what the owner saw

Two delivery orders, both DISPATCHED, both naming `2990-SO-2606-019`:

| DO | Status | Date | Lines |
|----|--------|------|-------|
| `2990-DO-2607-005` | DISPATCHED | Mon 13 Jul | 6, **all unlinked** |
| `2990-DO-2607-017` | DISPATCHED | Thu 23 Jul | 6, all linked |

Identical line for line — `2990 KETTA-FIRM MATT (K)` ×1, `NTYR MEMORY CONTOUR PILLOW` ×2, `TRION-(K)` ×1, and three service lines.

The stock ledger agrees. The owner's own Stock Breakdown for the pillow:

```
23/07/2026  OUT  −2  running 491  2990-DO-2607-017
13/07/2026  OUT  −2  running 495  2990-DO-2607-005
```

**Four units left the shelf for an order of two.** Meanwhile the Sales Order's
own remaining quantity had moved only once, so the SO read as fully delivered
while the warehouse had paid for the goods twice.

## 2. Root cause — traced against the code, not guessed

**A DO line with no `so_item_id` is a full citizen of the stock ledger and a
non-citizen of the Sales Order.** Those two facts together are the whole defect.

- **The stock still moves.** `deductInventoryForDo` reads the DO's OWN lines
  (`delivery_order_items`), not the SO link. An unlinked line ships exactly like
  a linked one.
- **The Sales Order never notices.** `soDeliverableRemaining` derives
  `remaining = ordered − Σ non-cancelled DO lines linked by so_item_id + Σ returns`.
  An unlinked line is in none of those sums.
- **Therefore the guard cannot fire.** The over-delivery check inspects linked
  lines only, and the create path documents the exemption in its own comment:
  *"Ad-hoc lines (no soItemId) are uncapped."* The post-insert race guard has the
  same scope — it re-derives remaining for `linkedSoItemIds`, so a DO whose lines
  are all unlinked passes every gate by having nothing to check.

**Why that exemption was reasonable and still produced this.** "Ad-hoc" was
written meaning *an item the order never asked for* — a replacement part, a
sample, a goodwill item — and for that it is correct. But
`scm.delivery_orders.so_doc_no` is **free text**, not a foreign key. Typing an SO
number into the header and adding the order's own items by hand produces a
document that:

1. displays as that Sales Order's delivery on every screen, because every screen
   reads the header label;
2. ships the order's goods, because the lines are real;
3. takes nothing off the order's remaining, because the lines link to nothing.

`POST /from-sos` — the SO→DO convert — always writes `so_item_id`
(`delivery-orders-mfg.ts`, the `doRows` builder) and cannot produce this shape.
Only the manual `POST /` create and `POST /:id/items` could.

**Tool that proved it:** a read-only production query by header rather than by
link (`backend/scripts/check-doc-splits.mjs`, corrected), confirmed independently
by the owner's Stock Breakdown screenshot showing both OUT movements.

## 3. The second failure — the check agreed with the bug

`check-doc-splits.mjs` was written to answer exactly this question and answered
it wrongly, with no error to suggest it had.

It joined children to the parent through `delivery_order_items.so_item_id`. The
one document shape that matters — the one with no such link — is invisible to
that join. So the check reported "1 Delivery Order", the owner was told the
delivery orders were a legitimate partial split, and he had to point at his own
screen to disprove it.

**A query that traverses a link cannot audit whether the link is there.** This is
the generalisable lesson and it is worth more than the fix: any check whose
`WHERE` clause follows a foreign key is structurally blind to rows where the key
is null. Audit those by the header, or by the absence itself.

The same blindness had already been named on the Sales Invoice side
(`unlinkedFromDoOffenders`, "the link was dropped, so both the ceiling and the
pool are bypassed") and the delivery side simply never inherited it.

## 4. Exposure — sized against production, 2026-08-04

`backend/scripts/scan-unlinked-lines.mjs` + **Unlinked-line scan (read-only)**
sweep every non-cancelled document whose header names a parent while its lines do
not all link to it, and report whether a **sibling** on the same parent covers the
same item at the same qty. Full run:

```
DELIVERY ORDERS — 1 delivery order carries unlinked lines under an SO header.
  Sales Order 2990-SO-2606-019 — 2 DO(s)
    2990-DO-2607-005  DISPATCHED  Mon Jul 13  ALL 6 LINES UNLINKED
    2990-DO-2607-017  DISPATCHED  Thu Jul 23  all linked
    2990-DO-2607-005: DUPLICATE — 6/6 unlinked line(s) already covered by a sibling

GOODS RECEIPTS — None. Every GRN that names a PO has its lines linked to it.
```

**One document, not a class.** The owner's question was *"现在库存有没有乱"* —
the answer is yes, for this order and only this order.

## 5. Shipped

| PR | What | Effect |
|----|------|--------|
| #1581 | `check-doc-splits.mjs` finds children by the **header** as well as the line link, and names unlinked lines explicitly. New `scan-unlinked-lines.mjs` + `unlinked-lines-scan.yml` sweep the whole DB, both sides, and flag sibling-covered duplicates. Also the `pg.array(ids)` → `IN ${pg(ids)}` fix (`operator does not exist: uuid = text`). | The blind spot is closed and the exposure is measurable on demand. |
| (this PR) | `scan-unlinked-lines.mjs` compares status with `IS DISTINCT FROM` rather than `COALESCE(status,'')` — `scm.do_status` is an ENUM and the empty string is not a value it can hold, so the whole query died. | The scan actually reaches its answer. |
| (this PR) | **The guard.** `lib/do-unlinked-so-lines.ts` refuses an unlinked line when the SO named on the header already orders that item code, wired into `POST /` and `POST /:id/items` (409 `unlinked_so_lines`). `lib/grn-unlinked-po-lines.ts` mirrors it for `grn_items.purchase_order_item_id` (409 `unlinked_po_lines`). | The shape cannot be created again on either side. |

**Why the rule is "item is on the named parent" and not "every line must link".**
A blanket requirement would break the legitimate ad-hoc case the exemption was
written for — a replacement part going out on the same trip is not bypassing
anything, and refusing it would push operators back to the workaround that
created this. What is refused is narrower and exact: **delivering what the order
asked for while recording that the order did not ask for it.**

## 6. Remediation — an owner action, in the app, not in SQL

`2990-DO-2607-005` is the one to cancel: it is the unlinked duplicate, so
cancelling it leaves the linked document standing and the Sales Order's
arithmetic intact.

**Cancel through the app.** The cancel path runs `scm.fn_reverse_do_out`, which
restores the DO's ORIGINAL lots at their ORIGINAL per-lot cost, deletes its
`inventory_lot_consumptions` rows so the cancelled sale's COGS leaves the ledger,
and writes a balance-only add-back. `buildDoReversalRows` is the route-side
fallback for a pre-migration DB.

**A hand-written UPDATE would be wrong**, and this is not a stylistic
preference: moving the quantity back by hand leaves the COGS rows standing, so
the movement ledger and the FIFO/costing ledger would disagree by exactly the
cancelled amount — the failure class already documented in
`docs/inventory-ledger-divergence-coe.md`.

**Not automated on purpose.** Cancelling a DISPATCHED delivery is a business
decision about a real shipment, and there is exactly one of them.

## 7. What the audit RULED OUT

- **A duplicate created by the SO→DO convert.** `POST /from-sos` writes
  `so_item_id` on every row it inserts; a convert-created duplicate would have
  been caught by the `over_remaining` pre-check and, failing that, by the Edge #E
  post-insert re-derive. Neither could have passed a DO whose lines all link.
- **A missing race guard on the DO create path.** Initially reported as missing;
  it is not. `/from-sos` has had one since Edge #E, and `POST /` since Audit gap
  #3. The earlier report came from grepping the delivery module for the
  *purchase* side's vocabulary (`verify`, `post-insert`, `re-sum`) — the DO
  side's guard is named `overcommitted`. **Searching one module for another
  module's naming is not a search.**
- **A wider data class.** The scan found one document on the delivery side and
  zero on the receiving side. The GRN guard is preventative, not corrective.
- **The GRN split the owner asked about separately.** One PO receiving into two
  GRNs was checked and is a genuine 3+2=5 partial receipt, not a duplicate.

## 8. Deferred

| Item | Owner | Note |
|------|-------|------|
| Cancelling `2990-DO-2607-005` | Wei Siang | In the app. Reverses the second deduction and closes the stock discrepancy. |
| Whether `so_doc_no` should become a real foreign key | Wei Siang | The free-text header is what let the label and the lines disagree. The guard now stops the harmful case, but the underlying column still permits a header that names an SO no line belongs to. |
| Accessory lines (pillows, 500 at a time) not showing an SO on screen | Wei Siang | Raised in the same conversation. Worth separating clearly: **not displaying** the SO is a presentation change and is fine; **not linking** to it is this defect. |

## 9. Lessons

1. **A nullable link is a nullable guard.** Every rule expressed as "sum the
   children that point at me" is silently waived for children that point at
   nothing.
2. **A query that traverses a link cannot audit whether the link is there.**
   Audit by the header, or by the absence.
3. **When the owner says the screen disagrees with the check, the screen is the
   evidence and the check is the hypothesis.** The check was trusted over a
   first-hand report for a full day.
4. **An exemption written for one meaning of a word will be used for the other.**
   "Ad-hoc" meant *not on the order*; it was reachable as *on the order but not
   linked*. When exempting a case from a guard, state which case in the
   predicate, not only in the comment.

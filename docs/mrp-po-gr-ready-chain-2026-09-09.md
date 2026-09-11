# MRP → PO → GR → READY: the hard-binding chain, verified end to end

**The owner, 2026-09-09:**

> 所以从 MRP 那边教你去 proceed 这个 PO，到了这个 PO 做 GR，它就会跳 ready 等等。
> 全部它都是 hard-binding，也就是 SO 对 PO 的直接针对性 convert 的

**He is right.** Measured against production, read-only, company 1.

---

## The chain, link by link

| link | where it lives | verified |
| --- | --- | --- |
| raise the PO → the PO line carries its sales-order line | `mfg-purchase-orders.ts` — both insert sites write `so_item_id: l.soItemId` | code |
| GR against that PO → the PO line's `received_qty` rises | `recomputePoReceived`, `grns.ts` | code + 123 lines cross-checked against AutoCount |
| `received_qty` → the sales line goes READY | `so-stock-allocation.ts` `dedicatedReady`, built from `purchase_order_items!inner(qty, received_qty)` joined through `so_item_id`, `.gt('po_items.received_qty', 0)` | **418 / 418 on prod** |

**The measurement that settles it.** Every still-outstanding company-1 hard-bound
line (bedframe / sofa / `(SP)` mattress) whose own purchase order is fully
received:

| gate | lines | READY | not READY |
| --- | ---: | ---: | ---: |
| Processing Date set | **418** | **418** | **0** |
| no Processing Date | 2 | 0 | 2 |

Zero exceptions on the released population. The two that did not light are the
processing-date gate doing its job (`allocGated`, owner 2026-08-10 *"它明明都没
有 Processing Date, 干嘛分配呢"*) — **goods in the warehouse against the line's own
purchase order still will not light it until the order is released.**

---

## Two things the model gets slightly wrong

### 1. It is not the MRP page that creates the binding — it is `so_item_id`, and BOTH entry points write it

`from_mrp` is the flag the MRP convert sets, and it does **not** touch the
binding. It changes exactly one thing: the line is excluded from the
`po_qty_picked` recount, so an MRP-raised purchase order does not consume the
sales line's convert quota (`recomputeSoPicked` filters `from_mrp !== true`).
`so_item_id` is written either way.

**And in Houzs Century the MRP button has never been used.** Measured across
every company and every status:

| company | `from_mrp` | PO lines |
| --- | --- | ---: |
| 1 — Houzs Century | false | **1,350** |
| 1 — Houzs Century | true | **0** |
| 2 — 2990 | false | 17 |
| 2 — 2990 | true | 182 |

Every Houzs Century purchase order was raised through the ordinary
*Convert from SO* picker, not from MRP. **This costs nothing** — the binding, the
receipt and the READY flip are identical on both paths — but the flow as
described ("from MRP you proceed the PO") is not the one the staff actually walk
here. Worth knowing before anyone reasons from `from_mrp` as if it marked the
company's purchase orders.

### 2. A DELIVERED line keeps whatever `stock_status` it had — and it will usually say PENDING

**This is the trap that nearly got a defect reported that does not exist.** A
first pass found "24 hard-bound lines fully received and still PENDING" and it
looked exactly like the 2026-08-29 sofa bug recurring. It is not.

`so-stock-allocation.ts` computes `remaining = qty − delivered + returned` and
`if (remaining <= 0) continue;` — a line that has shipped is skipped before it
ever reaches `needs` or `sofaLineRecs`, so nothing updates its `stock_status` and
the last value stands. All 24 were fully delivered:

```
HC-SO-009585  Gary   9058-1A(LHF)  qty 1  delivered 1  PO HC-PO-007009 recv 1  -> PENDING
HC-SO-012049  ubisson 8050-1A(LHF) qty 1  delivered 1  PO HC-PO-009034 recv 1  -> PENDING
```

That is correct: there is nothing left to allocate. But **`stock_status` on a
delivered line is not a statement about that line** and must not be read as one —
any count of "not READY" has to subtract delivered quantity first, or it reports
shipped goods as stuck. Re-measured with `qty − delivered > 0`, the exception
count went 24 → **0**.

Whether a delivered line should be left reading PENDING on screen is a
presentation question and the owner's call; it is not an allocation defect.

---

## What would break the chain

Named so they can be checked rather than rediscovered:

- **No Processing Date** — the line never lights, whatever arrived. 2 lines today.
- **No `so_item_id` on the purchase-order line** — the receipt belongs to nobody
  and the line cannot light through it. 126 proceeded hard-bound lines have no
  purchase order of their own at all, and 3 more (`HC-SO-012025`, WINNIE) have
  one whose lines were never linked
  (`docs/mrp-stock-vs-bound-rules-2026-09-09.md` §3).
- **A non-selling warehouse** (`showroom` / `display` / `service`) — the line is
  forced PENDING and the order is named in `nonSellingBlockedDocs`. None of
  today's population sits in one; both warehouses involved are type `warehouse`.

**Ref.** Measured 2026-09-09 against prod, read-only. Rules read from
`so-stock-allocation.ts`, `mfg-purchase-orders.ts` and `routes/mrp.ts`.

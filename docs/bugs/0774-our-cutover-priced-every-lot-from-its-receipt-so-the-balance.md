## Our cutover priced every lot from its receipt, so the balance sheet reads millions above AutoCount [high]

<!-- area: Inventory, costing, FIFO -->

**Symptom.** The owner asked the question the balance sheet turns on —
「最重要的是一定要跟 AutoCount 一样，要不然我的 balance sheet 之后做的时候会不准、
不一样」. Measured against the book's own remaining-layer store (run
[34436681698](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34436681698)),
on the 961 (item, location) cells where AutoCount's layers add up to AutoCount's
own balance:

| | units | value |
|---|---|---|
| the account book | 7,605 | RM 1,485,503 |
| ours | 10,240 | **RM 2,484,147** |

Part of that is stock we hold and the book does not. The rest is not: on cells
where the quantity agrees to the unit, the value still does not.

| item | units, book vs ours | book value | our value |
|---|---|---|---|
| DL-SERENITY LTX PIL | 94 vs 94 | RM 0 | RM 17,672 |
| NTYR-TECHGEL MEM PIL | 493 vs 493 | RM 25,039 | RM 40,426 |
| ELECTRIC ADJUSTABLE BED MATT (S) | 32 vs 32 | RM 22,273 | RM 37,664 |
| AK-SLEEP ESSENTIAL 7 HOLES | 1,132 vs 1,130 | RM 3,158 | RM 20,340 |

Same units. Several times the money.

**Root cause (traced).** Every cutover lot's `unit_cost_sen` is the cost of the
RECEIPT the lot was relayered out of.
`backend/scripts/cost-zero-cutover-lots-2026-09-09.mjs` says so in its own
source: source 1 is *"THE LOT'S OWN RECEIPT … that is the exact layer, so its
cost is the lot's cost"*, read from `StockDTL` rows with `Qty > 0` carrying their
`FIFOCost`; source 2 is *"THE BOOK'S NEAREST PRICED RECEIPT of the same item to
the lot's own received date"*.

**AutoCount does not value a balance at its receipts' costs.** It keeps the
layers a balance still HOLDS in `UTDStockCostDTL`, and values those — the finding
established by oracle in
`docs/bugs/0773-i-invented-an-autocount-stock-value-that-exists-nowhere-in-a.md`
(that store reproduced 13 of the 16 cells on the owner's own Stock Balance
screenshot; summing `Qty * Cost` over `StockDTL` reproduced 7).

So the two figures disagree **by construction** wherever the layers still open
are not the receipts we priced from — which is every item whose cost moved
between receipts, and this book has plenty: `AMN-SF9058 SOFA` was received at
RM 1,210, RM 1,710 and RM 3,040 inside two weeks, and carries 42 distinct costs
across its layers. Nothing in either system flags the divergence, because each
number is internally consistent: ours is a real receipt's cost, theirs is a real
layer's cost, and only the comparison shows they are not the same number.

**Fix.** `backend/scripts/align-stock-cost-to-autocount-2026-09-10.mjs` stops
deriving a cost and copies the book's: per (item, location) cell it walks
`UTDStockCostDTL`'s remaining layers in `Seq` order against our open lots
oldest-first, and each lot takes the quantity-weighted cost of the slice it
spans. The total equals the book's because the numbers ARE the book's, and
per-lot layering survives — which is the owner's standing FIFO ruling
(「不是跟着FIFO的嘛？」), not one blended figure per item.

It writes one column, `unit_cost_sen`, and every UPDATE names the cost it is
replacing, so a lot re-costed since the measurement matches nothing and is
reported rather than overwritten. Seven branches leave a cell alone; the four
that are policy rather than arithmetic are a quantity that disagrees with the
book (re-costing it would hide a stock difference behind a money change), the
112 cells whose own layers do not add up to their own balance, SERVICE items,
and SOFA — the book prices a whole sofa and our stock is per compartment, so no
lot matches the book's code. A negative balance is followed, not skipped
(owner: 「如果是负库存，你也是要跟着负库存的」).

**State at the time of writing: the repair is PLAN-ONLY and nothing has been
written to production.** `MODE=apply` refuses without
`CONFIRM='align stock cost to autocount 2026-09-10'`, the plan prints both
totals and every per-lot before/after, and whether apply runs at all is the
owner's decision on those numbers. There is no test pinning this: it is a
one-shot data repair against a committed snapshot of the book, and its gate is
the post-apply verification, which re-reads on a fresh connection and asserts
that every touched lot holds the cost the book gave it, no lot went negative,
the lot count and quantities are unchanged, and inventory value moved by exactly
the planned amount.

**Lesson.** A cost has a direction of derivation, and "taken from AutoCount" is
not specific enough to be right. Both scripts read the same book; one asked
*what did these units cost when they arrived*, the other asks *what does the
book say this balance is worth today*. Only the second is what a balance sheet
compares against, and the first is indistinguishable from it until you total
both.

**Ref.** fix/align-stock-cost-to-autocount, 2026-09-10.

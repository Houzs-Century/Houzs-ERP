## The fourteen sales orders on the transfer chain fail the unmigrated-onward proof [high]

**Symptom.** The sales-order tally has counted fourteen documents on the
`单据转换链 — transfer to` axis for days, every one PROCEEDED, with no cause
beside them. A brief for this lane described them as the population the owner
already ruled on for 362 goods-receipt lines — *the delivery orders, invoices
and purchase invoices were deliberately never migrated* (11,443 DOs in the book
against 186 in the ERP; 10,292 invoices against 49; 5,283 purchase invoices
against 55) — and instructed that his ruling ① be applied to them.

**It is the wrong axis, and the code says so in its own words.** A sales order's
`transfer to` is not delivery. `chainEdges` in
`backend/scripts/lib/ac-transfer-chain-run.mjs` declares the SO edge as:

```js
bookCounter: "transferedPoQty",
counterLabel: "how much of the sales-order line has been purchased",
erpCounter: "scm.mfg_sales_order_items.po_qty_picked",
bookCounterField: "SODTL.TransferedPOQty",
```

with a comment saying why: *"SODTL has TWO [counters], and comparing PO children
against `TransferedQty` would be reading the DELIVERY counter and calling the
difference a defect."* The SO→DO edge carries `bookCounter: null` and is not
compared at all, because delivery is computed off `delivery_order_items` every
time it is asked and there is no stored number that can drift.

So the onward document on this axis is a **PURCHASE ORDER**. The unmigrated
delivery-order and invoice history has nothing to do with it.

**The proof gate refuses all fourteen, and it was RUN rather than reasoned
about.** `splitUnmigratedOnwardTransfer` (`scripts/lib/ac-not-a-difference.mjs`)
lets a row out only when four things hold, and gate (d) is *NONE of the onward
documents the book named is one we hold*. Read-only run
[34303210363](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303210363)
(`scripts/check-so-po-counter-causes.mjs`, `main`, book cut
`2026-09-09T00:28:53Z`) resolves the book's named purchase order for every one
of the fifteen disagreeing lines, and every single line comes back
**`ERP doc held, line held`**:

```
counter_stale                   2   HC-SO-000870, HC-SO-013258
decomposed_grain                6   HC-SO-011160 013103 013310 013322 013389 013434
link_missing                    6   HC-SO-010209 010287 010955 011207 012128 012729
book_source_is_another_product  1   HC-SO-000870
```

Gate (d) therefore fails on thirteen of them. The fourteenth, `HC-SO-000870`,
fails gate (c) instead: read off the committed cut
`backend/scripts/data/ac-convert-edges.json.gz`, the book names **no purchase
order at all** raised off `SO-000870`, so there is nothing to explain the
transfer with. `UNMIGRATED_ONWARD` declares only `GR → PI` and `PO → GR`; it has
no `SO` entry, and adding one would have meant weakening the proof rather than
passing it.

**Nothing was added to the bucket.** The whole credibility of that bucket is
that the same run let 283 goods receipts through and refused every purchase
order. A fifteenth-hour extension that fails the gate on all fourteen members
would have spent it.

**What they actually are, measured on the same run.** Thirteen of the fourteen
are one thing: the purchase order and the sales order do not carry the same sofa.
The book holds ONE line (`HOK-5540 SOFA qty 1`, fully transferred); the ERP holds
one line PER COMPARTMENT and the purchase side covers only some of them —

| document | the book | the ERP |
| --- | --- | --- |
| `HC-SO-013103` | 1 of 1 purchased | 1 of 3 rows |
| `HC-SO-011160` | 1 of 1 | 1 of 3 |
| `HC-SO-013322` | 1 of 1 | 1 of 3 |
| `HC-SO-013258` | 1 of 1 | 2 of 3 |
| `HC-SO-013310` `013389` `013434` | 1 of 1 | 1 of 2 |
| `HC-SO-010209` `010955` `012729` | 1 of 1 | 0 of 3 |
| `HC-SO-010287` `011207` `012128` | 1 of 1 | 0 of 2 |

**The comparison is already decomposition-safe, which is why this is real and
not a grain artefact.** `verdictFor` in `scripts/lib/transfer-counter-verdict.mjs`
compares the FRACTION transferred, cross-multiplied as integers — *"the book
moved t of q, the ERP moved T of Q, and t/q === T/Q is the same fact in both
systems whatever Q is"*, with a planted case for exactly this shape
(*"partial, decomposed, and exactly equal - must be silent"*). A sofa whose three
compartments were all purchased would read `agree`. These read `erp_low` because
the purchase order genuinely covers one arm of a three-piece sofa.

**So `decomposed_grain` must NOT be adopted by the reconcile**, and its
"NOT A DEFECT" label is the more dangerous half of this entry.
`isDecomposedGrain` (`scripts/lib/so-po-counter-cause.mjs`) is earned by
arithmetic that is true about a denominator and silent about the warehouse:
`erpCounter === bookTransfered && erpQty === bookQty * rows`. That is precisely
the shape the fraction rule correctly calls `erp_low`. A reader who sees six
documents leave a column headed "differ" reads "settled"; they are not settled —
seven proceeded sofas are on the factory floor with a purchase order for one arm.

**Fix.** None applied, and none owed by us on any of the fourteen.

| documents | what would move it | whose |
| --- | --- | --- |
| `HC-SO-010209` `010287` `010955` `011207` `012128` `012729` (`link_missing`) | the purchase line is present and points at NOTHING. The book names the sales line it was raised from, but the ERP holds 2-3 compartment rows under that one key and the book cannot say WHICH — and matching by code hits mirrored handedness. His ruling of 2026-09-09 on `HC-SO-010287` (「这种就要对齐全部 全部跟着销售单」) says the PO is corrected to match the SO; doing that is a WRITE TO PURCHASE ORDERS and belongs to the PO lane, not here | the owner's drawing, then `backfill-po-so-item-links.mjs` + `recompute-so-po-qty-picked.mjs` |
| `HC-SO-011160` `013103` `013310` `013322` `013389` `013434` (`decomposed_grain`) | the same, and no ruling has been asked for on these seven | the owner's drawing |
| `HC-SO-013258` (`counter_stale`, 2 of 3) | the same — two compartments covered, one not | the owner's drawing |
| `HC-SO-000870` | `PO-000290` line 61216 is an `NB-KHJ57(K)` bedframe whose `FromSODtlKey` names `SO-000870` line 60700, a `MYLATEX LUMBARIA (K)` MATTRESS. Our line points at 60702, whose code matches. Copying the book's edge would put a bedframe purchase on a customer's mattress line — `docs/bugs/0671`. Both book lines also point at 60702, which is why the ERP records 2 picked against a qty-1 line | only the owner can say which line it served |

**Scope.** This entry changed no classifier, no bucket and no stored row.
`po_qty_picked` is a purchasing ceiling and an MRP input, not an on-hand figure,
so 「库存先不看」 is respected by construction — and nothing here writes it either.

**Ref.** fix/so-differ-zero, 2026-09-09. Verdict runs
[34301296779](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34301296779)
(18 differ) and
[34303762513](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303762513)
(19 differ, 37 minutes later — see `docs/bugs/0739` for what moved).

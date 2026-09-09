## Thirteen of the fourteen sales orders on the transfer chain are one thing: the purchase order and the sales order carry different sofa builds [high]

**Symptom.** Run
[34287355432](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34287355432)
on `main`: `SALES ORDERS — 16 differ`. Fourteen of the sixteen differ on
`transfer to`, every one of them PROCEEDED, with no cause beside them. The
verdict says "somebody owes each one" and does not say who.

**The story that was proposed, and why it is FALSE.** The lane was briefed that
these fourteen are the cause the owner already ruled on for 362 goods-receipt
lines — *the downstream documents were deliberately never migrated*, offered as
① count them in their own named bucket or ② migrate the rest, and he chose ①.
The proposal was to extend `UNMIGRATED_ONWARD` (`scripts/lib/ac-not-a-difference.mjs`)
to the sales-order `transfer to` axis.

**It is the wrong axis.** A sales order's `transfer to` is `SODTL.TransferedPOQty`
against `scm.mfg_sales_order_items.po_qty_picked` — *how much of the line has
been PURCHASED* — so its onward document is a PURCHASE ORDER, not a delivery
order, an invoice or a purchase invoice. And the ERP **holds every one** of the
purchase orders concerned, in status `SUBMITTED` or `RECEIVED`. Gate (d) of
`splitUnmigratedOnwardTransfer` — *we must hold NONE of the onward documents* —
would have refused all fourteen as impostors. **The bucket's own proof already
says no; adding it would have meant weakening the proof.** Nothing was added.

**What they actually are, measured.** Read-only run
[34294360771](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34294360771)
(`scripts/check-so-po-counter-causes.mjs`, current `main`, book cut 0.19 days
old) splits the 15 disagreeing lines:

```
decomposed_grain                6   "NOT A DEFECT" per that classifier
link_missing                    6   the purchase line points at NO sales line
counter_stale                   2   a stored number that lags
book_source_is_another_product  1   the BOOK's own edge
```

The `link_missing` six are already named by
`scripts/repair-po-so-link-sofa-compartments.mjs`, whose PLAN run
[34258350931](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34258350931)
refuses each at **gate 4 — the two sides carry DIFFERENT products**:

| document | the purchase side carries | the sales side carries |
| --- | --- | --- |
| `HC-PO-010085` ← `SO-010287` | `9058-2A(RHF)`, `9058-1A(LHF)` | `9058-2A(LHF)`, `9058-1A(RHF)` — MIRRORED |
| `HC-PO-009467` ← `SO-012128` | `9028-1S` | `9028-1A(RHF)`, `9028-1A(LHF)` |
| `HC-PO-009554` ← `SO-012729` | `9058-1S` | `9058-2A(LHF)`, `9058-1A(RHF)`, `9058-CNR` |
| `HC-PO-009587` ← `SO-010209` | `9058-1S` | `9058-1A(LHF)`, `9058-L(RHF)`, `9058-1NA` |
| `HC-PO-009679` ← `SO-010955` | `9058-1S` | `9058-2A(LHF)`, `9058-1A(RHF)`, `9058-CNR` |
| `HC-PO-009830` ← `SO-011207` | `9028-1S` | `9028-L(RHF)`, `9028-2A(LHF)` |

**And the other six are the SAME shape, which is the finding.** `decomposed_grain`
is earned by arithmetic — `erpCounter === bookTransfered` and
`erpQty === bookQty × rows` (`isDecomposedGrain`,
`scripts/lib/so-po-counter-cause.mjs`) — and that arithmetic is true about a
denominator and silent about the warehouse. Before letting six documents out of
a column headed "differ" on it, `scripts/probe-so-po-compartment-cover.mjs` was
written to read both sides. Read-only run
[34295819638](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34295819638),
book cut 0.21 days old, 16 book lines across 7 documents:

```
BOOK  SO-013103 DtlKey 889478  HOK-5540 SOFA  qty 1  TransferedPOQty 1
      the book raised: PO-009783 line 889749 (HOK-5540 SOFA qty 1)
ERP   3 sales-order row(s) carry that line key:
        HC-SO-013103  8030-1A(LHF)  qty 1  po_qty_picked 1  PROCEEDED
        HC-SO-013103  8030-1A(RHF)  qty 1  po_qty_picked 0  PROCEEDED
        HC-SO-013103  8030-1NA      qty 1  po_qty_picked 0  PROCEEDED
ERP   purchase order PO-009783: 1 row(s)
        HC-PO-009783 [SUBMITTED] 8030-1A(LHF)  qty 1  -> THIS sales line
```

The purchase order does **not** carry one row for the whole sofa. It carries
**one compartment** — a single arm — while the sales order carries three pieces.
The same on all six, and `HC-SO-013258` (classified `counter_stale`) is the same
thing again with two of three covered:

| document | the ERP purchase order carries | the ERP sales order carries |
| --- | --- | --- |
| `HC-SO-013103` | `8030-1A(LHF)` | `1A(LHF)` `1A(RHF)` `1NA` |
| `HC-SO-013389` | `8030-1A(LHF)` | `1A(LHF)` `1A(RHF)` |
| `HC-SO-013434` | `8030-1A(LHF)` (+ pillows) | `1A(LHF)` `1A(RHF)` |
| `HC-SO-013322` | `8030-L(LHF)` (+ pillows) | `1A(RHF)` `1NA` `L(LHF)` |
| `HC-SO-011160` | `9058-1A(LHF)` (+ pillows) | `1A(LHF)` `1NA` `L(RHF)` |
| `HC-SO-013310` | `5535-2A(LHF)` (+ pillows) | `2A(LHF)` `L(RHF)` |
| `HC-SO-013258` | `9058-1A(LHF)`, `9058-L(RHF)` | `1A(LHF)` `1NA` `L(RHF)` |

`0 purchase row(s) on those orders point at no sales line at all` — so this is
not a link that was never stamped. **The purchase side is short of compartments.**

**So thirteen of the fourteen are ONE thing:** the purchase order and the sales
order do not carry the same sofa build. Under the owner's own rule —
「一律跟账本。除了sofa compartment而已啊」 — the book decides everything EXCEPT the
sofa build, and the sofa build is his. **These are his drawing, not a repair.**
Six of them are exactly the six a sibling lane is writing his rulings for into
`backend/scripts/data/sofa-compartment-corrections-2026-09.json` right now; the
other seven have not been ruled on and are named above so they can be.

**The fourteenth is the book's own gap.** `HC-SO-000870`: `PO-000290` line 61216
is an `NB-KHJ57(K)` bedframe whose `FromSODtlKey` names `SO-000870` line 60700,
which is a `MYLATEX LUMBARIA (K)` **mattress**. Our line points at 60702, the
line whose product actually matches. Copying the book's edge would put a
bedframe purchase on a customer's mattress line — the class
`docs/bugs/0671-the-delta-sync-dedicated-9-sales-order-lines-to-purchase-ord.md`,
and the reason `causeForGroup` checks `bookSourceProductDiffers` FIRST. Only the
owner can settle which line it was.

**Why `decomposed_grain` must not be adopted by the reconcile.** It reads as
NOT-OUR-DEFECT and is excluded from WORK in
`scripts/check-so-po-counter-causes.mjs`. Its own label is careful — *"linking
every compartment would [make it agree], and where the two builds disagree that
is the owner's drawing"* — but a reader who sees six documents leave a column
headed "differ" reads "settled". They are not settled: seven proceeded sofas are
on the factory floor with a purchase order for one arm. **Nothing was
reclassified**, the sales-order verdict still counts all fourteen, and this
entry is what says why.

**Fix.** None applied to production, and none owed by us on thirteen of the
fourteen. What each one needs:

| documents | what would move it | whose |
| --- | --- | --- |
| `HC-SO-010209` `010287` `010955` `011207` `012128` `012729` | his sofa ruling, then `repair-po-so-link-sofa-compartments.mjs` passes gate 4 and `recompute-so-po-qty-picked.mjs` closes the counter | the owner's drawing (in flight) |
| `HC-SO-011160` `013103` `013258` `013310` `013322` `013389` `013434` | the same, and no ruling has been asked for yet | the owner's drawing |
| `HC-SO-000870` | which sales line `PO-000290` line 61216 really served | the owner |

**Scope.** `scripts/probe-so-po-compartment-cover.mjs` is READ-ONLY and BOUNDED:
SELECTs only, one connection, no writes, no `MODE=apply`, every read restricted
to the documents named in `DOCS`. It moves no stock, and 「库存先不看」 is
respected by construction — `po_qty_picked` is a purchasing ceiling and an MRP
input, not an on-hand figure, and nothing here writes it either.

**Ref.** fix/so-tally-zero, 2026-09-09.

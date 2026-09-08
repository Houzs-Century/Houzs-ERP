## A sofa build that collapses two rows into one cannot be written while a purchase line is dedicated to the row it drops [medium]

<!-- status: open -->

<!-- area: AutoCount sync + write-back -->

**白话.** 老板看图后说 `HC-SO-011099` 那张沙发是「一张两人位」，不是「两张单人位」。
要改的话，两行要并成一行 —— 但被删掉的那一行，工厂那张采购单还指着它，所以系统不敢
删，整张单就改不了。**他的答案没有问题，是我们这边的做法卡住了。** 更要紧的是：如果
只改采购单那一半（那一半是改得动的），工厂看到的会变成两人位，客户那张还是两张单人位
—— 两张纸就对不上了。所以宁可先不动，等把「采购单指向哪一行」修好再一起改。

**Symptom.** The owner ruled `HC-SO-011099` is `2S`. The ERP holds
`1A(LHF)+1A(RHF)`. The apply run refuses it (dry-run `34220106079`):

```
HC-SO-011099: REFUSED — a surplus line is referenced downstream:
9028-1A(RHF): 1 PO line(s), 0 DO line(s)
```

**The dangerous half is the one that does NOT refuse.** The same run plans the
purchase order successfully:

```
HC-PO-009882  9028  1A(RHF)+1A(LHF)  ->  2S  @30"
```

So an unscoped apply would correct the factory's document and leave the
customer's document stating the old build — a chain disagreement created by the
repair itself.

**Root cause (traced).** The build goes from two rows to one on both sides.
`pairRowsToPieces` (`backend/scripts/lib/sofa-build-plan.mjs:239`) reuses one
leftover row for the target piece — *"Reuse a leftover row rather than
delete-and-insert: the id is what carries the dedication"* — and the second row
becomes surplus. The guard in `apply-sofa-compartment-corrections.mjs` then
refuses any surplus row that something downstream points at, which is correct
and is not the defect.

The defect is that **the two sides keep different rows.** Read off production
(probe `34220446190`, section B):

| side | rows, in the order the script pools them | row it keeps | row it drops |
| --- | --- | --- | --- |
| `HC-SO-011099` (by `line_no`) | `1A(LHF)`, `1A(RHF)` | `1A(LHF)` | `1A(RHF)` |
| `HC-PO-009882` (by `id`) | `1A(RHF)`, `1A(LHF)` | `1A(RHF)` | `1A(LHF)` |

The purchase order's surviving row carries `so_item_id` -> the sales order's
`1A(RHF)` row, which is exactly the row the sales order has to delete. So
**ordering does not rescue it**: run the purchase order first and its one
remaining line still points at the row the sales order must drop. A collapse
needs the dedication RE-POINTED onto the surviving row, and nothing does that.

**Fix — none yet; the ruling is parked, not lost.** The entry moved to `_held`
in `sofa-compartment-corrections-2026-08.json`, carrying his ruling verbatim and
this reason. `_held` is the file's own mechanism for a build whose answer is
known and whose write is blocked: `loadCorrections` keeps it in a separate list
that the apply script PRINTS on every run and never writes, so it cannot be
mistaken for done. Proven by the next run (`34221653216`), which printed
`HELD HC-SO-011099 / HC-PO-009882`.

It also keeps the reconcile honest: the new `RULED` verdict is fed only from
WRITTEN builds, so `HC-SO-011099` keeps reporting `DIFFER` — which is true. It
is the one of the three that is still work.

**What a fix must do.** Re-point `purchase_order_items.so_item_id` onto the
surviving sales-order row as part of the collapse, in the same transaction, and
refuse if the two sides do not end up one-to-one. It must not simply relax the
surplus guard: that guard is what stops a row being cut from under a document
that references it.

**Ref.** `fix/apply-sofa-rulings`, 2026-09-08. Dry-run `34220106079`; evidence
probe `34220446190`; held-and-printed `34221653216`.

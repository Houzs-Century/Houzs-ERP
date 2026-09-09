## Five RECEIVED purchase orders hold a sofa placeholder row that is not in the sofa item group, so every sofa tool is blind to it [high]

<!-- status: open -->

<!-- area: Cutover + migrated data -->

**白话.** 有 5 张已收货的采购单，里面那张沙发只有一行「一个座位」的暂代行，**而这
一行没有被归类成沙发**。结果是：所有处理沙发的程式都看不见它 —— 改沙发组件的看不
见、对账的看不见、连回销售单的也看不见。因为看不见，账本说「这张沙发买了」而 ERP
说「买了三分之一」，**5 张采购单 + 5 张销售单，一共 10 张单对不上，全是同一个原因。**
这 5 行本身没有丢货、钱也没错，只是分类错了。

**Symptom.** After the compartment link repair and the counter recompute
([34303926084](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303926084)
and
[34304077476](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34304077476)),
run
[34304334299](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34304334299)
leaves exactly ten documents differing, and they are five pairs:

```
PURCHASE ORDERS — transfer from
  HC-PO-009467  the book raised it from SO-012128 line 833309 — the ERP points at nothing
  HC-PO-009554  ... SO-012729 line 867593
  HC-PO-009587  ... SO-010209 line 694403
  HC-PO-009679  ... SO-010955 line 759060
  HC-PO-009830  ... SO-011207 line 773519

SALES ORDERS — transfer to
  HC-SO-010209  the book moved 1 of 1; the ERP records 0 of 3 over 3 row(s)
  HC-SO-010955  the book moved 1 of 1; the ERP records 0 of 3 over 3 row(s)
  HC-SO-011207  the book moved 1 of 1; the ERP records 0 of 2 over 2 row(s)
  HC-SO-012128  the book moved 1 of 1; the ERP records 0 of 2 over 2 row(s)
  HC-SO-012729  the book moved 1 of 1; the ERP records 0 of 3 over 3 row(s)
```

**What the ERP holds.** Read-only probe run
[34303643215](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303643215)
(`probe-so-po-compartment-cover.mjs`), every one of the five the same shape:

```
ERP   purchase order PO-009587: 1 row(s)
        HC-PO-009587 [RECEIVED] 9058-1S  qty 1  -> NOTHING  key 872577
```

The row exists, it is the model's `-1S` placeholder, and **it carries the book's
own line key**. So neither "the row is missing" nor "the key is missing" is the
cause.

**Root cause, traced — the row is not classified as a sofa, so every sofa tool
filters it out before it is ever considered.** Three independent readings, and a
positive control so the absence is evidence rather than a shrug:

1. **The corrections applier.** Its row query is
   `WHERE i.purchase_order_id = … AND i.item_group = 'sofa'`
   (`apply-sofa-compartment-corrections.mjs:226`). Plan run
   [34302019992](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34302019992)
   answered, for all five and for `HC-PO-010087`:
   ```
   HC-PO-009587: no line matches line key(s) 872577 (the document does not carry
   872577 — the build is not on this document, and matching by text instead would
   write it onto the wrong line) — skipped
   ```
   That message is `selectBuildRows`' `verdict: "none"`, which on a document
   whose row DOES carry the key can only be reached when the query returned no
   rows at all.

2. **The reconcile never compares them.** Its PO section reports
   *"1137 AutoCount lines paired to an ERP line; 700 carry a variant-bearing
   item group (538 bedframe, 162 sofa)"* — and in the whole 977-line log of run
   [34304514097](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34304514097)
   the strings `PO-009587`, `PO-009830` and `PO-010087` appear **zero** times,
   and `PO-009467` appears once, in a goods-receipt money line, never in the
   purchase-order variant comparison.
   ```
   $ for d in PO-009587 PO-010083 PO-009467 PO-009830 PO-010087; do echo "$d -> $(grep -c "$d" po-recon.log)"; done
   PO-009587 -> 0
   PO-010083 -> 6      <- THE POSITIVE CONTROL: a purchase order whose sofa IS compared
   PO-009467 -> 1
   PO-009830 -> 0
   PO-010087 -> 0
   ```
   The control matters: an absence with no control is a broken grep, not a
   finding.

3. **The link repair refuses at gate 4 for the same reason.** Plan run
   [34303773806](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34303773806):
   *"HC-PO-009587 <- SO-010209: the purchase side carries 9058-1S and the sales
   side carries 9058-1A(LHF), 9058-L(RHF), 9058-1NA — a BUILD disagreement, not a
   link one"*. Correct at the grain it works at, and unfixable there: the
   purchase side cannot be given the compartments while the applier cannot see
   the row.

**Why it produces the transfer difference.** `lib/transfer-counter-verdict.mjs`
compares the FRACTION transferred, so a sales order of three compartments agrees
with a book line of one only when all three are picked. One purchase row can
dedicate one compartment; the other two stay at zero for ever. The purchase side
carries no `so_item_id` at all, which is the `transfer from` half.

**What is NOT wrong.** No stock is lost and no money is wrong: the row's quantity
and its receipt are what the book says. The defect is a classification, and its
whole cost is that ten documents cannot be reconciled.

**Fix — NOT APPLIED, and here is exactly why.** Setting `item_group = 'sofa'` on
those five rows would let the applier reach them, and the sequence after that is
already proven on their seven siblings: corrections apply → link repair →
`recompute-so-po-qty-picked`. **All five purchase orders are RECEIVED**, so
correcting the build means relabelling and splitting a line a goods receipt
already points at. 「库存先不看」 — that is not a call this lane makes on its own
judgement, and `downstreamMovedStock` in the applier is the thing that decides
it: it refuses a build whose downstream moved real stock (any
`scm.inventory_movements` row naming the document, or a GRN/DO that is not
`migrated_no_stock`) and prints the figure it refused on. So the next step is
one read-only plan run, not a write.

`HC-PO-010087` is the sixth document of this shape and is **SUBMITTED**, not
received — it is the one where the same repair carries no stock question at all,
and closing it would also close `HC-SO-013389` (`the book moved 1 of 1; the ERP
records 1 of 2`).

**Ref.** fix/ac-align-so-po-gr, 2026-09-09. The purchase-side entries these
documents need are already written and inert in
`backend/scripts/data/sofa-compartment-corrections-purchase-side.json`
(`docs/bugs/0736`); they skip on exactly this.

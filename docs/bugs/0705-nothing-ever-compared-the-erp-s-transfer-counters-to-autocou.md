## Nothing ever compared the ERP's transfer counters to AutoCount's own — "transfer to" was measured twice, never across the two systems [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: open -->

**Symptom.** The owner, 2026-09-08: 「还有 transfer from and o[ut]」, and before
that 「Transfer From 跟 Transfer To 全部都 check 完了」. Everyone answering him
was quoting `check-ac-convert-symmetry`, which reports the transfer-TO question
as clean or nearly clean — and it is, for the question it asks. It is not the
question he asked.

**Root cause (traced, not guessed).** `backend/scripts/check-ac-convert-symmetry.mjs`
asks transfer-TO twice, and both times inside ONE system:

| section | what it compares |
| --- | --- |
| 3 | the book's counter against the book's OWN children |
| 4b | the ERP's counter against the ERP's OWN children |

Neither compares the two systems' counters to each other. Both can read clean
while the ERP believes a different thing from the account book about the same
line — and on the migrated population that is the NORMAL case, not an edge case,
because the receipt that moved the counter happened in AutoCount and the cutover
deliberately created no ERP document for it (`0280`'s own header: *"the keys are
stamped forward"*).

Its own run `34198847720` (2026-09-08 15:20 Malaysia) shows the size of the
blind spot:

```
PO line received_qty vs its GRN children: 140 of 1344 live PO lines DISAGREE
  0 read LOW ... 140 read HIGH (the PO reads received for goods that did not arrive)
GRN line invoiced_qty vs its PI children : 80 of 792 live GRN lines DISAGREE
  0 read LOW ... 80 read HIGH (blocks a legitimate invoice)
SO line po_qty_picked vs its PO children : 22 of 15061 live SO lines DISAGREE
  22 read LOW (ceiling too generous - an over-convert could get through)
  22 of the 22 sit on a MIGRATED order (HC-*); 0 on an ERP-native one
```

Section 4b prints those and **cannot say whether any of them is a defect**,
because the only other witness it has is the ERP itself. 140 purchase-order
lines reading "received" with no ERP goods receipt behind them is either the
migration faithfully copying a receipt AutoCount already made — correct, and the
thing that lets a hard-bound sales line go READY — or 140 purchase orders whose
receipt ceiling is wrongly closed. **Only the book decides that, and nothing was
asking it.**

**Why the comparison is not a subtraction.** One AutoCount line can be several
ERP rows: a sofa is one `DtlKey` and six compartment rows (mig `0273`/`0280`).
Summing the ERP counter across those rows and subtracting the book's single
number reports the decomposition itself as a defect — the same class of reading
error that `docs/bugs/0691` names. The comparison that survives it is the
FRACTION transferred, cross-multiplied so it cannot round: the book moved `t` of
`q`, we moved `T` of `Q`, and `t*Q == T*q` is the same fact in both systems
whatever `Q` is.

**Shipped here (measurement only).**
`backend/scripts/check-ac-transfer-counters.mjs` +
`backend/scripts/lib/transfer-counter-verdict.mjs` (the pure classifier, so the
self-test drives the same function the check calls, never a copy) +
`.github/workflows/ac-transfer-counter-check.yml`. Read-only: SELECTs only, no
writes, no DDL, no transaction, own concurrency group, exit 0 for every
legitimate answer. It compares all three stored ceilings against the book's own
counters, matched by `linked_ac_dtlkey`:

```
scm.mfg_sales_order_items.po_qty_picked  vs  SODTL.TransferedPOQty   (SO -> PO)
scm.purchase_order_items.received_qty    vs  PODTL.TransferedQty     (PO -> GR)
scm.grn_items.invoiced_qty               vs  GRDTL.TransferedQty     (GR -> PI)
```

and it states out loud that SO -> DO and DO -> IV have **no stored ERP counter
at all** — delivery is computed live off `delivery_order_items` — so a reader
cannot mistake their silence for a clean measurement.

**The trap it refuses to repeat.** A goods-receipt query in the reconcile once
selected `NULL::bigint AS ac_dtlkey` — a CONSTANT, not the column — and went on
pairing by position while reporting confidently. Section 1 proves every column
is present AND carries varied data before a single comparison is made, and
REFUSES on a key column that turns out to be single-valued over a population
where that cannot be an accident.

**MEASURED. Run [`34203192972`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34203192972),
2026-09-08 16:11 Malaysia, company 1, against the snapshot exported
2026-09-07T08:39:50Z.** (The first dispatch, `34201730668`, crashed on
`min(uuid)` after the first axis — `docs/bugs/0707`.)

```
    axis      | compared | agree | ERP LOW | ERP HIGH | ERP asserts | unkeyed rows
    ------------------------------------------------------------------------------------
    SO -> PO  |      761 |   735 |      25 |        1 |           0 |          244
    PO -> GR  |     1137 |  1130 |       7 |        0 |           0 |           17
    GR -> PI  |      504 |   142 |     362 |        0 |           0 |          229
```

**`ERP asserts a transfer the book does not have` is ZERO on all three axes.**
Nothing in the ERP claims a conversion AutoCount has no record of. That is the
direction `migration-copy-never-compute` forbids outright, and it is clean.

**The question section 4b could not answer, answered.** Its 140 purchase-order
lines reading HIGH against their own ERP goods receipts, and its 80 goods-receipt
lines reading HIGH against their own purchase invoices, are **the migration
faithfully copying the book**: against AutoCount's own counters, `received_qty`
reads HIGH on **0** and `invoiced_qty` reads HIGH on **0**. There was no ERP
document behind those numbers because the receipt happened in AutoCount, exactly
as `0280` intends. That is 220 lines removed from the suspect list by asking the
right witness, and no code changed to do it.

**What the three axes actually say, in business terms.**

| axis | the finding | what it costs |
| --- | --- | --- |
| SO -> PO, 25 LOW | the book says the purchase for that sales line was already raised; our picker still shows 0 picked | the line is offered again — **a SECOND purchase order for goods already on the way.** This is the shape staff reported on `SO-009708` |
| SO -> PO, 1 HIGH | `SO-000870` `CODY-(K)`: book 1 of 1, ERP **2** of 1 | an over-convert that already happened, or a double-counted cache |
| PO -> GR, 7 LOW | all seven are SOFA decompositions — `book 1 of 1 \| ERP 1 of 2 over 2 rows`, `1 of 4`, `1 of 5` | the book received the whole sofa; we received one compartment. The bound sales line cannot go READY and MRP keeps the order open |
| GR -> PI, 362 LOW | the book invoiced the receipt; our `invoiced_qty` is 0 | **this is the cutover's own scope decision, not a fault**: AutoCount's 4,789 historical purchase invoices were deliberately not imported. The consequence is that those 362 receipt lines can be invoiced AGAIN in the ERP |

**Nothing is repaired from this entry, and each omission has a reason:**

- **SO -> PO is another lane's edge.** PR #3225 (`fix/staff-reported-flow`)
  ships `repair-po-so-link-sofa-compartments.mjs`, which writes `so_item_id` on
  purchase lines at compartment grain. Repairing `po_qty_picked` from here would
  collide with it. The 25 belong to that lane and are handed to it.
- **The 7 PO -> GR lines are all sofa compartments**, which the owner's standing
  ruling 「一律跟账本。除了 sofa compartment 而已啊」 exempts by name.
- **The 362 GR -> PI lines are a business decision, not a defect.** Writing
  `invoiced_qty` would make those receipts un-invoiceable in the ERP, which may
  be right — but it decides whether AutoCount's historical AP counts against our
  ceiling, and that is the owner's call.

**Ref.** PR #3215 (the checker), #3219 (the `min(uuid)` fix), PR pending
(this result), 2026-09-08.

Module guide: `docs/modules/document-conversion.md` §10.4 G2.

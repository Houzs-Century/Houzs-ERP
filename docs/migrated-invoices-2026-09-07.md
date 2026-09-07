# The carried-over invoices — every gap with a name (2026-09-07)

The reconcile ends its invoice sections at two numbers: `IV 7 (GAP)` and
`PI 21 (GAP)` (run 34134380843, from `main`, 2026-09-07 22:42 +08). This file
turns those numbers into causes, because they do not share a remedy — and two of
the remedies are opposite. Repairing a price that was never wrong is exactly how
RM 13,068.55 of fabricated discount landed on `PO-009335` three weeks ago
(`docs/bugs/0665-*`).

Everything below is **PROVEN** unless it says otherwise. The AutoCount side is
the committed snapshot `backend/scripts/data/ac-reconcile-truth.json.gz`
(`exported_at 2026-09-07T14:12:16Z`, cut from the live `AED_HOUZS` after the book
was locked) plus `ac-invoice-refs.json.gz` and `ac-gr-refs.json.gz`. The ERP side
is production, read read-only by
Actions → **Migrated purchase invoices — one named cause per gap (read-only)**.

---

## 白话文：采购发票到底缺什么

**21 张采购发票没进 ERP，一共 RM 115,642.50。分成三堆，只有一堆是我们的事。**

1. **6 张（RM 28,535.00）根本不该进来。** 这 6 张发票上的货，全部是 AutoCount 在
   我们这次不搬的采购单上收的。我们这边一分钱都对不上，因为那批单本来就不在搬迁
   范围内。**这 6 张是「正确的缺」，不用补，也不能补。**

2. **6 张（RM 46,685.50）是一半一半。** 同一张发票，有些货在我们搬进来的采购单
   上，有些不在。我们能对上的只有一部分，凑不齐整张发票的钱，所以系统按规矩不
   开——**这是对的**，开出来就是一张金额不对的单。

3. **9 张（RM 40,422.00）是我们能补的**，而且原因很干脆：

   **AutoCount 的采购单上根本没写价钱。** 整本账 18,890 条采购单明细里，
   **10,810 条没有单价**（57%）——货先订，价钱等收货才填。我们的收货单是照
   采购单抄价钱的，采购单是空的，我们的收货单就是 RM 0.00。

   **所以这不是「我们的价钱记错了」，是「AutoCount 的采购单上从来没有这个价钱」。**
   补的办法是把 AutoCount 收货单自己的价钱抄过来，不是去「改」采购单的价钱。

   这 9 张里有 2 张（RM 24,010.00）是另一回事：AutoCount 在明细上打了折
   （RM 108.00 + RM 72.00），我们的系统抄单价不抄折扣，所以我们算出来反而比
   AutoCount **多**。这两张要把折扣抄进来。

**顺便查清楚、可以不用再问的两件事：**

- **没有运费、没有税。** 192 张在范围内的采购发票，**没有一张**的总额跟它自己明细
  的合计不一样。所以「是不是账单上多收了运费」这个猜测，**已经排除**。
- **没有外币。** 192 张全部是马币、汇率 1。上次那张 CNY 采购单
  （`PO-009335`）的坑，**碰不到这批**。

---

## 1. The population, and what "absent" means

`backend/scripts/lib/ac-scope.mjs` is the only statement of the in-scope
population. For purchase invoices it is: not cancelled, not a test document, and
at least one line raised from a goods receipt or purchase order that is itself in
scope — the owner's own ruling, 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」.

That gives **192** purchase invoices. Measured over them, offline, at the
snapshot committed on this branch:

| fact | measured |
| --- | --- |
| raised from a goods receipt (not directly from a purchase order) | **192 of 192** |
| MYR at rate 1 | **192 of 192** — the currency trap of `docs/bugs/0665` cannot reach this population |
| header total equal to the sum of its own line subtotals | **192 of 192** — no freight, no tax, no header-level charge anywhere |
| carrying an AutoCount LINE discount the ERP importers do not copy | **12**, RM 1,714.02 in all |

The reconcile calls an invoice PRESENT if the ERP holds either a mirrored
`scm.purchase_invoices` row **or** a pointer in
`scm.purchase_orders.linked_ac_pinv_docnos`. So a gap can be closed two ways, and
they are not the same thing:

- the **pointer** is a reference a human can follow on the purchase-order screen.
  It carries no money and creates no document.
- the **document** is a real ERP purchase invoice, written by
  `create-migrated-invoices.mjs`, numbered `HC-<AutoCount's number>`, flagged
  `migrated_no_stock`, posting no journal entry. It is gated on our total
  equalling AutoCount's to the sen.

`backend/scripts/diag-migrated-purchase-invoices.mjs` answers both lanes, per
invoice.

## 2. What is actually behind the 21

Split by how much of the invoice the migration can even reach — the AutoCount
invoice's own line values, attributed to the purchase order each line's receipt
came from:

| bucket | invoices | value | remedy |
| --- | --- | --- | --- |
| every line bills a receipt or order the migration left behind | 6 | RM 28,535.00 | **none — the absence is correct** |
| part of the bill does | 6 | RM 46,685.50 | **none — a partial invoice would state a wrong total** |
| the whole bill is reachable | 9 | RM 40,422.00 | copy the book's own price / discount |
| **total** | **21** | **RM 115,642.50** | |

Reachable value across all 21: **RM 74,710.50**; value sitting on purchase orders
or receipts outside the migration: **RM 40,932.00**.

The six that are wholly unreachable are `PI-006004`, `PI-007447`, `PI-007540`,
`PI-007576`, `PI-007796`, `PI-007825` — and they are, independently, the six
in-scope purchase invoices that `ac-gr-refs.json.gz` does not name at all. Two
different reads agree on the same six documents, which is why this is stated as
proven rather than inferred: the pointer export is built PO-first, so an invoice
with no in-scope purchase order behind it cannot appear in it.

## 3. Why ours is smaller — the hypotheses, tested

The brief named three candidate explanations. They need opposite handling, so
they were measured apart.

**Freight, tax or any other charge on the bill — RULED OUT.** Zero of the 192
in-scope purchase invoices has a header total differing from the sum of its own
line subtotals. There is no charge to be missing.

**The supplier billed goods on purchase orders the ERP does not hold — TRUE, and
it is the larger half.** RM 40,932.00 of the RM 115,642.50. This is a correct
absence, not a defect: the migration carried the OUTSTANDING population by the
owner's rule, and an invoice that bills across it cannot be assembled from what
we carried.

**Our goods-receipt price is wrong — FALSE, and the true version is more
useful.** It is not wrong, it is ABSENT, and it is absent for a reason that lives
in AutoCount rather than in our importer:

> **10,810 of the 18,890 AutoCount purchase-order lines carry no unit price at
> all.** Only 1,913 of 21,746 goods-receipt lines do.

The book prices a purchase when the goods arrive, not when they are ordered. The
ERP's migrated goods receipt derives its price from the purchase-order line
(`grn_items.unit_price`, see `check-migration-fidelity.mjs`), so on this book it
derives a price from the one document that usually has none. `PO-009548` is the
whole story in one row: AutoCount's own purchase order totals **RM 0.00** for one
`DSL-8030 SOFA`; `GR-005281` prices that sofa at **RM 1,972.00**; `PI-007941`
bills exactly that. Our receipt says RM 0.00 because AutoCount's order says
RM 0.00.

**So the remedy is a COPY, not a repair.** The book's own goods-receipt line
price is the value to carry — never a price inferred from a total difference,
which is indistinguishable from a discount or an exchange rate
(`docs/bugs/0665`, and the memory note `fx-rate-looks-like-a-discount`).

**A fourth cause, in the opposite direction.** `PI-007953` and `PI-007956` are
the two of the 21 that carry an AutoCount line discount (RM 108.00 and RM 72.00).
Their purchase orders DO carry prices, and those prices agree with the receipt
line for line — so our side would bill MORE than AutoCount, by exactly the
discount our importers do not copy. Measured across the migrated set by the
currency/discount sweep: 89 lines across 10 purchase orders, RM 42,662.80.

## 4. The seventh sales invoice — `I-2411-0275`

The other six of the seven sales-invoice gaps are downstream of a delivery-order
defect and belong to that repair. This one is a different shape and needs a
decision.

`I-2411-0275` is **RM 6,800.00**, and AutoCount raised it across three delivery
orders. Only one of them is ours:

| delivery order | in migration scope | lines | units | value on this invoice |
| --- | --- | --- | --- | --- |
| DO-002038 | no (against SO-000074, fully transferred) | 4 | 3 | **RM 6,800.00** |
| DO-003692 | no (same order) | 1 | 2 | RM 0.00 |
| **DO-003699** | **yes — the ERP holds it** | 2 | 3 | **RM 0.00** |

**The delivery order we hold contributes none of the money.** The whole
RM 6,800.00 sits on `DO-002038`, which the migration correctly left behind, and
AutoCount's own header for `DO-003699` is RM 0.00 too — that delivery really is
worth nothing. This is not "we hold a fraction of a merged invoice"; we hold the
zero-value part of it.

Three ways to represent that, and they are not equally honest:

**Option A — do not create it. Record it as a named, correct absence.
(RECOMMENDED.)** The invoice is real, it lives in AutoCount, and everything it
bills is on paperwork the ERP was never asked to carry. Nothing in the ERP is
wrong today; a document would have to be invented to make a counter go to zero.
Cost: the reconcile keeps reporting one sales-invoice gap until the absence is
declared in `ac-scope.mjs` the way other correct absences are.

**Option B — create `HC-I-2411-0275` for RM 0.00 from `DO-003699` alone.** The
number a person holding the AutoCount invoice would search for exists in the ERP.
But it states RM 0.00 for a bill of RM 6,800.00, so anyone reading it — or any
report summing it — is told something false about money. This is the option that
makes a count look better and the books worse.

**Option C — carry `DO-002038` (and `DO-003692`) into the ERP first, then let the
invoice follow.** The only route to a truthful `HC-I-2411-0275`. It means
widening the migration to a delivery order the owner's OUTSTANDING rule excluded,
and `SO-000074` behind it, and then the same question is asked of every other
merged invoice in the same position. Not worth it for one invoice; it is the
right answer only if the owner decides merged invoices matter enough to widen the
rule.

**Recommendation: A.** The absence is correct; only the reporting of it is
missing. `I-2505-0362` is the one other in-scope sales invoice with this shape
(RM 10,498.00 on `DO-004574`, which we hold, plus RM 0.00 on `DO-005804`, which we
do not) — and it is the mirror image: there the money IS on our document, so it
converts normally and needs no decision.

## 5. What still needs the owner

1. **`I-2411-0275` — option A, B or C above.** Recommendation A.
2. **Nothing else.** Everything in section 2 is either a correct absence or a
   copy of the book's own number, which is the migration's standing rule
   (`migration-copy-never-compute`): a migration reads AutoCount's own value and
   never infers one.

## 6. How to re-run any of this

| question | job |
| --- | --- |
| which in-scope documents is the ERP not holding | Actions → **AutoCount vs ERP reconcile (read-only)** |
| why is each purchase invoice absent | Actions → **Migrated purchase invoices — one named cause per gap (read-only)** |
| what would the converter write | Actions → **Migrated invoices — GR to PI, DO to Invoice**, `mode=dry-run` |
| is the gap a missing importer or an undispatched job | `node backend/scripts/check-ac-gap-attribution.mjs` (offline, no database) |

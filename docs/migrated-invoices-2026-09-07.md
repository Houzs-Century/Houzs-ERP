# The carried-over purchase invoices — every gap with a name (2026-09-07)

The reconcile ended its purchase-invoice section at a number: `PI 21 (GAP)` (run
34134380843, from `main`, 2026-09-07 22:42 +08). A number is not a remedy — 21
invoices missing for 21 reasons need 21 different answers, and two of those
answers are OPPOSITE. Repairing a price that was never wrong is exactly how
RM 13,068.55 of fabricated discount landed on `PO-009335` (`docs/bugs/0665-*`).

**It is now `PI 5 (GAP)` — run 34140676108, 2026-09-07 23:54 +08.**

Everything below is **PROVEN** unless it says otherwise. The AutoCount side is
the committed snapshot `backend/scripts/data/ac-reconcile-truth.json.gz`
(`exported_at 2026-09-07T14:12:16Z`, cut from the live `AED_HOUZS` after the book
was locked) plus `ac-invoice-refs.json.gz` and `ac-gr-refs.json.gz`. The ERP side
is production, read read-only by
Actions → **Migrated purchase invoices — one named cause per gap (read-only)**,
runs 34139368829 (before) and 34140590449 (after).

---

## 白话文：采购发票缺的 21 张，现在补了 16 张

**采购发票原本有 21 张对不上，一共 RM 117,835.50。现在剩 5 张。**

**补回来的 16 张（RM 90,510.50）——原因是我们自己的程序漏写了。**

那支把 AutoCount 单号盖回采购单上的程序，一次要写两样东西：**收货单号**和
**发票单号**。它检查「要不要写」的时候，**只看收货单号有没有变**。货早就收完的
采购单，收货单号当然不会再变，程序就整张跳过——**后来 AutoCount 才开出来的发票
单号，永远写不进去**。

上一次跑（晚上 6:46）318 张有收货的采购单里，**258 张就是这样被跳过的**。
改好之后重跑，**73 张采购单要补写，而且 73 张全部都是「只有发票单号变了」**——
正是这个漏洞。写进去之后，21 张变 5 张。

**剩下的 5 张（RM 27,325.00）是「本来就该缺」，不用补：**

`PI-006004`、`PI-007447`、`PI-007540`、`PI-007576`、`PI-007825`。这 5 张发票上的
货，**大部分是在我们这次不搬的采购单上收的**——RM 27,325.00 里面，只有
RM 5,245.00 是在我们搬进来的收货单上，其余 RM 22,080.00 不是。其中 4 张还有另一个
问题：**同一张收货单，AutoCount 分了两三张发票开**，而两边都没有「哪一行属于哪一
张发票」的记号，所以没办法拆。

**另外一件事要讲清楚：这 21 张补的是「单号对照」，不是「发票单据」。**

在范围内的 192 张采购发票，现在 **18 张在 ERP 里是真的发票单据，169 张只是采购单
上的一个单号对照**。要变成真的单据，金额必须跟 AutoCount 一分不差，而现在对不上，
**原因不是我们记错价钱，是 AutoCount 的采购单上根本没写价钱**：

> 整本账 **18,890 条采购单明细里，10,810 条没有单价**（57%）。货先订，价钱等收货
> 才填。我们的收货单是照采购单抄价钱的，采购单是空的，我们的收货单就是 RM 0.00。

`PO-009548` 就是整个故事：AutoCount 自己的采购单总额 **RM 0.00**，一张
`DSL-8030 SOFA`；收货单 `GR-005281` 才写上 **RM 1,972.00**；发票
`PI-007941` 照收 RM 1,972.00。**我们的收货单是 RM 0.00，因为 AutoCount 的采购单
就是 RM 0.00。**

所以补的办法是**把 AutoCount 收货单自己的价钱抄过来**，不是去「改」采购单的价钱。
**这一步还没有做**，而且它属于正在处理收货单的另一位同事，我没有动，免得两边同时
改同一批资料。

**顺便查清楚、以后不用再问的两件事：**

- **没有运费、没有税。** 192 张在范围内的采购发票，**没有一张**的总额跟它自己明细
  的合计不一样。「是不是账单上多收了运费」这个猜测，**已经排除**。
- **没有外币。** 192 张全部是马币、汇率 1。上次那张 CNY 采购单（`PO-009335`）的
  坑，**碰不到这一批**。

---

## 1. What "absent" means here, and why there are two lanes

`backend/scripts/lib/ac-scope.mjs` is the only statement of the in-scope
population. For purchase invoices: not cancelled, not a test document, and at
least one line raised from a goods receipt or purchase order that is itself in
scope — the owner's ruling, 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」. That
is **192** purchase invoices.

The reconcile calls one PRESENT if the ERP holds either of two different things,
and they have different remedies:

- **LANE A — the POINTER.** `scm.purchase_orders.linked_ac_pinv_docnos` names the
  AutoCount invoices raised against that order. A reference a human can follow on
  the purchase-order screen. It carries no money and creates no document.
- **LANE B — the DOCUMENT.** A real `scm.purchase_invoices` row mirroring the
  AutoCount invoice, numbered `HC-<AutoCount's number>`, flagged
  `migrated_no_stock`, posting no journal entry. Gated on our total equalling
  AutoCount's to the sen.

As of run 34140590449: **18 held as a document, 169 as a pointer only, 5 absent.**

## 2. The 21, attributed — one named cause each

Measured by run 34139368829, before anything was changed.

| LANE A — why no pointer | invoices |
| --- | --- |
| `stamp_skipped_the_po_its_receipts_were_unchanged` | **16** |
| `not_in_pointer_source` | **5** |

| LANE B — why no document | invoices | value |
| --- | --- | --- |
| `our_receipt_carries_no_price` | 8 | RM 51,322.50 |
| `no_erp_goods_receipt_feeds_it` | 6 | RM 11,095.50 |
| `ambiguous_autocount_invoices` | 4 | RM 27,037.50 |
| `our_receipt_price_is_short_of_the_book` | 3 | RM 28,380.00 |
| **total** | **21** | **RM 117,835.50** |

### The 16 that are now in — a defect in our own stamp

`stamp-ac-grn-refs.mjs` writes two columns in one statement:

```sql
SET linked_ac_grn_docnos = <gr list>, linked_ac_pinv_docnos = <pi list>
```

and its idempotency skip consulted only the first. A purchase order whose
receipts have not changed is skipped whole, so an invoice raised against it since
the last stamp is never written. The last APPLY before the reconcile — run
34113197377, 2026-09-07 18:46 +08 — reported `imported POs: 575; to stamp: 60`
against a snapshot of `318 POs / 214 GR docs / 186 PI docs`. **258 purchase orders
with a receipt were skipped on exactly that test.**

Fixed in PR #3105 (`docs/bugs/0674-*`). Re-run with both lists deciding:

- DRY-RUN 34139512152, 23:40 +08 — `to stamp: 73 (73 of them ONLY because the
  purchase-invoice list moved, which the receipts-only skip used to miss)`
- APPLY 34140454809, 23:51 +08 — `DONE. POs stamped: 73. No GRN was created and
  no stock moved — by design.`
- diagnostic 34140590449, 23:53 +08 — `ABSENT: 5`
- reconcile 34140676108, 23:54 +08 — `PI DOCUMENTS — in-scope AutoCount documents
  absent from the ERP: 5 (GAP)`

### The 5 that remain — and why they are CORRECT absences

`PI-006004`, `PI-007447`, `PI-007540`, `PI-007576`, `PI-007825`, RM 27,325.00
between them. Of that, **RM 5,245.00 is on receipts the ERP holds** and
**RM 22,080.00** is on receipts and purchase orders the migration deliberately
left behind.

They are also, independently, the only five in-scope purchase invoices that
`ac-gr-refs.json.gz` does not name at all — the pointer export is cut PO-first,
so an invoice with no in-scope purchase order behind it cannot appear in it. Two
different reads land on the same five documents.

Four of them carry a second, separate blocker: `ambiguous_autocount_invoices`.
One ERP goods receipt is billed across two or three AutoCount invoices
(`HC-GR-003813 -> PI-006004, PI-006011, PI-006012`), and neither side carries a
line-to-line key — `PIDTL.FromDocDtlKey` is 0 of 20,777 — so "which of these
invoices billed this line" has no answer to split by.

## 3. Why ours is smaller — the hypotheses, tested

Measured apart, because they need opposite handling. Numbers from run 34139368829
over the 21.

**Freight, tax or any other charge on the bill — RULED OUT.** `0 of 21`, and 0 of
all 192 in scope. No in-scope purchase invoice has a header total differing from
the sum of its own line subtotals. There is no charge to be missing.

**The supplier billed goods on purchase orders the ERP does not hold — TRUE.**
`7 of 21, RM 31,583.00`. A correct absence, not a defect: the migration carried
the OUTSTANDING population by the owner's rule, and an invoice billing across it
cannot be assembled from what we carried. A partial mirror would state a wrong
total.

**Our goods-receipt price is wrong — FALSE, and the true version is more useful.**
`11 of 21, RM 64,872.50` short on the SAME receipts. It is not wrong, it is
ABSENT, and it is absent for a reason that lives in AutoCount, not in our
importer:

> **10,810 of the 18,890 AutoCount purchase-order lines carry no unit price at
> all.** Only 1,913 of 21,746 goods-receipt lines do.

The book prices a purchase when the goods arrive, not when they are ordered. The
ERP's migrated goods receipt derives its price from the purchase-order line
(`grn_items.unit_price`, see `check-migration-fidelity.mjs`) — on this book, the
one document that usually has none. `PO-009548`: AutoCount's own purchase order
totals **RM 0.00** for one `DSL-8030 SOFA`; `GR-005281` prices it at
**RM 1,972.00**; `PI-007941` bills exactly that.

**So the remedy is a COPY, not a repair** — the book's own goods-receipt line
price, never a price inferred from a total difference, which is
indistinguishable from a discount or an exchange rate.

**A fourth cause, in the opposite direction.** `2 of 21, RM 180.00` — `PI-007953`
(RM 108.00) and `PI-007956` (RM 72.00) carry an AutoCount LINE discount our
importers do not copy, so on those two our side bills MORE than the book. Across
the whole migrated set: 89 lines, 10 purchase orders, RM 42,662.80.

## 4. NOT DONE, and deliberately

**The 169 pointer-only invoices are not documents, and this work did not make
them documents.** Turning them into `scm.purchase_invoices` rows needs the
AutoCount goods-receipt line price stamped onto the migrated `grn_items`, which
is a WRITE on the goods-receipt lines — the surface another agent is reshaping
tonight. Two agents repairing the same rows in parallel is the failure this
guardrail exists for, so it was left alone rather than raced. **UNTESTED as a
remedy: no price-stamp script has been written or run.**

The trap waiting there is already in the ledger: one AutoCount receipt DtlKey can
be many ERP lines, and a price repair keyed on it writes the same price to all of
them (`docs/bugs/0673-*`). Whoever does it should key on the line, not the item.

## 5. The seventh sales invoice — `I-2411-0275`

Six of the seven sales-invoice gaps are downstream of a delivery-order defect and
belong to that repair. This one is a different shape and needs a decision.

`I-2411-0275` is **RM 6,800.00**, raised across three delivery orders. Only one
is ours:

| delivery order | in migration scope | lines | units | value on this invoice |
| --- | --- | --- | --- | --- |
| DO-002038 | no (against SO-000074, fully transferred) | 4 | 3 | **RM 6,800.00** |
| DO-003692 | no (same order) | 1 | 2 | RM 0.00 |
| **DO-003699** | **yes — the ERP holds it** | 2 | 3 | **RM 0.00** |

**The delivery order we hold contributes none of the money.** The whole
RM 6,800.00 sits on `DO-002038`, which the migration correctly left behind, and
AutoCount's own header for `DO-003699` is RM 0.00 as well — that delivery really
is worth nothing. This is not "we hold a fraction of a merged invoice"; we hold
the zero-value part of it.

**Option A — do not create it; record it as a named, correct absence.
(RECOMMENDED.)** Everything the invoice bills is on paperwork the ERP was never
asked to carry. Nothing in the ERP is wrong today, and a document would have to
be invented to make a counter reach zero.

**Option B — create `HC-I-2411-0275` for RM 0.00 from `DO-003699` alone.** The
number a person holding the AutoCount invoice would search for then exists. But
it states RM 0.00 for a bill of RM 6,800.00, so the document — and any report
summing it — says something false about money. This is the option that makes a
count look better and the books worse.

**Option C — carry `DO-002038` and `DO-003692` into the ERP first, and let the
invoice follow.** The only route to a truthful `HC-I-2411-0275`. It means
widening the migration past the owner's OUTSTANDING rule, to a delivery order and
the sales order behind it, and then answering the same question for every other
merged invoice in the same position.

**Recommendation: A.** The absence is correct; only the reporting of it is
missing. `I-2505-0362` is the one other in-scope sales invoice with this shape
and it is the mirror image — RM 10,498.00 on `DO-004574`, which we hold, plus
RM 0.00 on `DO-005804`, which we do not — so it converts normally and needs no
decision.

## 6. What still needs the owner

**Two decisions, both small.**

**1. `I-2411-0275`** — option A, B or C in section 5. Recommendation A.

**2.** The four `ambiguous_autocount_invoices` — one
of our receipts billed across several AutoCount invoices, with no key to split
by, and almost all of the money on receipts we do not hold anyway. Three ways to
treat them:

**Option A — leave them absent, and declare the absence. (RECOMMENDED.)** They
are correct: AutoCount billed across paperwork the ERP was never asked to carry.
`ac-scope.mjs` gains a named exclusion so the reconcile stops reporting a gap
nobody intends to close. Cost: a few lines, and the reconcile then tells the
truth about the remaining work.

**Option B — split the invoice pro-rata across the receipts.** Every ERP invoice
gets a number and a value. The values would be invented — nothing in either
system says which line each invoice billed — so the books would carry a
plausible wrong number instead of a visible blank. Not recommended: a blank is
visible and a gate refuses it; a plausible wrong number is silent forever.

**Option C — widen the migration to carry the other receipts.** The only route to
a truthful mirror. It means importing purchase orders the OUTSTANDING rule
excluded, and then answering the same question for every other invoice in the
same position. Worth it only if merged invoices matter enough to change the rule.

## 7. How to re-run any of this

| question | job |
| --- | --- |
| which in-scope documents is the ERP not holding | Actions → **AutoCount vs ERP reconcile (read-only)** |
| why is each purchase invoice absent | Actions → **Migrated purchase invoices — one named cause per gap (read-only)** |
| what would the converter write | Actions → **Migrated invoices — GR to PI, DO to Invoice**, `mode=dry-run` |
| is a gap a missing importer or an undispatched job | `node backend/scripts/check-ac-gap-attribution.mjs` (offline, no database) |

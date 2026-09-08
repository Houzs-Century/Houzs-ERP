## The purchase orders read as PO 0 while one of them differed from the book on currency [medium]

<!-- status: fixed -->

<!-- area: AutoCount sync + write-back -->

**白话.** 对账报告的总表上，采购单那一行写「0」—— 看起来完全没问题。其实有一张
采购单 HC-PO-009335 是**人民币**的单，账本写 CNY，我们系统里写成马币 RM。

钱没错：账本 34,334.90，我们也是 34,334.90，一分不差。错的是「这是什么货币」这
一栏。总表把它放在「非马币」那一格，而那一格**故意不算进「有问题」的总数** —— 因
为用马币的金额去跟人民币的金额比，会凭空比出一笔假的折扣（以前就出过这个事，
凭空多了 13,068.55 的假折扣）。

所以总表说 0 是对的，报告说这张单有问题也是对的，两句话讲的是两件事。但没有人
把它们摆在一起讲，结果搬进来的资料对账时就被记成「采购单 0 个不一样」。现在报告
会一张一张讲，货币单独一栏，不会再被总表的 0 盖过去。

**Symptom.** The migrated-population reconcile was being tallied as
**14 differences: GR 9, IV 4, PI 1, and PO 0**. The `PO 0` came from the
`SUMMARY` table's `gaps` arithmetic, and it is true of what that column measures.
It is not true of the purchase orders. Reconcile run `34224368330` (2026-09-08
12:07 UTC), same log, twelve lines apart:

| where in the log | what it said about purchase orders |
| --- | --- |
| the `SUMMARY` table's `PO` row | `absent 0 · lineCnt 0 · item 0 · qty 0 · price 0 · money 0` — reads as **nothing wrong** |
| the `non-MYR` column of that same row | `1` |
| the named finding underneath | `PO-009335: the document is in CNY at rate 0.61938, and the ERP holds MYR` |

**Root cause (traced).** Not a defect in the comparison — the comparison is
right, and deliberately so. `check-ac-erp-reconcile.mjs` records the finding on
a LOCKING axis:

```js
/* NOT a money difference — and still a difference. The reconcile's own
   words: "a real defect, but a CURRENCY defect". */
VERDICT.record(t, ac, d.erp_no, "currency", cur.why);
```

and simultaneously keeps it OUT of the summary's gap total, with a reason that
is also right (`SUMMARY_COLUMNS`, the `non-MYR` entry): a foreign document is
compared in its own currency and its total may be perfectly correct, so counting
it as money is what made an exchange rate look like a discount and wrote
RM 13,068.55 of imaginary discount onto a CNY order (`docs/bugs/0665`).

So two statements were both correct — *this is not a money gap* and *this
document differs* — and **no artifact printed them together**. The only
purchase-order number anyone read was the gap total, and a reader reconciling
the migrated population off the SUMMARY row got `PO 0`. This is
`docs/bugs/0715` again on a different axis and a different document type: the
per-document verdict existed for SALES ORDERS only, so for purchase orders and
goods receipts the summary row was the whole answer.

Traced by re-deriving the verdict from the recorder rather than from the log:
the recorder has ALWAYS been keyed by document type — every `VERDICT.record(t, …)`
call site passes the type it is looping over — so the purchase-order and
goods-receipt findings were already being collected and simply never written
out. `buildVerdictRows({ type: "SO" })` was the only call.

**Fix.** The per-document verdict is emitted for every requested document type
(`VERDICT_DIR` / `VERDICT_TYPES`), and `check-po-gr-tally.mjs` classifies those
rows into the same four buckets the sales-order lane uses, with `currency` named
on the purchase-order price axis so it cannot be read as money only. The word
TALLIED is still decided in exactly one place (`isTallied`), and it did not move.

Pinned by `backend/tests/poGrTallyVerdict.test.mjs`. **Proved RED on the unfixed
tree**: adding `currency` to `UNANSWERABLE_AXES` — the shape that would let a
foreign document read as "cannot be compared" rather than as work — fails 3 of
the 28 cases; dropping the per-type labels fails 3; dropping the goods-receipt
grain note fails 1; making `docTypeSpec` fall back to SO instead of refusing
fails 1; and disabling one arm of the cross-check fails 1.

**Ref.** `feat/po-gr-tally`, 2026-09-08.

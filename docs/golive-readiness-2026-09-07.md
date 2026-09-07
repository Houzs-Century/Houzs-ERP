# Go-live readiness — measured 2026-09-07

The owner's gate, in his words:

> 确保数据都没问题后，我们要对标看 Stock Status 是不是一致的。如果一致，我们就可以
> 解锁 Houzs ERP。
> 以我们的为标准,因为我们的数据比较准确。
> 我们的单会分成有 processing date 跟没有 processing date,所以你也需要把这些东西
> 都补齐。

Everything below is **PROVEN** unless labelled otherwise: it is the output of
`backend/scripts/check-golive-parity.mjs` run read-only against production
(company 1) on 2026-09-07, against the AutoCount snapshot taken from the live
book `AED_HOUZS` at 2026-09-07 13:03 MYT. Re-run it with
Actions → **Go-live parity gate (read-only)** → Run workflow.

---

## 白话文：现在能不能解锁

**还不能，差三件事，都不大。**

1. **库存状态（Stock Status）对不上的，有 220 张单。** 其中 **177 张是 AutoCount
   落后**，不是我们错 —— 我们的数比较新。**但有 43 张是我们自己的问题**：货其实
   已经在仓库里了，我们系统还写着「没货」，所以那 43 张上面 AutoCount 打的 READY
   有可能才是对的。**这 43 张要先看。** 另外 177 张不挡解锁，只要让仓库知道以后
   只看 ERP 就好。
2. **有 62 张单，AutoCount 有 Processing Date，我们这边是空的。** 这 62 张全部
   是 8 月 30 日之后新填的，也就是上次导入之后才动的。**这个要补**，补完这一项
   就干净了。
3. **有 46 张单，AutoCount 收的钱比我们记的多，一共差 RM 155,521。** 同一批单，
   同样是上次导入之后客户又付了钱。**这个也要补。**

另外，还没 proceed 的单可以空着，这是老板自己的规矩，所以下面「要做的工」只算
已经有 Processing Date 的单：**颜色 47 条、Seat Size 21 条、沙发件数 0 条。**

**一句话：把「新的那批改动」再导一次，第 2、3 件事会一起好；第 1 件里的 43 张要
我们自己重算一次库存。**

---

## 1. Stock Status — the release gate

### 1A. Per product + warehouse

The ERP side is the `scm.inventory_balances` **VIEW**, never `sum(qty)` — the
movement ledger stores OUT as a POSITIVE quantity and the view is what negates
it by `movement_type`, so a naive sum answers a different question and hides
every negative (recorded 2026-08-18).

| | count |
|---|---|
| cells present on both sides | 936 |
| AGREE, unit for unit | **798** (85.3%) |
| DIFFER | 138 |
| cells only the ERP holds | 33 |
| cells only AutoCount holds | 27 |

Held out on BOTH sides, and reported rather than silently dropped: sofa
furniture (AutoCount counts one whole sofa where the ERP counts its
compartments — not commensurable), and the service pseudo-items AutoCount
models as stock (`DISPOSE`, `TRANSPORTATION CHARGES`, `STORAGE`). The second
of those was one-sided until this change; see
`docs/bugs/0656-the-stock-reconciler-dropped-autocount-s-service-pseudo-item.md`.

The largest differences are accessory lines at BALAKONG (`AK-CS AIRLOFT COMFY
PIL` ERP 93 / AutoCount 222, `AK- ESSENTIAL BOLSTER` ERP 25 / AutoCount 144).
Both directions occur, so this is not a one-way drift.

### 1B. Per order — the Stock Status column itself

AutoCount's Stock Status column is `SO.Remark2`
(`docs/stock-reconciliation.md` §2). The ERP side is `summariseReadiness()`
**imported from** `backend/src/scm/lib/so-readiness.ts` — the function the SO
board itself calls, not a re-implementation of it.

| | count |
|---|---|
| orders compared | 2,679 |
| AGREE | 2,420 (90.3%) |
| ... of which BLANK on both sides | 2,264 |
| DISAGREE | 259 |

**The 90.3% is flattered by blanks and must not be quoted alone.** Over the 415
orders where at least one side names a readiness, agreement is **156 (37.6%)**.
That is the honest figure.

Attributed:

| cause | count |
|---|---|
| AUTOCOUNT BEHIND — both name groups, they differ | 141 |
| AUTOCOUNT BEHIND — stale READY typed in AutoCount, the ERP finds no stock | 71 |
| NOT PROCEEDED — no Processing Date, the allocator forces PENDING by design | 39 |
| AUTOCOUNT BEHIND — the ERP allocated, nobody typed it back | 8 |

So 220 orders read as AutoCount behind the ERP, and 39 are the ERP's own
processing-date gate — a rule, not drift, and the one class scored neither way
because the ERP cannot answer yet.

### The contradiction inside that 220, and it is not a footnote

"AutoCount is behind" rests on the ERP's stored `stock_status`, and that value is
written only by `recomputeSoStockAllocation`, ~34 of whose ~38 triggers are
best-effort. It goes stale. Measured with the same bracket
`probe-so-stock-status-stale.mjs` reports (now a shared module, so the two cannot
disagree):

| | count |
|---|---|
| live lines whose bucket holds ANY on-hand while the line reads non-READY | 684 (ceiling) |
| ... and enough on-hand for ALL demand on that bucket, so FIFO cannot explain it | 126 (floor) |
| orders carrying at least one floor line | 89 |
| **of the 220 "AutoCount behind" orders, also carrying a floor line — CONTESTED** | **43** |

On those 43 the ERP's own answer is the stale one, so AutoCount's READY may be
correct. They are the first place to look, not the last. The remaining **177
stand as AutoCount behind**. The recompute queue is EMPTY and the lock is free,
so nothing is currently queued to refresh them.

Examples: `SO-000517` (AutoCount READY, ERP BEDFRAME), `SO-000951` (AutoCount
READY, ERP blank), `SO-005786` (AutoCount READY, ERP PARTIAL, at READY_TO_SHIP).

### 1C. Per SO line

AutoCount holds **no** per-line readiness: `SODTL.StockReceived` is `'F'`,
`PurchaseStatus` and `DeliveryStatus` are NULL on the open lines (established
read-only against the book and recorded in
`backend/scripts/check-bedframe-sofa-status-truth.mjs`). Readiness is therefore
comparable at the ORDER level only; inventing a second line-level rule to fill
that gap is the failure this repo pays for repeatedly, so it is not done.

What IS comparable per line, on the exact key
`mfg_sales_order_items.linked_ac_dtlkey = SODTL.DtlKey` (populated on 14,206 of
14,492 ERP lines, 98.0%):

| | count |
|---|---|
| compared 1:1, quantity AGREES | 13,068 |
| quantity DIFFERS | 11 |
| sofa lines exploded into compartments (not comparable on qty) | 272 |
| AutoCount lines genuinely absent from the ERP | 624 |

The 688 non-READY lines that DRIVE the 220 order disagreements: ACCESSORY 215,
MATTRESS 193, SOFA 101, SERVICE 87, BEDFRAME 84, OTHERS 8.

---

## 2. Processing date completeness

The owner's rule (pinned 2026-08-13): 「只要有 Processing Date，就代表他 Proceed
了」 and 「没有 processing date 就代表没有 proceed」. An order with no date is
**not a defect by itself** — it is a defect only when AutoCount holds a date the
ERP never received. The two are told apart by joining the source: the same
`UDF_PDate` field `unify-processing-date.mjs` classified on.

| | count |
|---|---|
| migrated orders in the ERP | 2,770 |
| HAVE a Processing Date matching AutoCount's | 458 |
| HAVE one AutoCount does not (set in the ERP since) — the ERP is ahead | 72 |
| HAVE one that DIFFERS from AutoCount's | 1 (`SO-011870`: ERP 2026-10-01, AutoCount 2026-10-12) |
| legitimately have NONE — AutoCount has none either | 2,177 |
| **MISSING one they should have — THE BACKLOG** | **62** |

The 62 carry AutoCount dates between 2026-08-30 and 2026-09-10, i.e. they were
set in the book after the last import. **LIKELY** (not yet proven): the delta
import closes them.

Pair rule (「processing date 和 delivery date 必须同时有或者同时没有」): 6 orders
carry a Processing Date with no delivery date, and AutoCount supplies a delivery
date for none of them. 13 carry a delivery date with no Processing Date, which
is legal — not proceeded yet.

5 orders sit past CONFIRMED with no Processing Date at all (`SO-005712`,
`SO-012857`, `SO-006812`, `SO-006734` at READY_TO_SHIP; `SO-013361` at
IN_PRODUCTION). Named, not sided with.

---

## 3. Payment completeness

The AutoCount figure is the cutover importer's own formula, not a fresh reading
of the book: `total = Σ centi(UnitPrice)·qty` and
`paid = max(0, total − centi(UDF_BALANCE))`
(`import-ac-outstanding-so.mjs:247,:317`). The ERP figure is
`Σ scm.mfg_sales_order_payments.amount_sen`, which is the same sum
`soProceedGateRefusal` runs, so this measures the gate's own input.

| | value |
|---|---|
| orders compared | 2,679 |
| money AGREES to the sen | 2,632 (98.2%) |
| money DIFFERS | 47 |
| AutoCount holds | RM 9,373,230.00 |
| the ERP holds | RM 9,218,009.00 |
| difference (ERP − AutoCount) | **−RM 155,221.00** |

Split: 46 orders where the ERP holds LESS (RM 155,521 short) and 1 where it
holds MORE (RM 300). Largest: `SO-008172` short RM 16,888, `SO-009773` short
RM 9,338, `SO-009362` short RM 9,100.

Cross-tabbed against the other sections: 8 of the 47 also have a different
AutoCount TOTAL (the document was edited in the book after the import), and 13
of the 47 are also missing their Processing Date. One event, not two findings.

**The same-day edit lock is NOT a gap.** 2,687 cutover-imported payment rows are
already past `paymentRowMutable`'s day-after lock, so they cannot be corrected
in the ERP. That is the rule working as designed, proven on `HC-SO-013393`
(Actions run 33375221382). Whether migrated payments should be exempt until
go-live is an **OPEN OWNER DECISION** — do not loosen a money gate without it.

---

## 4. Colour, Seat Size, sofa compartments

The owner's rule (2026-09-04): 「还没proceed还没确认的就可以直接放空的」. So the
backlog is the PROCEEDED population; the all-orders figure is context and must
never be quoted as the work.

| | PROCEEDED (the backlog) | all SO (context) |
|---|---|---|
| sofa + bedframe lines | 835 | 3,588 |
| COLOUR — no fabric axis at all | **47** | 1,878 |
| COLOUR — axis says TBC / KIV | 0 | 0 |
| COLOUR — axis resolves to no `scm.fabric_colours` row | 0 | 0 |
| SEAT SIZE — missing (sofa; CONSOLE exempt) | **21** | 178 |
| COMPARTMENTS — bare "1S", all told | 5 | 116 |
| COMPARTMENTS — bare "1S" we could not read (the real work) | **0** | 107 |

The axis rule is `missingVariantAxes()` from `backend/scripts/lib/variant-axes.mjs`
— the same mirror `check-sofa-bedframe-completeness.mjs` uses, which remains the
authority on compartment CORRECTNESS. This section counts what is outstanding.

---

## How fresh is the AutoCount side

The snapshot is committed data, not a live read — the book is behind ZeroTier on
the office network and a GitHub runner cannot reach it. Measured against the
live book at 2026-09-07 15:10 MYT, about two hours after the export:

| | snapshot 13:03 | live book 15:10 | drift |
|---|---|---|---|
| outstanding SO documents | 2,777 | 2,783 | +6 |
| Remark2 filled | 425 | 441 | +16 |
| UDF_PDate filled | 572 | 575 | +3 |
| Σ UDF_BALANCE | RM 9,362,944 | RM 9,385,344 | +RM 22,400 |

So the AutoCount half of this report is current to within a few hours and a
handful of documents. Refresh it with `python backend/scripts/export-ac-reimport.py`
from a machine on that network and commit `backend/scripts/data/ac-*` before
quoting a later run as the go-live verdict; the script prints the snapshot's own
timestamp and marks it STALE past `stale_hours`.

---

## What would flip the gate

1. Land the delta import. **LIKELY** it closes the 62 missing Processing Dates
   and most of the 46 payment gaps — both populations are dated after the last
   import. Re-run this check; that is what it is built for.
2. Refresh the 43 CONTESTED orders. Their lines read PENDING while the goods sit
   in their own bucket, so our own answer is the stale one there. The repair is
   `recompute-so-allocation` — **UNTESTED here; it has not been dispatched as
   part of this work.**
3. Decide the remaining 177 Stock Status disagreements. Those are AutoCount
   behind the ERP under the owner's own ruling, so the decision is whether the
   warehouse stops reading Remark2, not whether the ERP changes.
4. Fill the 47 colour and 21 Seat Size gaps on proceeded orders, or accept them.

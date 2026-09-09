# Three sofas whose MODEL disagreed with the account book — RULED AND CORRECTED, 2026-09-08

**Status: CLOSED.** The owner ruled the same day: **跟账本**. All 18 rows now carry
the model AutoCount's own line names, on both the sales order and the purchase
order. Verified on a fresh connection per document, and the reconcile's
sales-order item-code column fell from 10 to 1 and the purchase-order column from
9 to 0.

## 白话

三张沙发单,**账本写的型号跟我们系统写的型号不一样**。件数、颜色、尺寸本来就是对
的,只有**型号**对不上。老板讲:「我们一定要对回账本」——已经三张全部照账本改好。

| 订单 | 客户 | 采购单 | 账本写 | 我们本来写 | 现在 |
| --- | --- | --- | --- | --- | --- |
| `HC-SO-010882` | Tee | `HC-PO-009550` | `DSL-8030 SOFA`(8030) | 9058 | **8030** |
| `HC-SO-011660` | Sulaiman | `HC-PO-009017` | `AMN-SF9058 SOFA`(9058) | 8030 | **9058** |
| `HC-SO-012629` | KONG KIT YING | `HC-PO-009712` | `HOK-5535 SOFA`(5535) | 8030 | **5535** |

**钱一分没动**:RM 5,088.00 / RM 5,990.00 / RM 4,190.00,改之前改之后一样。件数
也一样,没有多一件也没有少一件。

老板问的第二件事——「我们的 SKU 为什么会跟账本不一样」——答案在下面,一句话:
**不是系统读错账本,是 2026-08-10 那份人手写的修正档把型号写错了,而当时没有任何
东西拿它跟账本对过。**

## The owner's question, answered — PROVEN

**Our importer never chose a different SKU.** Run against the book's own rows from
the 08:03 cut, `import-ac-outstanding-so.mjs`'s derivation —
`erp.replace(/-1S$/i, "")` then `SOFA_MODEL_ALIAS` — produces the book's answer on
all three, and the piece lists it produces are **byte-identical** to the ones the
corrections file states:

```
Tee            DSL-8030 SOFA   -> 8030-1S -> 8030   pieces 8030-1A(LHF), 8030-CNR, 8030-2A(RHF)
Sulaiman       AMN-SF9058 SOFA -> 9058-1S -> 9058   pieces 9058-1B(LHF), 9058-CNR, 9058-2A(RHF)
KONG KIT YING  HOK-5535 SOFA   -> 5535-1S -> 5535   pieces 5535-1A(LHF), 5535-CNR, 5535-2A(RHF)
```

Only the MODEL differed. It differed because
`backend/scripts/data/sofa-compartment-corrections-2026-08.json` states a `model`
as a free-standing string and `apply-sofa-compartment-corrections.mjs` took it
verbatim:

```js
const model = K(c.model || modelOf(rows[0].code));
```

The fallback arm is the safe half — with no `model` the applier keeps what the
importer derived from the AutoCount item code, which is the book's own answer.
**The stated arm had nothing grading it.** A hand-typed value outranked a derived
one for a month.

Read in the file's original order (`git show 78de4d942`), rows 1 and 4 hold each
other's model and row 3 holds a fold that does not exist:

```
1  HC-SO-010882  model 9058   book 8030    <- these two are swapped
4  HC-SO-011660  model 8030   book 9058    <-
3  HC-SO-012629  model 8030   book 5535    <- 5535 is deliberately NOT in SOFA_MODEL_ALIAS
```

All three `why` fields argue the PIECES only — "Desc2 1R+C+2R", "Desc2 1B+C+2R".
That the swap is a transcription slip is **LIKELY**; what is **PROVEN** is that
nothing ever compared the stated model to the item code on the same book line.

This is the same root shape as
`docs/bugs/0689-the-reconcile-read-the-mapping-sheet-with-split-comma-so-40.md` —
two descriptions of one fact and nothing comparing them — but inverted. There a
silence became a value (`?? "others"`, a `split(",")` fragment). Here a
hand-typed value outranked a derived one.

## Is the rest of the file suspect? Measured, not assumed

`backend/scripts/check-sofa-corrections-vs-book.mjs` grades every entry in both
correction files against `data/ac-reconcile-truth.json.gz`. Offline, read-only,
exit 0 on any answer.

| verdict | before | after |
| --- | --- | --- |
| names the model the book names | 35 / 53 | **38 / 53** |
| agrees only after `SOFA_MODEL_ALIAS` — policy, not a defect | 6 / 53 | 6 / 53 |
| **DISAGREES with the book** | **3 / 53** | **0 / 53** |
| carries no model at all (piece/seat-only entries) | 5 / 53 | 5 / 53 |
| build not locatable in the book cut | 4 / 53 | 4 / 53 |
| held, not applied | 2 | 2 |

**The three the owner named were the only three.** No other entry in either file
names a model the book does not. The 6 alias agreements are the deliberate
Hookka fold (`HOK-5536` -> 9058, `HOK-5540` -> 8030) and are correct.

**The ERP followed the FILE on all three, not the book** — which is exactly why
the reconcile raised them and the importer did not.

`backend/tests/sofaCorrectionsVsBook.test.mjs` now fails CI if any entry
re-asserts a model the book does not name. Proved RED on the unfixed tree.

### A second finding the audit turned up, sized and handed on

**16 of the document numbers the 2026-08 file writes hold no line of their build
in the book.** Fifteen are `HC-PO-0100xx` — numbers the SO-linked PO import minted
from its own running sequence, which collide with real AutoCount purchase orders.
`HC-PO-010026`, the number this file gave Sulaiman's sofa, is a bedframe
(`NB-KHA01(K)`) on another customer's order, so that half of the entry had never
reached a purchase order at all. Corrected here to `HC-PO-009017`, which the book
itself raises for that sofa (`PODTL` 829659, `FromSODtlKey` 803503). The other 14
are printed by the check and belong to whoever owns the PO-numbering lane.

## Two defects the DRY-RUN and the probe caught BEFORE anything was written

Both are in `docs/bugs/0694-a-model-change-dealt-the-sofa-compartments-out-by-position-o.md`.

**1. A model change dealt the compartments out by POSITION.**
`pairRowsToPieces` paired a row to a target piece by its FULL code, then handed
leftovers out in document order. While a correction kept the model it found, the
first pass matched every row and the fallback never ran on a full build. A MODEL
change makes the first pass match nothing, and `HC-PO-009550` holds its
compartments in the order `2A(RHF), CNR, 1A(LHF)` — two of three would have
landed on a different ROW, and each of those rows carries the `so_item_id`
dedication bound-mode readiness reads. Fixed with a compartment pass between the
two that existed.

A re-read afterwards would NOT have caught it: the sales-order half's downstream
carry re-writes each purchase-order row *through the dedication*, so the end state
would have been right anyway — provided the document list names the PO before the
SO and every PO row is dedicated. Both held here; nothing asserts either.

**2. The KONG KIT YING entry could not reach its rows.** Both documents reported
`no line matches`. The ERP's own `description2` reads `BO315-03` where the book
reads `BO315-3`, and the file's `desc2Match` quoted the book past that point.
Shortened to the prefix both carry.

## What was NOT allowed to change, and did not

- **Money.** Verified per document on a fresh connection: 508800 / 599000 /
  419000 sen, both columns, before and after.
- **Quantity.** No line was added or removed on any of the six documents —
  `lines updated 3 · added 0 · removed 0` on each.
- **The dedication.** Probe `34188689460` after the write: every purchase-order
  row is still dedicated to the sales-order row with the SAME code, on all three.
- **Readiness.** `PENDING 13080 / READY 1969 / PARTIAL 11` immediately before the
  recompute and again after it drained. It did not move and did not regress.
- **`custom_specials`.** Never written; it is derived and self-erasing.

## Provenance — every run, in local Malaysia time (UTC+8)

| what | run | time |
| --- | --- | --- |
| readiness baseline (`PENDING 13051 / READY 1997 / PARTIAL 12`) | `34186244524` | 12:13 |
| DRY-RUN that exposed the positional pairing | `34186295345` | 12:14 |
| read-only probe: dedications, and all 9 target SKUs exist | `34187267757` | 12:31 |
| DRY-RUN after the pairing fix — every piece `change X -> X` | `34188148437` | 12:45 |
| APPLY `HC-PO-009550` (Tee) | `34188339400` | 12:49 |
| APPLY `HC-SO-010882` (Tee) | `34188392136` | 12:50 |
| APPLY `HC-PO-009017` (Sulaiman) | `34188453353` | 12:51 |
| APPLY `HC-SO-011660` (Sulaiman) | `34188506374` | 12:51 |
| APPLY `HC-PO-009712` (KONG KIT YING) | `34188567217` | 12:53 |
| APPLY `HC-SO-012629` (KONG KIT YING) | `34188619213` | 12:53 |
| probe re-read after the write — 0 compartments moved row | `34188689460` | 12:55 |
| allocation recompute enqueued (token `a8c96944`) | `34188747031` | 12:56 |
| readiness after, queue drained | `34189209390` | 13:03 |
| reconcile: SO item code 10 -> **1**, PO item code 9 -> **0** | `34189267879` | 13:04 |
| `sync-ac-delta` lane `links`, PLAN only | `34189374674` | 13:06 |

Applied per DOCUMENT, never as a whole-file run: the corrections file also holds
an unapplied insert for `HC-SO-012929` (`add 1S`) that belongs to another lane,
and a whole-file APPLY would have written it as a side effect.

**The `links` lane has nothing to re-dedicate.** Its plan after the correction
(`34189374674`) names one dedication to write and one refusal, and **neither is on
any of the six documents** — `SODtlKey 701070`, not ours. That is consistent with
the probe: the dedications never broke, because the pairing fix kept every
compartment on its own row.

## The one sales-order item-code difference that is left

`HC-SO-012128`, and it is a different problem: the book holds `HOK-5530 SOFA` and
four `HOK-SQUARE PILLOW`, and the four pillows are not in the ERP at all. The
reconcile pairs the book's pillow line against the sofa's spare compartment row
and reports it as an item-code difference; it is a MISSING LINE, which no
item-code correction may add. See
`docs/bugs/0691-a-missing-line-on-a-sofa-document-is-invisible-because-line.md`.
It belongs to the line-count lane.

## Shipped in

| PR | what |
| --- | --- |
| #3185 | the three models corrected to the book, the grader, and the CI guard |
| #3190 | the positional-pairing fix and the `desc2Match` that could not match |

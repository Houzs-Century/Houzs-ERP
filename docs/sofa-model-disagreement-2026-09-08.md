# Three sofas whose MODEL disagrees with the account book — an owner decision, 2026-09-08

**Status: OPEN. Nothing has been changed on these three orders.** They are the
last item-code differences left on sales orders and purchase orders after the
go-live repair, and they are not repairable by script — the rule that refuses
them exists because ignoring it once proposed RM 2,216,501 of invented revenue
(`docs/bugs/0673`).

## 白话

三张沙发单,**账本写的型号跟我们系统写的型号不一样**。不是拆件的问题 —— 件数、
颜色、尺寸都对得上,只有**型号**对不上。

| 订单 | 客户 | 采购单 | 账本写 | 我们写 |
| --- | --- | --- | --- | --- |
| `HC-SO-010882` | Tee | `HC-PO-009550` | `DSL-8030 SOFA`(8030) | 9058 的三件 |
| `HC-SO-011660` | Sulaiman | `HC-PO-009017` | `AMN-SF9058 SOFA`(9058) | 8030 的三件 |
| `HC-SO-012629` | KONG KIT YING | `HC-PO-009712` | `HOK-5535 SOFA`(5535) | 8030 的三件 |

**卖单跟采购单是一致的** —— 两边都写同一个型号,只是两边都跟账本不一样。所以这
不是「其中一张写错」,是这三张沙发从一开始进来时型号就被换掉了。

要不要照账本改回去,请老板决定。

## What is actually true, and how it was established

Measured 2026-09-08 against `ac-reconcile-truth.json.gz` cut 08:03 (UTC+8), and
production read live by run `34182710620`.

**1. The book's Desc2 and our compartments AGREE.** The build is not in question:

```
HC-SO-010882 / HC-PO-009550   DtlKey 758395 / 868619
  book Desc2   BO315-23 (BEIGE)/32"/1R+C+2R
  ours         9058-1A(LHF), 9058-CNR, 9058-2A(RHF)

HC-SO-011660 / HC-PO-009017   DtlKey 803503 / 829659
  book Desc2   GD2502#09-SANDY/30"/1B+C+2R
  ours         8030-1B(LHF), 8030-CNR, 8030-2A(RHF)

HC-SO-012629 / HC-PO-009712   DtlKey 860757 / 884504
  book Desc2   1R+C+2R (30") / COL: BO315-3 BEIGE / BOTTOM USE UMBRELLA FABRIC
  ours         8030-1A(LHF), 8030-CNR, 8030-2A(RHF)
```

Neither Desc2 mentions another model, so our model did NOT come from the
customer's build text.

**2. The sofa alias does not explain it.** `SOFA_MODEL_ALIAS` is
`{5530: 9028, 5536: 9058, 5537: 8030, 5540: 8030}` and the owner confirmed it on
2026-09-08. None of the three book codes folds onto what we hold:
`8030` is already `8030`, `9058` is already `9058`, and `5535` is its own model —
the owner ruled it must never be folded. `autocount-erp-mapping-1561.csv` says
the same in ERP terms: `DSL-8030 SOFA -> 8030-1S`, `AMN-SF9058 SOFA -> 9058-1S`,
`HOK-5535 SOFA -> 5535-1S`.

**3. The catalogue CAN carry the book's answer.** Probe run `34182299845`
measured 5 of 1,445 mapped ERP codes absent from `scm.mfg_products`, and the four
absent sofa codes are `5530-1S / 5536-1S / 5537-1S / 5540-1S` — the alias SOURCE
spellings. `5535-1S`, `8030-1S` and `9058-1S` are all carried. So following the
book is possible; it is not blocked on minting a product.

**4. The models were WRITTEN DOWN once, but never justified.**
`backend/scripts/data/sofa-compartment-corrections-2026-08.json` (owner-approved
2026-08-10) names all three of these document pairs and states a `model` for each
— `9058`, `8030`, `8030`, i.e. exactly what the ERP now holds. Its `why` field
justifies the PIECES only ("Desc2 1R+C+2R — the corner was eaten by the NOISE
regex"). **The model was carried along, not decided.** That file is therefore not
independent evidence for the model, and it is also the reason this must not be
flipped by a script: it would silently contradict an owner-approved artifact.

**5. The book's own vocabulary says these are different suppliers' models.**
`docs/bugs/0538` records the owner on 2026-08-25: `AMN-SF9028/9058` and
`DSL-8030/9028/9058` are ARMANI's and DORSETTLOFT's numbering; `HOK-5530 / 5535 /
5536 / 5540 / 5543` are Hookka's own. A `DSL-8030 SOFA` line and a `9058`
compartment set are not two spellings of one sofa.

## Why no script may decide it

- `linked_ac_dtlkey` is not unique: one book sofa line is one ERP row per
  compartment. A keyed repair that ignored that proposed RM 2,216,501 of invented
  revenue (`docs/bugs/0673`), so `lib/so-item-code-correction.mjs` REFUSES any key
  claimed by more than one ERP row. These three are refused by that rule.
- A sofa is HARD-BOUND: it reads READY only through its own dedicated
  purchase-order line (`isHardBoundLine`, `src/scm/lib/so-stock-allocation.ts`).
  Changing the model on the sales order without changing it on the purchase order
  breaks the binding; changing both moves stock readiness on a live document.
- The compartment SKUs for the target model must exist for all three pieces, not
  only the `-1S` that the coverage probe measured.

## The decision the owner owns

**跟账本 (follow AutoCount)** — change all 18 rows (3 sofas x 3 compartments x
sales order + purchase order) to the book's model, then re-dedicate and recompute
allocation. This is the same ruling he gave for the ten bedframes on 2026-09-08.

**保留 (keep ours)** — record here that the 2026-08-10 model values are
deliberate, and add these three to the reconcile's declared differences so the
column can reach zero.

## What is NOT part of this decision

`SO-012128` is the tenth remaining sales-order item-code difference and it is a
**different problem**. The book holds two lines — `HOK-5530 SOFA` and
`HOK-SQUARE PILLOW` x 4 — and the ERP holds two lines, both `9028` compartments
of that sofa. **The four square pillows are not in the ERP at all.** The
reconcile pairs the book's pillow line against the spare compartment row and
reports it as an item-code and a quantity difference; both are artifacts of that
pairing. The real defect is a missing line, and it is invisible in the line-count
column because the sofa's two compartment rows make the two sides count the same
(`docs/bugs/0691`). That belongs to whoever owns the line-count lane, not here.

## Provenance

| what | run |
| --- | --- |
| the go-live reconcile that raised the 111 | `34178538830` (2026-09-08 10:00 UTC+8) |
| the reconcile after the parser fix | `34181828840` — SO 101 -> 52, PO 10 -> 9 |
| the correction plan, `POPULATION=all` | `34181792538` — 42 to correct, 310 refused decomposed |
| the correction applied | `34182517603` — 42 of 42, verified on a fresh connection |
| the reconcile after the repair | `34182710620` — SO 10, PO 9: these three sofas plus `SO-012128` |
| the catalogue coverage probe | `34182299845` |
| the plan re-run that PROVES convergence and names the customers | `34183673080` — `different` 0, `already names the book's product` 13,950 -> 13,992 |

## Stock readiness, before and after the 42 corrections

A direct SQL write does not trigger an allocation recompute (`docs/bugs/0675`),
so one was requested through the Worker's own queue row (run `34182606676`, token
`ac3f4920`) and the row was drained by the five-minute cron before the second
read. Company-1 imported sales-order lines:

```
before  PENDING 13081   READY 1968   PARTIAL 11      (run 34182061903, 11:07 UTC+8)
after   PENDING 13080   READY 1969   PARTIAL 11      (run 34183114608, 11:24 UTC+8)
```

One line moved PENDING -> READY. Other go-live lanes were writing in the same
window (`Sync AutoCount delta` run `34183057067`), so that single move is NOT
attributed to this correction with certainty — what IS established is that the
recompute ran and readiness did not regress.

## The tenth difference, established rather than inferred

`HC-SO-012128` carries no ERP line at all on AutoCount DtlKey `924549`: the plan
over every key our own lines carry (`34183673080`) never sees that key, while
`833309` — the sofa above it — is carried by exactly one row and agrees. The
document also appears in neither `unmatchedAc` nor `unmatchedErp` in run
`34182710620`, so both sides hold two lines. The second ERP line is therefore an
unkeyed `9028-1A(RHF)` compartment of that sofa, and the book's four
`HOK-SQUARE PILLOW` are absent. See `docs/bugs/0691`.

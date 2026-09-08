# 老板，最后那六张单：五张已经改好，一张不用改

2026-09-08。这一轮要处理的是**最后六张对不上的销售单**，加上一张收货单。

## 一句话

**六张里五张已经改好了，第六张查出来是我们的程式读错账本，单本身没错，不用动。**
那张收货单也一样——查过之后确认货和账本一模一样，没有对调。

## 六张单，一张一张说

| 单号 | 本来怎样 | 现在怎样 |
| --- | --- | --- |
| `HC-SO-011099` | 系统写成两张单人位 | **改成一张两人位**，跟老板看图的答案一样。连工厂那张采购单 `HC-PO-009882` 一起改，两张纸现在讲同一件事 |
| `HC-SO-005082` | 两张沙发都写成一人位 | **改成一张三人位、一张两人位**，跟账本一样 |
| `HC-SO-011221` | 写成「两人位＋一人位」两件散的 | **改成一套「二＋一」的组合**，跟账本一样 |
| `HC-SO-012128` | 账本有一行送客人的抱枕，系统里没有 | **补上了**（4 个，RM 0.00）。单据总额没变，库存没动 |
| `HC-SO-013496` | 选项打成手写字，跟选项表对不上 | **改成选项表本来就有的那个选项**。这个选项是免费的，所以钱一分没动 |
| `HC-SO-007293` | 报告说系统多了一张贵妃椅 | **系统是对的，不用改**——见下面 |

**每一张改完都重新连线读一次核对过**，件数对、钱一分没动。

## `HC-SO-007293` 为什么不改

账本上写的是「2S+L」，就是**两人位加一张贵妃椅**。系统里存的正好就是这个。

问题出在我们读账本的程式：账本那句后面接着写颜色，写法是「Clr:」。我们的程式不认得
「Clr」这个写法，就把紧挨着的那个「L」（贵妃椅）当成颜色的一部分吃掉了，剩下「2S」，
所以报告说两边不一样。

**改这个程式只要两个字，但今晚不改。** 我们先算过：一改，账本里另外 119 行沙发也会
跟着重新读一次，其中一张是老板今天早上才亲自看图定过的，一改反而会读错。所以这张单
的记录留在 `docs/bugs/0722`，等有人拿着图纸一张张核对的时候一起做。

**这张单还没开工，所以放着不会影响生产。**

## 那张收货单 `HC-GR-005334`

交办时说「有两张 AKEMI 床褥对调了」。**照账本自己的行号一条条对过，没有对调。**

有行号的四条，条条对得上：

| 账本行号 | 账本写的 | 系统里的 |
| --- | --- | --- |
| 917584 | ARMOUR (K) | ARMOUR (K) |
| 917586 | BASTION (Q) | BASTION (Q) |
| 917588 | BASTION (Q) | BASTION (Q) |
| 917590 | GUARDIAN (Q) | GUARDIAN (Q) |

其余七条**账本自己也分不出谁是谁**——同一款、同样数量，只有活动地点那栏不一样，而
我们的收货单没有那一栏。货、数量、价钱三样跟账本完全一样。

这件事其实之前已经查清楚并且结案了（`docs/bugs/0693`、`docs/bugs/0704`，还有
`docs/cutover-gr-iv-pi-remainder-2026-09-08.md` 写的「PROVEN 一模一样，那个差异是
检查程式自己猜的」）。当时报告把两条没有行号的自己配对，配错了；后来修好的是**报告**，
收货单本身从头到尾没问题。这次照行号重查一次，结论一样。

---

# The engineering record

## What was measured, and where

| document | closed by | run |
| --- | --- | --- |
| `HC-SO-011099` | collapse to `2S`, releasing the stranded purchase dedication | apply `34244691604` |
| `HC-PO-009882` | same build, corrected in the same entry | apply `34245244962` |
| `HC-SO-005082` | `3S` and `2S`, addressed by AutoCount line key | apply `34245886818` |
| `HC-SO-011221` | `2A(LHF)+1A(RHF)`, addressed by line key | apply `34249754616` |
| `HC-SO-012128` | the book's pillow line created | apply `34249774973` |
| `HC-SO-013496` | free text replaced by the picker's own code | apply `34254097020` |
| `HC-SO-007293` | **not repaired** — reader gap, `docs/bugs/0722` | measured offline |
| `HC-GR-005334` | **not a defect** — re-verified by line key | probe `34243496074` |

Every apply re-read its document on a FRESH connection and asserted the shape.
Money did not move on any of them: `288800/288800`, `0/0`, `450000/450000`,
`349000/349000`, total `330000` unchanged, and all three money columns unchanged
on the specials line.

## The tally, before and after

| axis | run `34235091322` (13:56) | run `34254400214` (16:59) |
| --- | --- | --- |
| the document itself | 0 | 0 |
| every book line present | 1 (`HC-SO-012128`) | **0** |
| SKU / item code | 0 | 2 — neither from this lane |
| quantity | 0 | 0 |
| unit price and document total | 0 | 0 |
| colour / fabric | 0 | 0 |
| seat size | 0 | 0 |
| specials | 1 (`HC-SO-013496`) | **0** |
| sofa compartments | 5 | **1** (`HC-SO-007293`, deliberately left) |

**The control holds.** Every axis this lane was told to keep at zero is still at
zero, and no document changed bucket except the ones it touched.

## What the second run reads that the first did not, and whose it is

The 16:59 tally reads **38 differ** against the first run's 6. That is not a
regression and none of it is this lane's:

* **35 `transfer to`.** A NEW axis — 「单据转换链」, the owner's own question,
  added by another lane between 15:57 and 16:33. It did not exist in the 13:56
  run at all.
* **2 SKU / item code** — `HC-SO-009735` and `HC-SO-011657`. The second is the
  held stool build waiting on `9838-STOOL` being minted.
* **2 bedframe** (`T.Heights`, `leg height`) — `HC-SO-009735`, the same document.

### `HC-SO-012128` on the `transfer to` axis is its SOFA line, not the line created here

It would be easy to assume the added line caused it, and the run history cannot
separate them: the axis landed and the line was written inside the same
half-hour. So it was settled from the data instead. That axis compares the
book's `SODTL.TransferedPOQty` against `mfg_sales_order_items.po_qty_picked`, and
`ac-convert-edges.json.gz` states, for `SO-012128`:

```
dtl 833309  HOK-5530 SOFA       transferedPoQty "1.0000"    <- the sofa. Untouched here.
dtl 924549  HOK-SQUARE PILLOW   transferedPoQty ""          <- the line created here.
```

The book states **no purchase counter at all** for the created line, so it cannot
be the finding. The shape is identical on `SO-013389`, one of the other 34
documents on that axis that this lane never went near.

## Two things found in passing, both recorded

* **`docs/bugs/0725`** — an apply over EVERY corrections file plans to ADD back a
  `1S` on `HC-SO-012929` that the owner removed a round later. The READER was
  taught "the newest ruling is the ruling" on 2026-09-08; the WRITER still applies
  every file in order. Every apply from this lane was scoped with `DOC=` because
  of it. Nothing in another lane's data was changed.
* **The line-key selector counted rows against keys.** A sofa is ONE book line and
  several ERP rows, all carrying the same key, so `HC-SO-011221` — two
  compartments, one key — was told "the document does not carry these line
  key(s)": a sentence about a missing key produced by a shared one. Fixed with
  both directions tested red first.

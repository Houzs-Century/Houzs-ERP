# The sofa line keys — 2026-09-08 (Malaysia, UTC+8)

**白话，一句话先讲完：本来有 89 张沙发单，员工在 ERP 里根本改不了 —— 现在剩 8 张。**

一张沙发在账本（AutoCount）里是**一行**，在我们系统里是**一件一件分开的行**（左扶手、
中座、角位…）。中间靠一个看不见的编号，把我们那几行认回账本的那一行。少了这个编号，
两件事同时坏掉：

1. **整张单改不了。** 只要一张单里有一件缺编号，系统就当整张单「认不出自己是账本哪
   一行」，员工按下去会被挡住。老板马上要开放销货单编辑，这 89 张就是会当场卡住的。
2. **对账对不了。** 沙发要几件一起看才知道对不对，没有编号就凑不回一整张沙发，所以
   报告里既不算「对」也不算「不对」，而是**看不到**。

补上编号**不是**改沙发的件数 —— 那是老板的决定。补编号只是把「这几行本来就属于账本
那一行」这件事记下来，不需要谁批准。编号补上之后如果发现件数真的对不上，我们**只报
告，不改**。

---

## Phase 1 — the 195 "unread", split by cause

Reconcile run **`34209358931`** (branch, 2026-09-08 17:19 +08), sales orders:

```
sofa compartments |  77 agree, 3 differ, 87 UNREAD (proceeded)
                  | 241 agree, 31 differ, 108 UNREAD (not proceeded)
```

195 answers the checker could not give. That column was one number carrying two
populations that need **different people**, so `check-ac-erp-reconcile.mjs` now
cross-tabs it — the two causes are independent, so a line can be both:

| count | proceeded / not | cause | whose |
|---:|---|---|---|
| **85** | 50 / 35 | no AutoCount line key, and the book's build text DOES decode | **mechanical — a key is all that is missing** |
| **5** | 4 / 1 | no line key AND the book's text does not decode | the key first, then the owner |
| **105** | 33 / 72 | keyed, but the book's build text cannot be decoded into pieces | **the owner's drawing is the only source** |
| **0** | — | anything else | — |

85 + 5 = 90, which reconciles exactly with the report's own line *"of the 547
sofa lines, 90 sit on a document whose ERP lines carry no AutoCount line key"*.
The `other` bucket exists so a third cause cannot arrive silently; it is listed
WHOLE rather than sampled, and it is empty, so the two causes are exhaustive.

**So the owner's 「一模一样」 bar can be met without him on 85 of the 195.** The
other 110 cannot: the book's own text does not say what the build is, and no
amount of keying changes that. Those are the same population
`docs/staff-reported-flow-2026-09-08.md` sizes as *"156 sofa lines … build cannot
be re-derived from Desc2 (photo needed)"*.

## Phase 2 — what was stamped, and what was refused

`backfill-ac-sofa-line-keys.mjs` had stamped **zero** rows in every run it ever
had, for three reasons that were all defects of its own rule and none of them in
the data — the alias it never folded, the outstanding cut it read instead of the
book, and a build map keyed by the string it then grouped by. Full trace:
`docs/bugs/0710-the-sofa-line-key-backfill-could-never-stamp-a-single-row-so.md`.

It no longer carries a matching rule. It calls `planLineKeys` from
`lib/ac-forced-line-pairing.mjs` — the module that already stamped the migrated
goods receipts and delivery orders. Third caller, not third copy.

| run | at (+08) | what |
|---|---|---|
| `34209494838` | 17:21 | PLAN, before the build-text clause — 96 rows on 45 book lines; **44** documents refused |
| `34210364936` | 17:29 | PLAN — **224** rows on **121** book lines, 81 documents; **8** documents refused |
| **`34210459226`** | **17:33** | **APPLY — `APPLIED: 224 row(s) stamped of 224 planned`** |
| `34210839524` | 17:37 | APPLY again — `0 row(s) stamped of 0 planned`. The `RE-RUN: inert` header, executed rather than asserted |
| `34211018125` | 17:41 | PLAN — the standing build-invariant measurement |

224 = **108** forced by being the only candidate + **116** matched one-to-one on
the build text + **0** interchangeable.

**The build text is what closed 25 of the 44 refusals.** Two sofas of one model
on one document are two book lines, and `foldErpUnits` collapsed every
compartment of that model into ONE unit, so the counts could never agree — a
refusal by ARITHMETIC, not by ambiguity. Where every compartment row of a model
carries a build text, the rows are grouped by it and each unit is matched to the
book line stating the SAME text: exact after `normaliseDesc2`, and a perfect
bijection or nothing. It splits only on evidence — one blank text on that model
and it folds exactly as before. It also dissolved the nine "our sofa compartments
are uneven" refusals: those builds were never uneven, they were two sofas folded
together.

### The 8 documents still refused, by name

| document | why |
|---|---|
| `SO-013384` | `SOFA 8030`: the book has no line of this item at this quantity |
| `SO-012025` | `SOFA 9050`: same |
| `SO-013145` | `SOFA 9021`: the book has 2 lines of this item at this quantity, they are NOT identical, and the build texts do not match one-to-one either |
| `SO-000015` | three non-sofa lines the book does not state at that quantity |
| `SO-000102`, `SO-001180`, `SO-001463`, `SO-001473` | one `TRANSPORTATION CHARGES` line each, same reason |

None is guessed at. A wrong DtlKey makes `AcSyncService` append a line to the
LIVE account book instead of editing the one that changed (migration 0273), so a
refusal is the cheap outcome and a stamp is the expensive one.

### 55 stored keys DISAGREE with the derived one — and none was overwritten

On 25 documents. Checked rather than waved away: on **every one of the 25** the
stored keys and the derived keys are the **same SET** on the same document — a
permutation, not a different answer. That is the interchangeable case, where the
book's own lines are identical on every column it states, so which row holds
which key is arbitrary **by proof**. They are reported by the tool on every run
and left exactly where they are.

## Phase 3 — what moved

Reconcile **`34209358931`** (before) against **`34211113921`** (after).

### The go-live number

| | before | after |
|---|---:|---:|
| **migrated sales orders staff could not edit at all** | **89** | **8** |
| `mfg_sales_order_items` sofa rows with no key | 237 / 1,168 | 13 / 1,168 |
| all `mfg_sales_order_items` carrying a key | 14,829 / 15,073 | 15,053 / 15,073 |

Nobody had measured that before this lane; `composeEdit` refuses the WHOLE
document for one keyless compartment, so the DOCUMENT is the unit that matters.

### The compartment axis

| | before | after |
|---|---|---|
| sofa compartments, PROCEEDED | 77 agree / 3 differ / **87 unread** | 135 agree / 8 differ / **37 unread** |
| sofa compartments, not proceeded | 241 / 31 / **108** | 288 / 34 / **76** |
| the `unread` cross-tab | 85 mechanical + 5 + 105 owner | **0 mechanical**, 113 owner |

The sofa population itself grew 547 -> 578 paired lines, because a keyed document
pairs book line to ERP build instead of falling back to value-then-order, so 31
more book sofa lines now have an ERP build to be compared against at all.

**82 answers the checker could not give, it now gives.** Every one of the 85
mechanical cases is closed; what remains is the owner's 113, and the report now
says so in its own words: *"0 can be made comparable WITHOUT the owner"*.

### FIVE REAL FINDINGS on orders the factory is building

These were always there. Nothing could see them.

| document | the book | the ERP |
|---|---|---|
| `HC-SO-009335` `8050` | `2S+1A(LHF)+1A(RHF)` | `1A(LHF)+1A(RHF)` |
| `HC-SO-010209` `9058` | `2A(LHF)+L(RHF)` | `1A(LHF)+1NA+1A(RHF)` |
| `HC-SO-010458` `8051` | `2A(LHF)+1A(RHF)+2S+1S` | `2A(LHF)+1A(RHF)` |
| `HC-SO-011099` `9028` | `2S` | `1A(LHF)+1A(RHF)` |
| `HC-SO-011114` `9058` | `2A(LHF)+1A(RHF)+2S+1S` | `2A(LHF)+1A(RHF)` |

Three more appeared on orders that are NOT proceeded — `HC-SO-008769`,
`HC-SO-010457`, `HC-SO-011756` — where the book states arms and the ERP holds
plain seats.

**NOT corrected here.** The owner's rule is 「一律跟账本。除了sofa compartment而已
啊」: only what the compartments ARE needs his judgement. Stamping a key needed no
ruling; changing a build does. No proceeded compartment difference DISAPPEARED,
so nothing was papered over.

### `HC-SO-012128` — settled, and it was 2 of the 23

The known member of this population. Its two ERP rows are a `HOK-5530 SOFA`'s
compartments; with no key the checker paired the book's `HOK-SQUARE PILLOW x4`
line against the second compartment and reported **an item-code difference and a
quantity difference**. Both are gone. The book line now reads honestly as
*"SO-012128: AutoCount DtlKey 924549 has no ERP line"* — the missing pillow line
that `docs/cutover-so-do-remainder-2026-09-08.md` section C describes, stated
once instead of disguised as two defects.

**The whole reconcile went 23 -> 21**, and the two that closed are exactly SO's
`item` 1 -> 0 and `qty` 1 -> 0.

### CONTROL — nothing outside this lane moved

The SUMMARY table diffs by **two cells and one headline**, all of them SO's:

```
< SO 13378 2789 2883  0  1  2882  2  1  1  0  2 ...   (before)
> SO 13378 2789 2883  0  1  2882  2  0  0  0  2 ...   (after)
< 23 disagreements ...      > 21 disagreements ...
```

`PO`, `GR`, `DO`, `IV` and `PI` rows are **byte-identical**, and so are their sofa
compartment rows (PO `120/6/27`, GR `43/0/6`, DO `19/2/8`, IV `0/0/2`,
PI `0/0/6`). SO's `lineCnt 2`, `price 0` and `money 2` did not move either. The
quantity cell DID move, 1 -> 0, and that is `HC-SO-012128` above — the outcome
this lane was asked to produce, not a regression.

Two other axes moved, both DOWNWARDS, and both for the same reason — a keyed
document is paired by key instead of by guess: **specials** DIFFER on proceeded
SO+PO 5 -> 3, and **seat size** DIFFER on not-proceeded 2 -> 0. Those were
pairing artifacts.

### Stock and readiness did not move — measured, not asserted

| check | before | after |
|---|---|---|
| `check-stock-vs-autocount` | `cells compared: 996 \| AGREE: 962 \| DISAGREE: 0 \| AutoCount-only: 0 \| ERP-only: 3` | identical |
| the sofa half of it | `SOFA cells compared: 41 \| AGREE: 19 \| DISAGREE: 22` | identical |
| whole sofas | `AutoCount 107 vs ERP 107 (net +0)` | identical |
| go-live readiness | `live 2794 / processing date 584 / READY_TO_SHIP 220`; `READY=1725, PENDING=1377, PARTIAL=10`; `PO received but not READY 36` | identical |
| migrated-cancel exposure | `0 movement rows behind 646 migrated documents` | identical |

Runs `34209406077` / `34209410054` / `34209413438` before, `34211130155` /
`34211133726` / `34211136751` after.

The apply run proved the same thing from inside, on a FRESH connection:
`mfg_sales_order_items rows 15073, qty 25417, unit_price_sen 1845484000,
total_sen 1981667900`, `SO line readiness PARTIAL 11, PENDING 13093, READY 1969`
and `migrated-document movement LEAK 0/0/0` — identical either side of the write.
**A line key is an identity, not a quantity.**

### The build invariant, as a standing measurement

Run `34211018125`, read-only: across **all 523** migrated sales orders holding a
sofa, **578 builds, 2 of them not agreeing on one key**, and **0** containing a
row this lane stamped. The two are `HC-SO-013384` and `HC-SO-012025` — both in
the 8 refused above, both already half-keyed before this lane ran, and now
visible for the first time.

## What is left, and who owns it

| # | item | owner |
|---|---|---|
| 1 | **113 sofa lines whose build the book's text cannot express** — 37 on proceeded orders. The drawing is the only source | **the owner** |
| 2 | **5 proceeded + 3 unproceeded compartment differences** newly visible above. Following the book means changing a live build | **the owner** |
| 3 | `HC-SO-013384`, `HC-SO-012025` — half-keyed builds where the book states no line at that quantity; `HC-SO-013145` — two 9021 lines nothing separates | needs a look, not a guess |
| 4 | four `TRANSPORTATION CHARGES` lines and `SO-000015`'s three, keyless because the book does not state them at that quantity | the book-line top-up lane |
| 5 | **purchase orders** — deliberately untouched here as the control. Their sofa `unread` column is 27, all of it the owner's (`0 can be made comparable WITHOUT the owner`), so there is no mechanical gap left to close there | — |
| 6 | 55 stored keys that disagree with the derived assignment, on 25 documents, every one a permutation of the same set | nothing to do; recorded so it is not re-chased |

## What was NOT touched, deliberately

- **The ERP -> AutoCount write-back.** Owner, 2026-09-08:
  「写回autocount的你不需要理了」. No outbox row was written and no AutoCount call
  was made by anything in this lane.
- **Payment columns.** Out of scope.
- **What the compartments ARE.** Only which book line they belong to was
  recorded.
- **Purchase orders, goods receipts, delivery orders, invoices.** The shared
  pairing module gained a clause, and the goods-receipt and delivery-order lanes
  were re-run from `main` (`34210033771`) and from this branch (`34210128201`) to
  prove it inert for them — both read `GR ... 563 already keyed; 73 NOT stamped`
  and `DO ... 796 already keyed; 36 NOT stamped`, character for character.

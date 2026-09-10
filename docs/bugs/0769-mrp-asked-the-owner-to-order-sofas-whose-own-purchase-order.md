## MRP asked the owner to order sofas whose own purchase order was already received [high]
<!-- area: Sofa, fabric, variants -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-09, on the Stock Status Report: *"你确定在 MRP 显示出
来的 sofa 跟 bed frame 都是 short、需要 order 的吗？并且确定它们是没有开过 PO 的
吗？…by right 如果这一个 line 已经有 PO，就不应该叫我 order."*

He was right about sofa and wrong about bedframe, and the split is the finding.
Read off the LIVE rendered page, default view (dated demand only):

| tab | rows | qty needed | STOCK | shortage | of which really missing |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bedframe | 415 | 478 | 30 | **50** | **50** — correct to the unit |
| Sofa | 136 | 361 | **0** | **70** (28 orders) | **42** |

Checking all 28 sales orders the sofa tab asked for, against the database:
**8 orders / 26 units already had their own purchase order FULLY RECEIVED**, and
**26 of those very sofa lines read READY on the sales-order screen** at the same
moment the MRP page asked him to buy them again. Five more orders had a purchase
order still incoming. Only 15 genuinely had none. Meanwhile the STOCK column read
**0 on all 136 sofa rows** while **246 units** of company-1 sofa stood in the
warehouse.

**Root cause (traced).** `docs/bugs/0736` moved company-1 hard-bound lines onto
the dedicated-PO model — a bound line draws its OWN purchase order's receipt
(`dedicatedReceivedByLine`) and then its own outstanding quantity, and a
dedicated PO line leaves the pooled supply entirely. It was applied to **section
7 only**. `isDedicated` in `routes/mrp.ts` carried an explicit exclusion:

```ts
&& (r.item_group ?? '').trim().toLowerCase() !== 'sofa'
```

with a comment stating the exclusion was deliberate — *"Excluding sofa PO lines
from the pool without rewriting that walk would starve it."* That was true about
the mechanism, and it described **work not yet done**, not a design decision. So
section 8 (the sofa set walk) still planned every set on the pooled bucket key
alone.

That is survivable for an OUTSTANDING purchase order, which sits in the pool
under its own variant key. It is not survivable for a RECEIVED one:
`left = qty − received_qty` is 0, the line never enters the pool at all, and with
no `dedicatedReceivedByLine` leg its receipt could only reach the plan through
the STOCK bucket — whose key is `fabricCode|seatHeight|legHeight|specials`, four
free-text fields the order and the receipt spell differently far more often than
not:

```
HC-SO-011008 asks    fabriccode=modenza-01|seatheight=32|special=nylon fabric
HC-PO-009881 landed  fabriccode=modenza-06|seatheight=32|special=bottom wrap by nylon fabric,nylon fabric
```

`HC-PO-009881` is that order's own purchase order, received in full, five pieces.
MRP reported shortage 5.

**This was MRP disagreeing with the readiness engine, not a new rule.**
`isHardBoundLine` has named sofa a bound group since 2026-08-10 and
`lib/so-stock-allocation.ts` honours it. Measured on production: of **1,240** open
company-1 sofa lines, **zero** read READY without their own purchase order and
**zero** carry a batch claim without one. So the fix can take coverage away from
no line the allocator currently lights.

**Fix.** Drop the sofa exclusion from `isDedicated`, and give section 8 the twin
of section 7's branch — `boundSofa` (company 1) draws
`dedicatedReceivedByLine` then `dedicatedOpenByLine`, and nothing else. Company 2
keeps the pooled model untouched, exactly as `docs/bugs/0736` left it
(owner: 「修,但只能动 Houzs Century」).

**Verification.**

- **Five tests written RED first** in `backend/src/scm/routes/mrp.test.ts`
  (`company 1: a sofa set is planned from its own purchase order only`): on the
  unfixed tree 3 failed / 2 passed; after the fix **50/50 in that file**. The
  first is `HC-SO-011008` reduced — own PO received, stock under a different
  variant key, expected shortage 0.
- Backend light suite **10,314 passed / 1 failed**, and that one
  (`tests/doStockLeavesOnConfirm.test.ts`, a source-text assertion) **fails
  identically on an unmodified tree** on this machine — a Windows line-ending
  artefact, not this change. Backend workers suite **452/452**. `tsc --noEmit`
  clean.
- **PREDICTED effect on the page, measured against production with the new
  rule's own definition** — this is a prediction, not an observation of the
  deployed engine, and the sofa tab must be re-read after deploy to confirm it:

  | | before (live page) | predicted after |
  | --- | ---: | ---: |
  | sofa units needed | 361 | 361 |
  | shown as STOCK | **0** | **146** |
  | covered by its own PO | — | 172 |
  | **shortage** | **70** (28 orders) | **43** (17 orders) |

  146 + 172 + 43 = 361, and the 361 matches the live page's own total exactly.
  (An earlier per-ORDER estimate said 42; the engine floors per LINE, so 43 is
  the figure to check against.)

**Left open, deliberately.** `backend/scripts/audit-mrp-pairing.mjs` — the
canonical replica the module doc says must move in lockstep — models neither the
dedicated rule nor this change. It has not been touched since `#3156`, so it was
already out of step with `0736`; this entry records the gap rather than widening
it silently. And the **PO Outstanding column reads 0 for every bedframe row**,
because a dedicated PO line leaves the pooled supply that feeds
`poOutstandingByKey`; sofa is unaffected (its column is built from `orderedQty`
in the frontend adapter). Both are display-level and neither changes an
allocation.

**Ref.** `fix/mrp-sofa-dedicated-po`, 2026-09-09. Extends `docs/bugs/0736`; the
measurement in context is the cutover audit landing in PR #3476 (three owner
questions, measured), section 3.

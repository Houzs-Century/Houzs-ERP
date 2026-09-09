# What MRP actually plans on, per category — and where it differs from the stated rule

**The owner asked on 2026-09-09:**

> 再确保看一下我们的 mattress 和 accessories 的 MRP 那一边计算，是不是都是跟着
> 库存的？
>
> 然后我的 MRP 暂时计算都是根据这样子（transfer to transfer from）：就是说如果有
> processing date 的同一时间，它又没有开过 PO，那就会出现在我的 MRP 那一边。
> 对于 bed frame 和沙发，这样是对的吗？

Measured against production, read-only, 2026-09-09. Company 1.

---

## 1. Mattress and accessories — YES, they follow stock

`isHardBoundLine` (`backend/src/scm/lib/so-stock-allocation.ts`) carries the
owner's own 2026-08-10 ruling in the source:

> SOFA 和 BEDFRAME 因为有变体的问题,所以要走 Convert to PO 的那个模式. 可是
> MATTRESS 跟 Accessories 都是没有变体的 … 走回我们正常 MRP 的模式

plus the 2026-08-29 amendment that an `(SP)` special-order mattress binds like a
bedframe. In MRP (`routes/mrp.ts`, the demand walk) that becomes one line:

```ts
const fromStock = bound
  ? Math.min(need, dedicatedReceivedByLine.get(r.id) ?? 0)   // its OWN PO only
  : drawBucketStock(bucketStock, ..., need);                  // real on-hand stock
```

**Measured on prod, not inferred.** Live proceeded company-1 lines, by what
actually made them READY:

| engine | READY lines | of which with NO received PO |
| --- | ---: | ---: |
| POOLED — mattress + accessories | 1,230 | **1,203** |
| HARD-BOUND — bedframe + sofa + (SP) | 473 | **0** |

1,203 pooled lines lit from stock alone with no purchase order anywhere near
them, and **not one** hard-bound line lit without its own received PO. The two
rules are doing exactly what they say, with zero exceptions.

---

## 2. The processing-date rule — it is real, but it is NOT the MRP page

The stated rule is **half right, and the half that is wrong is which screen it
belongs to.**

### Where the processing date IS the gate

`so-stock-allocation.ts` — the engine that sets a line READY or PENDING:

```ts
const allocGated = new Set(
  orders.filter((o) => !o[SO_PROCESSING_DATE_COLUMN]).map((o) => o.doc_no),
);
```

An order with no Processing Date claims no stock and can never read READY —
the owner's 2026-08-10 rule (*"它明明都没有 Processing Date, 干嘛分配呢"*),
correctly implemented.

### Where it is NOT

The MRP page does not read it. `shared/so-processing-date.ts` says so in as many
words:

> MRP does not read this date to decide when to order at all — it derives
> `orderByDate = delivery date − category lead days` (routes/mrp.ts) and only
> DISPLAYS the Processing Date.

MRP's visibility gate is `isDatedLine(r) = deliveryOf(r) !== null` — the
**effective DELIVERY date**. Undated lines are hidden by default
(`?includeUndated=true` shows them) and counted either way.

**And MRP does not filter on "no PO" either.** Every live line appears; the
allocation tags it `stock`, `po` (with the PO number and ETA) or `shortage`. A
line with a purchase order is not removed from the page — it stops being a
shortage. There is no `po_qty_picked` lock; that was removed 2026-05-31.

### How much the two rules actually disagree, today

| population | lines | orders |
| --- | ---: | ---: |
| Processing Date set, **no delivery date** → released to buy, but MRP hides it by default | **30** | 10 |
| Delivery date set, **no Processing Date** → MRP shows it, but purchasing is not released | **86** | 22 |

Small, because in practice the two dates are nearly always set together. Of the
30 hidden, 24 are pooled (mattress/accessories) and 6 are hard-bound; 25 of the
30 have no PO yet. Nothing is *lost* — `?includeUndated=true` reveals them and
the tally counts them either way — but on the default page they are invisible.

**This is a judgement call, not a defect, so it is asked and not changed:** if
"released for purchasing" is what the MRP page should be listing, then the gate
should be the Processing Date and not the delivery date. The code is currently
consistent with its own documentation; it is the *documentation and the owner's
model* that disagree.

---

## 3. Is that right for bedframe and sofa? — the rule is right, with one hole

For a hard-bound line the model is right: no dedicated PO means no stock draw,
so it shows as a shortage and it can never read READY. **126 proceeded
bedframe/sofa/(SP) lines across 73 orders have no purchase order of their own**
(bedframe 78 lines / 49 orders, sofa 48 lines / 24 orders). 125 of the 126 are
visible on the MRP page; 1 is hidden for want of a delivery date
(`HC-SO-000870`, MS TEOH, Processing Date 2024-04-23).

### The hole: 10 of them are masked by somebody else's purchase order

MRP offers a bound line its own dedicated PO **and then the pooled queue**:

```ts
const queues = bound ? [dedicatedOpenByLine.get(r.id) ?? [], poQueue] : [poQueue];
```

So for **10 of the 126**, an unlinked open PO with the same item code in the same
warehouse exists, and MRP reports the line as *covered by PO-xxxx* rather than as
a shortage — while the readiness engine will never light it, because that PO is
not ITS PO. The buyer sees "already on order", the order sits PENDING forever,
and nobody is told.

This is the exact mirror of bug 0572 (*"他明明都没有 PO,怎么会 ready 呢"*), on the
other screen. The pooled fallback is deliberate — the comment records that
removing it made `po-so-coverage` answer that an unlinked PO serves nobody — but
its side effect on a HARD-BOUND line was not considered: for a bound line a
pooled PO is never a real answer, because the binding means only its own PO can
ever satisfy it. **Named here as an owner decision rather than repaired**, since
the fix trades against a screen the buyer uses.

### And 3 of the 126 are already bought — the link is just missing

`HC-SO-012025` (WINNIE, IN_PRODUCTION). `HC-PO-009024` was raised **for this very
order** and lists all five pieces; three of its lines were never linked to the
sales-order lines:

| sales-order line | on the purchase order | linked |
| --- | --- | --- |
| `9050-1A(LHF)` | yes | ✅ |
| `9050-1S` | yes | ✅ |
| `9050-1A(RHF)` | yes | ❌ |
| `9050-1NA` | yes | ❌ |
| `9050-CNR` | yes | ❌ |

The two documents list exactly the same five pieces — this is a pure linking
gap, not the content mismatch of
`docs/cutover-transfer-links-2026-09-09.md` §2c. The consequence is real on both
screens: MRP asks the buyer to order three sofa pieces that are already on order,
and the sales order can never reach READY.

**This is the tightest test that survives, and the number is 3, not 10.** A
looser "an open PO somewhere carries this item code" match returned 10 lines and
was wrong — it paired `HC-PO-010085` (Jack Lai's order) with MICHAEL, James Low,
MR LEW and Farah purely because sofa compartment codes repeat across orders. Only
a PO already linked to the SAME sales order proves anything.

---

## What is left open

| # | item | whose call |
| --- | --- | --- |
| 1 | Should the MRP page's gate be the **Processing Date** instead of the delivery date? Today 30 released lines are hidden and 86 unreleased ones are shown | owner |
| 2 | A pooled PO masks a shortage on 10 hard-bound lines that it can never actually satisfy | owner |
| 3 | `HC-SO-012025` / `HC-PO-009024` — 3 sofa lines to link; content already matches | repairable now |
| 4 | `HC-SO-010287` / `HC-PO-010085` — arms mirrored; owner ruled 2026-09-09 *「全部跟着销售单」* | repair to the SALES ORDER's pieces |

Items 1 and 2 change how a screen plans and are not being changed unasked.
Items 3 and 4 are specific documents with a customer behind each.

**Ref.** Measured 2026-09-09 against prod, read-only. Rules read from
`so-stock-allocation.ts`, `routes/mrp.ts` and `shared/so-processing-date.ts` —
not from summaries.

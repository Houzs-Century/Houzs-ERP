## The delivery-order stock guard did not honour hard binding, so a READY order could not ship [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner, 2026-09-11: staff see the goods in AutoCount, raise a
delivery order, and the screen answers *"Stock not enough at the selected
warehouse — JAGER-(Q) at PENANG WAREHOUSE: need 1, available 0"*. The only way
forward is **Ship anyway**. His question named the defect: 「哪一张 Sales Order
出货，它就会拿哪一张 PO，它们之间的 relationship 都是 hard binding，不是吗?」

**Root cause (traced, and the case is clean).** `HC-SO-013065`'s `JAGER-(Q)`:

- its OWN purchase order `HC-PO-009766` is RECEIVED **1/1**
- through OUR goods receipt `HC-GR-005232-PO-009766`, POSTED, **carrying the
  full variant** (PC151-01 / gap 12" / divan 8" / leg 0" / total 20")
- the sales-order line reads **READY**
- and `inventory_balances` for that exact bucket at PG WAREHOUSE reads **-1**

Nothing in that chain is broken. The goods arrived, keyed correctly, and the
line was lit correctly. What failed is that **two halves of the system asked
different questions about the same line**:

| | what it reads |
| --- | --- |
| readiness (`so-stock-allocation.ts` step 6b) | the line's OWN `purchase_order_items.received_qty` — never `inventory_balances` |
| the DO pre-flight (`check-stock-availability.ts`) | the SHARED `(warehouse, item_code, variant_key)` bucket |

A hard-bound line's units are earmarked for it, but the bucket they land in is
shared, so **another order's delivery can draw out the physical units this
line's own receipt put in** — and then this line is told it has none. The
operator presses Ship anyway, the bucket goes further negative, and the next
line is worse. Measured the same day: **57 negative bedframe buckets**, and
bedframe keyed stock net **-18**.

That file's own header already recorded the class it keeps producing — *"the
pre-flight question and the inventory write disagreed … and Ship anyway became
the only way forward"* — for service lines and for an invented sofa leg height
(`docs/bugs/0722`). This is the third member of it and the first where the line
genuinely holds its goods.

**Fix.** `stockCheckableLines` takes a **required** `dedicatedlyCovered` set and
drops those lines the same way it drops service lines. `checkDoStockAvailability`
builds the set: for `HARD_BOUND_COMPANY_ID` only, take the delivery's hard-bound
lines, sum `received_qty` across their own purchase-order lines (cancelled POs
excluded; summed because one sales line can split across several purchase lines,
mig 0235), and include a line when its own receipts cover what this delivery
ships.

- **Company 2 is handed an EMPTY set** — 2990 pools, and that is the whole of the
  company gate. Owner: 「这个针对 co1 houzscentury only」.
- **Required, not defaulted**: a caller that says nothing would keep the old
  pooled answer with no compile error and no runtime signal (BUG CLASS
  optional-param-noop). The empty set is how a caller says "no binding to
  honour", and it reads as a decision.
- **A failed read yields an empty set**, returning the guard to its previous,
  stricter behaviour rather than waving a line through — the safe direction when
  we cannot tell.
- A service line stays excluded even when covered: it never moved stock at all.
- **AND THE WAREHOUSE MUST ACTUALLY HOLD THE GOODS.** The earmark says which
  units are this line's, not that they exist. Measured before shipping this: of
  **462** live lines the receipt test alone would wave through, **432** have the
  stock sitting in that warehouse under some variant key — the bucket is the
  wrong place to look, which is the point — and **30 do not**. For those 30 the
  goods are genuinely missing and the old warning was RIGHT; waving them through
  would trade a false "no stock" for a silent over-ship, the worse of the two
  errors. So cover is receipt AND bucket-blind on-hand: skip the variant bucket,
  never skip the warehouse.
- **Warehouses are resolved BEFORE the cover test**, because the test asks about
  THIS line's warehouse and a line's warehouse is `resolveDoLineWarehouses`'s
  answer, not a field on the request. The first cut computed cover first, asked
  about warehouse `null`, and covered nothing — a fix that typechecks and tests
  clean while doing exactly nothing. The two steps are now one exported helper,
  `uncoveredStockCheckLines`, which takes the resolved warehouse map as a
  REQUIRED argument — so the order is a property of the module rather than
  something a route has to remember, and writing it the wrong way round no
  longer compiles.

**Proved RED.** Removing the one filter clause and re-running
`backend/tests/stockCheckableLines.test.ts` fails two of the five new cases,
first among them *"a line whose own purchase order covers it is not a pool
question"*. Restored: **21 passed**. Removing the ON-HAND half alone fails *"NOT covered when the warehouse holds nothing — the old warning was right"*, so both halves are pinned separately. Making the helper ignore the map — the ordering bug in one line — fails *"kept when the map is empty"*. `npm --prefix backend run typecheck` clean.

**The damage already done is MEASURED, not estimated.**
`backend/scripts/check-hard-bound-stock-gap.mjs` + **Hard-bound stock gap
(read-only)** answer the two questions the fix leaves open, and were run against
production on 2026-09-11:

- **52 negative bedframe/sofa buckets, -55 units.** That is the Ship-anyway hole
  in the goods this rule governs. (The bigger-looking negatives — service -2874,
  others -1275 — are not furniture: a service line never moves stock at all.)
- **30 live lines whose own PO was received and whose warehouse holds nothing**,
  21 bedframe and 9 sofa, out of 465 received hard-bound lines. Every one reads
  READY. For these the old warning is RIGHT and the fix deliberately keeps it:
  the goods left the warehouse on somebody else's delivery, or never got keyed
  in, and finding them is a physical job.

**What this does NOT do, said rather than implied:** it does not repair the 52
negative bedframe/sofa buckets already created, and it does not touch the separate
blank-variant problem — stock arriving from AutoCount (`AC_CUTOVER`) carries no
variant and lands under a blank key, which is why 618 bedframe units sit in a
bucket no order can name. That one is unresolved and is not this.

**Ref.** `fix/do-honours-hard-binding`, 2026-09-11. Guide updated in the same
PR: `docs/modules/delivery-order.md`.

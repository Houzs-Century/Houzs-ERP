## MRP let a pooled purchase order cover a hard-bound line the readiness engine will never light [high]

<!-- area: MRP + planning -->
<!-- status: fixed -->

**Symptom.** A company-1 bedframe or sofa line with no purchase order of its own
could read *covered by PO-xxxx* on the MRP page — and on the buyer's
"Assigned Sales Order" cell — while the stored allocator kept it PENDING for
ever. The buyer saw "already on order" and did not raise the purchase order the
line actually needs; the sales order never reached READY; nothing anywhere said
why.

**Measured on prod 2026-09-09** (read-only): of the **126** proceeded company-1
bedframe / sofa / `(SP)` mattress lines carrying no dedicated purchase order,
**10 were masked this way**.

**Root cause (traced, one line).** `routes/mrp.ts`, the demand walk:

```ts
const queues = bound ? [dedicatedOpenByLine.get(r.id) ?? [], poQueue] : [poQueue];
```

The dedicated queue was tried first and **the pooled queue second**. For a bound
line the pooled queue is not a weaker answer, it is a wrong one: `HARD_BOUND_
COMPANY_ID` means the stored allocator lights that line **only** from its own
received purchase order (`so-stock-allocation.ts`, bug 0572), so no pooled PO can
ever become its supply. Two engines, one order, opposite answers — the exact
mirror of 0572 on the other screen.

The stock half was already right (`fromStock` reads `dedicatedReceivedByLine` for
a bound line and never the bucket). Only the PO half fell through.

**Why it had been left.** The comment above the line argued for the fallback:
removing it made `po-so-coverage` layer (c) answer that an unlinked purchase
order serves nobody, and *"a planning engine may not quietly delete that"*. That
was right about the mechanism and **never measured its scale**. The population it
protects is every company-1 OPEN, UNLINKED purchase-order line on a hard-bound
item, and on prod that is **5 lines on 2 purchase orders** — `HC-PO-009024` and
`HC-PO-010085` — neither carrying a "From SOs" provenance note, and **both
already on the repair list for the same underlying reason**: their lines belong
linked to the sales order they were raised for
(`docs/mrp-stock-vs-bound-rules-2026-09-09.md` §3). A floating guess the
readiness engine will never honour is not worth keeping for two documents that
need a real link anyway.

**Fix.** A bound line is offered its own dedicated purchase order and nothing
else:

```ts
const queues = bound ? [dedicatedOpenByLine.get(r.id) ?? []] : [poQueue];
```

Pooled supply is still **reported** — `poOutstanding` on the SKU row still counts
that purchase order, so the page does not pretend the goods are not on order. All
that changes is that it may no longer be named as THIS line's cover, so the line
reads as the shortage it is. Company 2 is untouched: `boundCompany` gates the
whole branch (owner 2026-09-09, *「修,但只能动 Houzs Century」*).

**Verified — both tests proved RED on the old code first.**

- `mrp.test.ts` → *"an UNLINKED purchase order does not cover a bound line
  either"*: was `expected 'PO-NOBODYS' to be null`; now the line is short 5 and
  the PO is still reported as `poOutstanding: 5`.
- `poSoCoverageReadShape.test.ts` → *"a hard-bound SKU on an UNLINKED purchase
  order gets no floating answer"*: same fixture as the test above it with only
  the category flipped, so a failure can be nothing but this rule.

`backend` light suite 9,947 passed / 1 failed, and that one
(`doStockLeavesOnConfirm`) **fails identically on pristine `origin/main`** — it
was checked by reverting `mrp.ts` alone and re-running, not assumed. Typecheck
clean, `npm run lint` exit 0.

**One test fixture changed, deliberately.** `poSoCoverageReadShape`'s layer-(c)
SKU was a company-1 **bedframe** on an unlinked PO — the one shape that may no
longer float. It is now a mattress. Layer (c) is unchanged for every pooled
category and for a bound line covered by its own PO; the bound case became its
own test rather than disappearing.

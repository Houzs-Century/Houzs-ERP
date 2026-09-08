## The goods-receipt reshape money print compared two different populations two different ways, and blocked the cutover three times [high]

**Symptom.** `reshape-migrated-grns.mjs` ended every plan with one line:

```
MONEY — the migrated receipts hold RM 210513.43 today; this plan writes RM 461371.95.
```

A 119% jump with no explanation attached. The reshape was planned three times —
runs 34144660307, 34144939745 and 34165340307 — and applied **never**, because
no one could tell whether that number was a price correction or a double-count.
An agent that set out to prove it was killed by a network outage first. The
goods-receipt half of the AutoCount reconcile therefore stayed UNKNOWN, printing
`GR DATA (0 documents on both sides, 0 lines paired)`, for a full day.

**Root cause (traced).** The two figures are not comparable, in two independent
ways, and both were in the same `console.log`.

1. **Different populations.** `moneyBefore` sums `line_total_sen` over *all*
   migrated receipts — 320 documents. `moneyAfter` sums the plan's own rows over
   the *400 pair documents*. But 73 of those 320 are `untouched` (their purchase
   order is outside the book cut); they are in the "before" and they **survive**,
   so they are absent from the "after". Measured on the plan's own pre-write dump
   (artifact `migrated-grns-before-prod`, run 34165340307): those 73 carry
   **RM 124,729.00** — 59% of the entire "before" figure.

2. **Different formulas.** `moneyBefore` reads the `line_total_sen` column;
   `moneyAfter` computes `qty x unit_price - discount`. On production **276 of
   591** migrated receipt lines hold a real `unit_price_sen` and a
   `line_total_sen` of **0** (e.g. `CELENE (A)-(SK)` qty 1, price 122500, total
   0). Valued the way the "after" is valued, the same 591 lines are worth
   **RM 419,616.05**, not RM 210,513.43.

   Like for like — same documents, same formula — the 247 documents the plan
   actually replaces are worth **RM 249,691.95** today and become
   **RM 461,371.95**. The real change is +RM 211,680.00, not +RM 250,858.52, and
   RM 163,907.52 of the apparent "jump" was money the ERP **already held**.

**It was never a double-count, and the book proves it.** Two tests, both run
before anything was written:

- **Partition.** Each in-scope `GRDTL` row carries its own `FromDocNo`, so it
  lands on exactly one `(receipt x purchase order)` pair. Measured: **0 of 567**
  in-scope receipt-line keys appear in more than one pair. This is structurally
  unlike the `linked_ac_dtlkey` price repair of the same night, where one book
  key was claimed by six ERP rows and RM 2,216,501 of invented revenue was caught
  by a guard: there the key was the *purchase-order* line (one book line, one ERP
  row per sofa compartment); here it is the *receipt* line, which fans out only
  on the ERP side, under its own per-line price.
- **The ceiling.** AutoCount's own `GRDTL.SubTotal` for exactly those 400 pairs
  is **RM 574,763.43** (all 214 receipts MYR at rate 1, so no FX ambiguity; 0 of
  567 lines missing from the snapshot). The plan writes RM 461,371.95 — **RM
  113,391.48 BELOW** the book. A double-count cannot land under the book.

**A second, quieter defect found on the way.** `addCarry` reads
`l.discount_sen`, but the `grn_items` SELECT never fetched that column, so every
carried discount silently evaluated to zero. `scm.grn_items.discount_sen` exists
(migration `0305_money_centi_to_sen.sql:151` renamed it from `discount_centi`).

**Fix.** The MONEY section now states the **book's own total for the pairs it is
writing** and takes the headline apart: untouched-vs-replaced, `line_total_sen`
vs `qty x unit_price`, and the count of priced-but-zero-total lines. It prints an
explicit verdict, and where `moneyAfter` exceeds the book it says so in the words
that matter — *ABOVE THE BOOK IS A DOUBLE-COUNT SIGNATURE — DO NOT APPLY*. The
SELECT now fetches `discount_sen`.

`backend/scripts/audit-gr-reshape-money.mjs` is the same reconciliation offline:
no database, no network, no `node_modules`, so the book ceiling can be re-derived
from the committed extracts on a bare checkout. Run against the unfixed tree it
reproduces every number above, which is how they were proved rather than argued.

**The lesson.** A money delta between two states of *our own* system cannot
distinguish a correction from a double-count. Only the source book can, and a
migration script that moves money should print the book's figure beside its own —
otherwise the next reader has to rebuild the reconciliation from scratch, and
three of them did.

**Ref.** `fix/gr-reshape-money-audit`, 2026-09-08.

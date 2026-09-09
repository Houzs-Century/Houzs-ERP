## Repairing a line's quantity without its price moved one order further from the book [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `repair-so-qty-from-autocount` applied to production
(run `34134351163`) wrote the book's quantity onto 20 migrated sales-order
lines and re-summed each touched header. Nineteen landed on or kept the book's
total. **One went backwards.** From that run's own read-back:

```
HC-SO-004188  total RM 7988.00 -> RM 3344.00
              paid RM 7988.00 + balance RM 0.00 = RM 7988.00  <-- NO LONGER EQUALS THE TOTAL
```

AutoCount says this order is **RM 7,988.00**. Before the repair the ERP said
RM 6,688.00 — RM 1,300.00 out. After it, RM 3,344.00 — RM 4,644.00 out. The
repair was correct on its own terms and made the document less like the book.

**Root cause (traced, not guessed).** `SODTL` DtlKey 287817, read directly from
the live book over the tunnel:

```
SO-004188|287817|Qty=1.0000|UP=7988.0000|Sub=7988.00|hNet=7988.00
```

The ERP line held **qty 2 at RM 3,344.00**. Both numbers were wrong, and the two
errors were cancelling: 2 x 3,344 = 6,688 is much closer to 7,988 than either
factor is to its own truth. The quantity repair fixed one factor, so the
cancellation stopped and the remaining error was exposed at full size.

The same reconcile run that supplied the 22 quantity differences
(`34127889821`) had already listed this line under unit price —
`SO-004188 DtlKey 287817: AutoCount unit price RM 12,900.00 vs ERP ...` is the
neighbouring class, and 287817 is in it at `RM 7,988.00 vs RM 3,344.00`. The two
findings were treated as two work items when they are one fact about one line.

**This is not an argument against the quantity repair.** Leaving qty at 2 would
have left the ERP claiming two mattresses the customer did not order — a stock
and fulfilment error, not just a money one. The defect is that the repair was
scoped to one FIELD of a line rather than to the line.

**Fix.** `backend/scripts/repair-so-price-from-autocount.mjs` +
`.github/workflows/repair-so-price-from-autocount.yml` copy the book's
`UnitPrice` onto every migrated line whose DtlKey says it differs, re-derive
`total_sen` / `balance_sen`, and re-sum the header — the same shape as the
quantity repair, with two guards the quantity case did not need:

- **空白不覆盖.** Where the book states `0.00` and the ERP holds a real price,
  the ERP's value STANDS and the line is listed under HELD. The book holding
  zero is the book holding no price, not a price of zero. Copying there would
  destroy real data.
- **A currency guard.** A sales order not in MYR is skipped wholesale and named.
  Its amounts are not comparable to the ERP's, and reading one as a difference
  is exactly what took RM 13,068.55 off a live purchase order
  (`docs/bugs/0665`, `0666`). The book holds all 13,378 sales orders in MYR
  today, so this guard is expected to skip nothing — it exists so that stops
  being an assumption nobody re-checks.

**Lesson, and it generalises past this order.** A line's quantity and its price
are ONE fact. A sweep that repairs one field of a line against the book can move
the document further from the book, and the arithmetic that hides it —
two errors cancelling — is invisible at document level right up until you fix
half of it. **Where two fields of a row are both known to disagree, repair them
together or measure the document after each half.**

**Ref.** fix/ac-lines-match-2026-09-07, 2026-09-07.

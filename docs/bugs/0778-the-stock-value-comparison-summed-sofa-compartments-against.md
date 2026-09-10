## The stock value comparison summed sofa compartments against the book's whole sofas and reported the unit change as a difference [high]

**Symptom.** `check-stock-value-vs-autocount` was built to answer the one question
the owner's balance sheet turns on — does our stock value equal AutoCount's. It
answered:

```
AutoCount, comparable stock    7605u   RM 1485503.35
our system, comparable stock  10240u   RM 2107898.46
DIFFERENCE                    +2635u   RM  622395.11
```

and its biggest rows read `9028  13 vs 63 pcs  RM 1752.00 vs RM 68018.79`. That
was reported to the owner as a real gap, with a proposal to look at deleting the
excess stock.

The owner refused the premise in one line: 「我们那么多是因为 breakdown compartment
可是 costing 不应该原价算给全部啊 不是跟着之前的算法分摊嘛」, and then:
「然后库存之前不是tally了吗」. Both were right.

**Root cause (traced).** The book holds ONE row for a whole sofa; we hold one lot
per compartment. The script's `foldKey` mapped a compartment onto its model —

```js
const foldKey = (erp) => matchModel(erp) ?? norm(erp);
```

— so `9028-CNR`, `9028-1NA` and the rest all landed on the key `9028`, where the
book's single whole-sofa row was waiting. Their quantities were then SUMMED and
set beside a count of whole sofas. 63 compartments against 13 sofas is a unit
change, not a difference, and the same key put our split-allocated compartment
values beside a whole-sofa value.

The script's own output even printed `pcs` beside those rows and said only the
value was comparable — and then added the quantities into the headline anyway.
Labelling a number as incomparable does not stop it being added up.

**What the right tool already said.** `check-stock-vs-autocount`, which folds
with `foldSofaPieces` (each build counted by its SMALLEST surviving piece,
because a build missing a piece is not a sofa), production run 34444518133:

| axis | AutoCount | ERP |
|---|---|---|
| non-sofa cells | 959 compared, **917 agree, 42 differ** | value at risk across all disagreeing cells **RM 7,685.76** |
| non-sofa units | 9,830 | 9,731 (**−99**, and the sign is the other way) |
| whole sofas | 103 | 108 (**+5**, all builds missing at least one piece) |

So the stock was tallied, and the headline said it was out by 2,635 units.

**Fix.** Sofa is no longer mixed into the like-for-like total. `matchModel` is
used as a SOFA TEST rather than a key builder: a code it recognises goes to a
sofa block, everything else is compared under its own ERP code. The sofa block
counts whole sofas through `foldSofaPieces` and compares value only in TOTAL —
the book has no compartment codes, so there is no per-item comparison to make,
and the script now says so instead of inventing one. The non-sofa block is what a
balance sheet can use.

**Lesson.** The trap was not the fold; it was reporting a figure the script had
itself marked as not comparable. If a column cannot be subtracted, it must not
reach a total — a caveat in the output is not a guard, and the caveat was written
by the same hand that then ignored it.

**Ref.** fix/stock-value-sofa-apart, 2026-09-10.

## GR-005334 differs only in which duplicate line pairs with which, and that is unknowable [low]

**ACCEPTED BY THE OWNER, 2026-09-09. Do not re-chase it.** It is the last
goods receipt the PO/GR tally reports as differing, and the difference is not a
wrong value.

**Symptom.** The tally reports an `item code` difference:

```
GR-005334|PO-009887 DtlKey 917594: AutoCount "AK-IMMORTAL MATT (K)" vs ERP "AKEMI ULTIMATE MATT (K)"
GR-005334|PO-009887 DtlKey 917604: AutoCount "AK-ULTIMATE MATT (K)" vs ERP "AKEMI IMMORTAL MATT (K)"
```

Read as two lines holding each other's code. **They are not.**

**What the document actually holds**, both sides printed by
`probe-sofa-chain-both-sides` (run 34354521717):

| item | the book | the ERP |
|---|---|---|
| `AKEMI IMMORTAL MATT (K)` | 2 lines | 2 rows |
| `AKEMI ULTIMATE MATT (K)` | 2 lines | 2 rows |
| `HAPPI SLEEP SOLITUDE MATT (Q)` | 3 lines | 3 rows |

Same items, same quantities, same unit prices, header total `RM 13,777.00` on
both sides. **Nothing on this receipt is wrong.**

**Root cause (traced, not guessed).** Seven of our eleven rows carry NO AutoCount
line key (`dtlkey: null`), so the reconcile cannot pair by identity and falls
back to value — and the duplicates are identical by value. It picks one bijection
and the book's own numbering picked another.

`backfill-ac-downstream-line-keys.mjs` was run (DRY-RUN 34354759319) and refused,
correctly, naming the reason:

> `GR-005334|PO-009887: 7 line(s) left unkeyed — AKEMI IMMORTAL MATT (K): the
> book has 2 lines of this item at this quantity and they are NOT identical
> (2 distinct price/location/Desc2 combinations), and the build texts do not
> match one-to-one either, so which is which is unknowable`

The BOOK's two IMMORTAL lines differ — different location, different event
Desc2. OUR two rows carry no Desc2 at all. So the information that would decide
the pairing exists on one side only.

**Why this is not fixed by stamping a key anyway.** That guard exists because
this repo has already paid for exactly this class: `PO-009081` ordered two
identical bedframes, two receipts each took one, and a position-based pairing
paired them backwards (`docs/bugs/0690`). A key is IDENTITY — it decides which
book line a later edit rewrites — so an arbitrary assignment is only harmless
until somebody edits one of the rows.

**The owner's decision.** Given the choice between accepting it and telling us
which receipt was which event, he chose to accept: 「那就1」. The recommendation
put to him was the same — the content, the money and the stock are all correct,
and guessing a pairing risks more than it settles.

**What that means for the tally.** Goods receipts will keep reading
`1 of 400 document(s) still differ`. That one is this, and it is finished.

**Ref.** PR for `docs/gr-005334-accepted`, 2026-09-09.

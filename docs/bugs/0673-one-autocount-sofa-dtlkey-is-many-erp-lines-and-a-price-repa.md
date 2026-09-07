## One AutoCount sofa DtlKey is many ERP lines, and a price repair nearly wrote the sofa price onto every piece [high]

<!-- area: Cutover + migrated data -->

**Symptom.** `repair-so-price-from-autocount` — written to copy the book's unit
price onto migrated sales-order lines by DtlKey — was expected to touch about a
dozen lines. The reconcile that motivated it (run `34134741681`) reports the
honest count:

```
SO UNIT PRICE — the 13 difference(s), split by what each one IS:
  book holds NO price, ERP does: 1; both sides priced and they differ: 9;
  ERP dropped a price the book states: 3; export lost a price the book has: 0
```

Its first production DRY-RUN (run `34135702309`) instead proposed:

```
WRITE - the book states a price and ours differs: 441
order headers whose total MOVES: 302
net movement: RM 2216501.00
```

**Over two million ringgit of invented revenue**, and the shape gave it away
immediately — consecutive lines sharing one key:

```
HC-SO-000559 line 2 key=50890 558-CNR        RM 0.00 -> RM 9990.00
HC-SO-000559 line 3 key=50890 558-2A(RHF)    RM 0.00 -> RM 9990.00
```

**Root cause (traced, not guessed).** `linked_ac_dtlkey` is NOT unique on
`scm.mfg_sales_order_items`. A sofa is ONE `SODTL` row in AutoCount and one ERP
row **per compartment** — `CNR`, `2A(RHF)`, `1NA`, `Console` and so on — every
one of them carrying the same DtlKey. `import-ac-outstanding-so.mjs:294` puts
the document's price on the first piece and zero on the siblings:

```js
qty, up: first ? up : 0, lineTotal: first ? lineTotal : 0, ...
```

So the group already sums to the book's line total, and **the zeros are correct
by design, not missing data.** Counting ERP rows per key over the live table:
DtlKey 901904 is claimed by five, 870923 / 654987 / 639694 by four each.

The script joined book to ERP as if the relationship were one-to-one, so every
compartment matched the book's single price, every sibling's 0.00 read as a
difference, and the repair would have multiplied each decomposed sofa's value by
its piece count.

**Why the reconcile never showed this.** `check-ac-erp-reconcile.mjs` declares
the sofa split rather than counting it — `if (split || sofa) D.price++` — and
reports it separately as *"DECLARED, not counted as gaps: sofa-decomposed
documents"*. That is correct behaviour, and it is exactly why 13 was the number
to design against and 441 was never in any report. **A repair script cannot
inherit a checker's exclusions by being written after it.**

**Fix.** The script counts ERP rows per DtlKey before planning, and any key
claimed by more than one row is SKIPPED WHOLESALE and named in the log with its
piece count and item codes. Re-pricing a decomposed sofa is a decision about
which piece carries the money — that belongs to the sofa tooling that owns the
decomposition, not to a copy script.

**What actually caught it, and what did not.** Not the type checker, not the
linter, not release-discipline (the script passed all four of its rules — mode
gate, CONFIRM phrase, fresh-connection shape verify, re-run note), and not
review. **The DRY-RUN caught it**, because it prints the money it would move
before it moves any, and 441 lines / RM 2.2m against an expected 13 is not a
number anyone can read past. That is the entire argument for
plan-by-default-and-print-the-money, stated as a near miss rather than as a
principle.

**Ref.** fix/ac-lines-match-2026-09-07, 2026-09-07. Never applied; caught in
dry-run.

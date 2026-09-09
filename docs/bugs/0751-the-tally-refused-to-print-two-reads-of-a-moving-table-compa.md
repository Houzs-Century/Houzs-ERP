## The tally refused to print: two reads of a moving table compared to each other [high]

**Symptom.** The owner asked whether the documents tally and got no number at
all. `po-gr-tally-verdict.yml`
[run 34325417734](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34325417734)
exited 2 after printing every other section, on its very last check:

```
REFUSED: SO: the field query returned 15258 ERP lines but COUNT(*) says 15264.
The answer is being truncated; a count taken from a truncated read is a lie.
```

Nothing was truncated. The six missing lines had not been dropped — they had not
been BORN yet when the first of the two statements ran.

**Root cause (traced).** `loadErpFieldSide`
(`backend/scripts/lib/ac-field-identity-run.mjs`) fires **seven statements on
one autocommit connection**: six header/line reads, then three `COUNT(*)`s. The
SO line array is statement 2 and the SO count it is asserted against is
statement 7 — four more full-table reads later. On autocommit each statement
takes its **own** snapshot, so a lane inserting sales-order lines in that window
moves the count on a read that lost nothing. Several lanes were writing this
database that night.

The assertion itself is correct and was written for a real defect the day
before: a `LIMIT 500` on a sibling check had reported a drift of 842 as 500. It
was the two numbers' PROVENANCE that was wrong, not its logic.

**Fix.** The whole field read now runs inside one
`REPEATABLE READ READ ONLY` transaction, so the arrays and their counts describe
the same database at the same instant — and the verdict as a whole is one
coherent cut rather than seven. `READ ONLY` is the server's own refusal of a
write from a diagnostic.

**The assertion is NOT relaxed.** A `LIMIT`, a driver row cap or a partial
result is still short of `COUNT(*)` inside one snapshot, and still refuses;
`a genuine cap still disagrees inside one snapshot` in the suite below holds
exactly that, and passed on both the unfixed and the fixed tree.

Proved RED on the unfixed tree first. `tests-pg/fieldReadSnapshot.pg.test.ts`
runs the real reader against real Postgres and fires a **second connection**
between the arrays and the counts — the one instant no mock and no sleep can
schedule. On the commit carrying the test and the seam but NOT the transaction
(backend-postgres,
[run 34326680154](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34326680154)):

```
FAIL a write landing between the rows and the count cannot move the count
     AssertionError: expected 10 to be 16
FAIL the mode string really applied: repeatable read, and read only
     AssertionError: expected 'read committed' to be 'repeatable read'
```

`10` against `16` is `15258` against `15264` at fixture scale.

**Two traps this fix had to step around, both already in this ledger.**

- `columnsOf()` still runs BEFORE the transaction opens, never inside it. The
  pool is `max: 1`, and a helper reaching for the outer connection from inside
  `sql.begin` waits forever on the connection the transaction is holding — see
  `0749-a-helper-reaching-for-the-outer-connection-inside-a-transact.md`, which
  cost a silent hung production apply the same night.
- postgres.js strips the transaction-mode string with a regex before sending it,
  so a typo does not error — it silently gives a plain READ COMMITTED
  transaction that behaves exactly like the bug. The suite therefore asks
  `current_setting('transaction_isolation')` from INSIDE the reader's own block,
  so what is asserted is the string the production code ships.

**Ref.** `fix/tally-read-truncation`, PR #3416, 2026-09-09.

## The migrated-cancel exposure probe could never have answered: COALESCE on an enum column refuses at the database [high]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** `docs/bugs/0675-a-migrated-goods-receipt-cancelled-reversing-879-units-it-ne.md`
is a **[critical]** entry whose one open action is a read-only question: *did any
migrated document already have stock un-posted before the guard shipped?* It
names `.github/workflows/migrated-cancel-exposure.yml` as the instrument that
answers it. That workflow had **zero runs in its entire history** — so on
2026-09-08 it was dispatched (run
[34189305983](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34189305983),
13:05 local). It answered Q1, then **died on Q2 — the question that decides
whether stock is wrong**:

```
PostgresError: invalid input value for enum scm.inventory_movement_type: "?"
  code: '22P02', routine: 'enum_in', position: '39'
##[error]Process completed with exit code 1.
```

**Root cause (traced).** `scm.inventory_movements.movement_type` is an ENUM, and
both movement queries wrote `COALESCE(m.movement_type, '?')`
(`backend/scripts/check-migrated-cancel-exposure.mjs:106` and `:124`). COALESCE
requires one common type across its arguments, so Postgres tries to coerce the
literal `'?'` INTO `scm.inventory_movement_type` — and `'?'` is not a member.
The statement is rejected at parse time, before a single row is read.

**This is not a data-dependent failure. It could never have worked**, against any
database, on the first row or the millionth. The defensive `'?'` — there for a
NULL that a NOT NULL enum column cannot produce — is what refused the query.

**What it means, and this is the reusable half.** CLAUDE.md already carries the
rule that would have caught it: *"A `workflow_dispatch` workflow is not shipped
until it has been dispatched once and reported success."* This workflow was
merged, documented, cited by a [critical] ledger entry as the way to settle an
open question, and never once run. The entry then recorded the answer as
**UNKNOWN at the time of writing** — which was true, and stayed true, because the
instrument that was supposed to change it was broken on arrival and nothing said
so. It is *"the check that is not running"* from this repo's own list of traps,
with a [critical] finding behind it.

**Fix.** Cast the enum to text before COALESCE, at both sites:

```sql
COALESCE(m.movement_type::text, '?')
```

`::text` is the correct fix rather than dropping the COALESCE: the column is
NOT NULL on the table, but these are LEFT-joinable aggregates and the label is a
display bucket, so keeping the fallback costs nothing once the types agree. Both
occurrences were changed; a grep for `COALESCE\([a-z]+\.(movement_type|status|doc_type)[^:]`
across the file returns nothing further.

**What Q1 DID report before the crash**, which is the part worth keeping — read
off run 34189305983, company 1:

```
goods receipts (scm.grns, migrated_no_stock = true): 473
  by status: POSTED 473
delivery orders (scm.delivery_orders, migrated_no_stock = true): 173
  by status: DELIVERED 173
POPULATION — 473 migrated goods receipts (0 CANCELLED), 173 migrated delivery
orders (0 CANCELLED), company 1
```

**Zero cancelled documents in either population.** By the script's own decision
table that rules out the CANCEL path having fired at all — `cancelled > 0` is the
precondition for the paperwork-moved-stock-did-not case, and it is 0 of 473 and
0 of 173. It does **not** yet clear the delivery-order LINE-EDIT path, which
writes a movement without a cancel; that is exactly what Q2 measures, and Q2 is
what crashed.

**VERIFIED by re-running it, before merge.** Dispatched from the branch carrying
the fix — run
[34189651181](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34189651181),
2026-09-08 13:11 local, conclusion `success`. All six sections printed, and the
question the [critical] entry had been waiting on is now answered:

```
movements behind the 473 migrated goods receipts:   0 row(s), 0 units
movements behind the 173 migrated delivery orders:  0 row(s), 0 units
STOCK — CLEAN. 0 movement rows behind 646 migrated documents.
CANCEL audit rows on migrated documents: 0
EXPOSURE PREVENTED — cancelling every live migrated goods receipt would have
  written reversing OUTs for 1334 units; editing one line on every live migrated
  delivery order would have written OUTs for 1245 units.
```

**Nothing was written** — the run's own closing line is
`check-migrated-cancel-exposure: read-only, nothing was written.`

**Ref.** `fix/cutover-ledger-backlog`, 2026-09-08. CLOSES
`docs/bugs/0675-a-migrated-goods-receipt-cancelled-reversing-879-units-it-ne.md`,
which is `[critical]` and had been UNKNOWN since 2026-09-07.

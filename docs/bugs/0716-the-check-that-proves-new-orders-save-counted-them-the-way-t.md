## The check that proves new orders save counted them the way the bug counted them [medium]

**Symptom.** `docs/bugs/0703` was fixed and deployed on 2026-09-08, and the
verification for it still answered **`NEW orders saved in the last 24h (company
1): 0 — of 0 ERP-created orders in all`**. Run `34218306168`, production, taken
after the deploy that carried the fix. There was one ERP-created order in the
database at that moment and the check could not see it.

Worse in the other direction, in the same run: **`MIGRATED orders touched by a
PERSON in the last 24h: 13`** — an alarm — including `HC-SO-2609-001 CREATE by
Lim`, which is a salesperson creating a NEW order and is the outcome the whole
exercise was trying to produce.

**Root cause (traced).** Three scripts kept their own copy of the question the
fix had just changed:

```
backend/scripts/check-so-open-for-new.mjs:103   AND linked_ac_docno IS NULL
backend/scripts/check-so-open-for-new.mjs:170   AND so.linked_ac_docno IS NOT NULL
backend/scripts/set-migrated-so-lock.mjs        two count(*) subqueries, same column
backend/scripts/check-so-migrated-shape.mjs     the shape rule, re-expressed in SQL
```

`docs/bugs/0703` predicted exactly this and it was not acted on in the fixing
PR: *"It also blinds the verification: check-so-open-for-new.mjs counts new
orders as `linked_ac_docno IS NULL`, so a successful write-back deletes the
evidence that the lift worked."* The fix moved the predicate in
`backend/src`; the scripts that MEASURE the predicate were left behind, so the
gate said "staff still cannot save" about a system where they could.

The setter had the same shape one step less visibly: its plan output printed
`migrated=2883` for company 1 — the raw column count — when the value it was
planning could only ever shut 2,882. An operator-facing number that is wrong by
one is a number nobody can use to check anything.

And `check-so-migrated-shape.mjs` carried the rule a SECOND time, in SQL. A copy
of a rule inside the very check that exists to police that rule is the hardest
place for a drift to be noticed.

**Fix.** All three scripts import the rule from its one home,
`backend/src/scm/lib/so-is-migrated.ts`, and run under `npx tsx` for it. The
module gained `soNumberShape()` — the four-way classification (`no-book-number`
/ `equal` / `prefixed` / `neither`) — so the census can report the DISTRIBUTION
without re-deriving anything; `soIsMigratedShape()` is now defined in terms of
it, so the boolean and the census cannot disagree about a document.

The corpus is one company's sales-order headers — a few thousand rows, three
columns — so each check reads the pairs and classifies in JS. That is the only
arrangement in which a check is guaranteed to answer the same question the guard
answers.

`check-so-open-for-new.mjs` also prints the RAW column count alongside, labelled
as not being the predicate, because somebody will compare its output to the old
runs and the two differ by exactly the orders the write-back has sent.

Pinned by `backend/tests/soIsMigratedShape.test.ts`, which now also asserts that
`soIsMigratedShape` is derived from `soNumberShape` for every shape.

**Lesson.** A fix that changes a PREDICATE has to move every measurement of that
predicate in the same PR, or the gate keeps reporting the bug's own answer — and
a gate that reports the old answer is worse than no gate, because it is believed.
This repo's standing rule is *green is not evidence until you know the check ran,
and against what*; this is the same rule with "and against which definition"
added.

**Ref.** fix/so-new-counts-shape, 2026-09-08. Follows
`docs/bugs/0703-a-brand-new-sales-order-becomes-read-only-minutes-after-it-i.md`.

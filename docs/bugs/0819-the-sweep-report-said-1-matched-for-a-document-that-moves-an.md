## The sweep report said "1 matched" for a document that moves and one that does not [medium]

**Symptom.** With the declaration in place (`docs/bugs/0817`), the relink sweep's
report still read:

```
GR HC-GRN-2609-015: 2 keyless, 1 matched
```

— the same two words it printed before that fix, for a document that was now
about to be released. A run can match every line it is able to and still queue
nothing, so "matched" answers a question nobody was asking. The one a person
reads this report for is **does this document move**, and the report did not
carry it.

**Root cause.** `SweepDocResult` has held `enqueued` and `wouldEnqueue` all
along; `recordSweepRun` did not copy them into the stored summary, so the health
workflow had nothing to print. The same omission as `docs/bugs/0815`, one field
further in: the answer was computed and then dropped on the way to the reader.

**Fix.** Both flags are recorded, and the health line ends in a verdict —
`RELEASED` (apply), `WOULD BE RELEASED` (plan), or `still held`. A `plan` run now
answers the question before anything is written to the account book, which is
the whole point of having a plan mode.

**Tests.** Two in `autocountRelinkSweep.test.ts`, RED against the unfixed tree: a
document whose absent row can be declared records `wouldEnqueue` true and
`enqueued` false in plan; one that stays held records false.

**Ref.** 2026-09-11. Same family: `0815` (the sweep had no readable account of
itself at all), `0817` (what it now releases).

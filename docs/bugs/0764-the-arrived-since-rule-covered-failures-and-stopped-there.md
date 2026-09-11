## The arrived-since rule covered failures and stopped there [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The outbox health report told an operator to go and backfill a line
key on three documents whose keys are already there:

```
skipped 4: line identity missing — backfill linked_ac_dtlkey, then save again
```

Measured 2026-09-09 against production, `HC-SO-001180`, `HC-SO-001463` and
`HC-SO-001473` carry **zero** lines without a `linked_ac_dtlkey`. The advice was
stale, and following it would have sent somebody after nothing.

**Root cause — half a rule.** `docs/bugs/0743` taught this report that a refusal
older than the document's arrival is history. It applied that to rows with status
`failed` and stopped: a `skipped` row got no such treatment, so a skip the
account book has long since answered kept being counted and kept printing its
original remedy.

A skip is a refusal like any other. Nothing about the reasoning was specific to
`failed`; the implementation simply did not reach the other branch.

**Fix.** The same function, over both populations. `supersededFailureKeys` now
decides skips too, and the answered ones print under their own heading —
`SKIPPED — ARRIVED SINCE` — beside the failures'.

**And the trap inside the fix, which is the part worth reading.** The arrivals
were read for the FAILED documents' numbers only. Widening the rule without
widening that read would have left `arrivedAt.get()` undefined for every skip;
`acRefusalPredatesArrival` answers **false** on an undefined arrival, so nothing
would have been discounted — and the code would have looked completely correct.
A half-widened rule reads exactly like a working one. The arrivals are now read
for every document carrying an outstanding refusal of either kind, and a test
pins the failure mode: an empty arrivals map must discount NOTHING.

**Verified.**

* `acFailedSuperseded.test.ts` — **13 tests**, two of them new: a skip is
  discounted by the same rule and the same function as a failure; and an
  arrivals map that never learned the document discounts nothing.
* The skipped query now carries `created_at`, without which the rule has nothing
  to compare.
* `node --check` clean; the script loads under tsx.

**UNTESTED against production** — the workflow has not been dispatched under this
build, so the count those three documents now produce is not yet observed.

**Ref.** fix/the-arrived-rule-covers-skips-too, 2026-09-09.

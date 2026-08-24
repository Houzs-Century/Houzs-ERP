## #2220 fixed the rows and left the tiles saying the opposite [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The same self-contradiction #2220 was opened for, one component
further up. For two `failed` rows carrying a re-queue marker, `/autocount-sync`
now renders both rows as **Re-queued** — and the headline above them still reads
*"2 documents need attention (2 failed) — in the ERP and not in AutoCount"*, the
Failed tile still reads **2**, the Re-queued tile reads **0**, and the Re-queued
filter returns nothing.

**Root cause, traced.** #2220 taught `acOutboxState` that a re-queue marker
counts on either terminal state. That function decides the per-ROW rendering and
the JS narrowing. It does not decide the COUNTS: those are five separate
company-scoped SQL head-counts inside `routes/autocount-outbox.ts`, which kept
their own skipped-only rule —

```
countRows(c, (q) => q.eq('status', 'skipped').like('last_error', REQUEUED_LIKE))
```

— so `failed` was counted raw, `requeued` counted only skips, and
`attention = nFailed + nSkipped` inherited both. `statusesFor.requeued` was
`['skipped']` for the same reason, which is why the filter came back empty.

**PROVEN, not inferred.** A probe against the route on `main` (`c464bd386`) with
exactly two re-queued failed rows returned
`counts {"pending":0,"sent":0,"failed":2,"skipped":0,"requeued":0,"attention":2}`,
row states `[["requeued",false],["requeued",false]]`, and `?state=requeued` → `[]`.
The four new tests fail against that tree and pass against this one.

**Fix.** The marker is honoured per terminal state in SQL too: count re-queued
failures and re-queued skips separately, subtract each from its own total, and
sum them for the Re-queued tile. `statusesFor.requeued` takes both statuses and
`state=failed` narrows out re-queued rows the way `state=skipped` already did.
`total` switched to the TERMINAL counts — it had been reading the outstanding
failed count, which would have made re-queued rows vanish from the total while
still being listed under it.

**Why the first fix stopped where it did.** #2220 changed the shared taxonomy
and the canonical mirror, which is where the rule belongs — but the route had a
SECOND copy of the same rule expressed in PostgREST predicates, and no test
covered a re-queued failed row's COUNTS. The page's own tests all asserted rows.

**A THIRD copy, found by looking for it.** `check-autocount-outbox-health.mjs`
— the workflow the owner was told to run before the page existed, and still the
headless reader — selects `WHERE status = 'failed'` and prints the result under
*"each is a document that is in the ERP and NOT in AutoCount"*. It had the same
bug, and it is the same false statement about a live account book. Fixed in the
same PR: the totals query counts the re-queued rows per status with a `FILTER`,
the failed detail query excludes them, and they are reported under RE-QUEUED
with the skips. Not found by a test — found by grepping for every place the rule
is expressed after the first two disagreed.

**Ref.** 2026-08-15. Lesson: **a rule expressed twice in two languages is two
rules** — and it was expressed three times here. The taxonomy module, the route's
PostgREST predicates and the health script's SQL all encoded "re-queued means
history"; #2220 fixed the one written in TypeScript, and both of the ones written
as queries went on disagreeing with it. When a fix lands in a shared module, grep
for the rule's other spellings before calling it done.

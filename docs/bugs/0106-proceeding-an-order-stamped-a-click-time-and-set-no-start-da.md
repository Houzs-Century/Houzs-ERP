## Proceeding an order stamped a click time and set no start date, so an order could be in production with no day the factory starts [high]

**Symptom** - an order could reach IN_PRODUCTION carrying `proceeded_at` and a
NULL `internal_expected_dd`. The owner's rule says that state cannot exist:
*"只要有 Processing Date，就代表他 Proceed 了。Proceed 的日期是他填入 Processing
Date 的日期。没有 processing date 就代表没有 proceed。"* Production queues by the
Processing Date, so such an order is proceeded and in no queue.

**Root cause** - every proceed path wrote the wrong column. `PATCH
/:docNo/status` -> IN_PRODUCTION set `patch.proceeded_at = new Date()` and no
date; CREATE auto-proceed did the same (`proceeded_at: autoProceed ? ... :
null`) for any complete, deposit-paid handover that carried no Processing Date;
`PATCH /:docNo` `proceededAt` gated the proceed but never asked for a date.
Proceed was modelled as an event with a timestamp when it is a STATE - having a
date. Same era, same file: the deposit for that one act had two predicates,
`meetsProceedGate`'s inline ratio and `meetsProcessingDatePaymentGate`. They
agreed only because a previous PR had walked both onto
`processingDateThresholdFor`; before that they were two thresholds, and a 2990
order was refused at the Houzs 30% (2026-07-31).

**Fix** - proceeding RESOLVES a Processing Date and writes it
(`resolveProceedProcessingDate`, `order-rules`): the order's own date if it has
one, else a date on the request, else a 422 `proceed_needs_processing_date`. No
path defaults to today - a guessed start date is a real order in the real queue
on the wrong day, with nothing to show it was guessed. A date the status route
writes clears the FULL Processing-Date gate table, read live off the row, so the
proceed route cannot become the way around it. A create with no date now yields
an UN-proceeded order rather than a dateless proceeded one. The two deposit
predicates collapsed into `meetsDepositGate`, which both the Proceed gate and the
aggregated save report read; a test asserts the report refuses exactly when the
gate does. `proceeded_at` is still written and still read - the stock allocator
sorts by it - it is simply no longer what makes an order proceeded.

**Lesson** - **when a state has a defining field, do not also record the moment
someone claimed the state.** Two markers for one fact drift the moment any path
writes one and forgets the other, and the half-written row looks valid to every
reader that checks only its own marker.

**Ref** - PR (branch `proceed-is-the-date`), 2026-08-13.

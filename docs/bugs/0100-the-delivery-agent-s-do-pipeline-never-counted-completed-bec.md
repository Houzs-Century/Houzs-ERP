## The delivery agent's DO pipeline never counted COMPLETED, because it kept its own copy of the status list [med]

**Symptom** - the Delivery Agent brief's `doPipeline.byStatus` reported every
delivery-order bucket except COMPLETED. Nothing errored; the bucket was simply
absent, which reads identically to "there are none".

**Root cause (traced)** - `services/agents/delivery-agent.ts:539` declared its
own `DO_STATUSES` with the comment "the DO lifecycle (delivery-orders-mfg.ts
state machine)" and eight values. The state machine it names has NINE
(`delivery-orders-mfg.ts`, the `PATCH /:id/status` guard): the copy had lost
COMPLETED. `collectDoStatusCounts` issues one count per member of that list, so
a status missing from the list is a status never queried.

Found while sweeping the duplicated-constant-list class, and it is that class
exactly: two declarations of one fact, one of which is the authority and one of
which nobody re-checked. The same sweep found the DO "has shipped" set written
out by hand in ELEVEN files across two different spellings - five states, and the
same five plus COMPLETED - which is how `check-stock-truth.mjs` came to measure
delivered COGS over a set that excludes completed deliveries while
`check-doc-line-vs-movement.mjs` measures lines-vs-movements over one that
includes them, with neither output mentioning the difference.

**Fix** - `backend/src/scm/shared/do-shipped-states.ts` is now the only
declaration: `DO_SHIPPED_STATES` (the write trigger, COMPLETED deliberately
absent - nothing ships INTO completion, so listing it would arm a second
deduction on that hop), `DO_STOCK_OUT_STATES` (the read predicate, = shipped +
COMPLETED), `DO_PRESHIP_STATES` and `DO_STATUSES`. `delivery-orders-mfg.ts`,
`consignment-notes.ts`, `lib/reconcile-ledger.ts` and `delivery-agent.ts` import
it; the seven `.mjs` audits import `scripts/lib/do-shipped-states.mjs`, pinned to
the TS file by `tests/doShippedStatesMirror.test.ts` the way
`phoneNormaliseMirror` and `variantAxesMirror` pin theirs. The agent's pipeline
gains its COMPLETED bucket; every other call site keeps the exact list it had.

**Left, deliberately, for the owner** - `lib/reconcile-ledger.ts` scans the
5-state set, so a COMPLETED delivery order whose OUT never landed is invisible
to the ledger-integrity sweep. Widening it to `DO_STOCK_OUT_STATES` would change
what System Health reports, which is not a change to make while collapsing a
duplicated list. Noted in the code at the constant.

**Lesson** - **a comment naming the file it copied from is not a link to it.**
Both drifted copies said, in words, where the truth lived; neither could notice
when the truth moved. Import it, or pin it with a test - a citation is not a
mechanism.

**Ref** - PR sweep/duplicated-list-drift, 2026-08-13.

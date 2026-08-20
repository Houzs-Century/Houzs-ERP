## Proceed wrote a column migration 0286 had renamed away, and three write paths never asked the both-dates rule [high]

**Symptom** — two faults on the same rule, found together while auditing every
write path that can set or clear the Processing Date.

1. Moving an SO to IN_PRODUCTION could not write the date it was proceeding
   with. `PATCH /:docNo/status` SELECTed `internal_expected_dd`, compared it,
   and assigned `patch.internal_expected_dd` — a column that stopped existing
   when mig 0286 renamed it to `processing_date`. The header PATCH's proceed
   branch read the same dead name through `effOf('internal_expected_dd')`, which
   resolves `undefined` for every order, so that path returned
   `proceed_needs_processing_date` unconditionally. SIX literals in all, the
   sixth quieter than the rest: the create's auto-proceed read
   `body.internalExpectedDd`, a PAYLOAD key no client sends, so `autoProceed`
   was always false and an order created WITH a Processing Date was created
   UN-proceeded — the exact inverse of the owner's pinned rule, with nothing
   anywhere saying so. (The six were catalogued independently by #2149's
   documentation audit while this fix was being written; that audit's CORRECTION
   box is now the RESOLVED box in `docs/modules/sales-order.md`.)
2. Three write paths could store exactly one of the two dates: the CO header
   PATCH, the amendment APPROVE path, and the `/status` proceed. The owner's
   rule is *"processing date 和 delivery date 必须同时有或者同时没有"*.

**Root cause, traced not guessed** — the rule was never in one place. It was
hand-written in FIVE files (SO create, SO header PATCH, CO create, amendment
submit, and one direction inside `so-save-problems`) and absent from three. Five
copies is also why the two directions disagreed: `so-save-problems` asked
delivery→processing under `processing_delivery_must_pair`, while
processing→delivery lived in the completeness block behind
`if (facts.procDate && facts.completeness)` — and neither consignment path
passes `completeness`, so on a CO a Processing Date with no Delivery Date raised
nothing at all. `so-save-problems.ts` said as much in a comment ("the CO header
PATCH runs no pair check of its own") and the comment was correct.

The dead column is the same class one layer down. Mig 0286's own header warns
that `jsonb_populate_record` IGNORES a JSON key that is not a column, so a stale
caller "would not error — the date would just stop saving", and says "the
callers are renamed in this same commit". The `/status` block was not. Nothing
the compiler sees can catch a column name that lives inside a string, so it
built, typechecked and shipped. `routes/so-amendments.ts` had the matching
shape: it IMPORTED `canonicaliseSoHeaderChanges` and never called it, so its
approve-time gates read the raw stored jsonb while `so-revision.ts` (which
applies the change) reads the canonical one — an amendment stored under the
pre-rename payload key walked past the deposit, completeness and date gates and
was applied anyway.

**Fix** — one predicate, `soDatePairRefusal` in
`backend/src/scm/shared/so-processing-date.ts`, called by every path that can set
or clear either date: SO create, SO header PATCH, SO `/status` proceed, amendment
submit, amendment approve, CO create, CO header PATCH, the aggregated
`so-save-problems` report (both directions now), and `unify-processing-date.mjs`,
whose single-column UPDATE now re-asserts `customer_delivery_date IS NOT NULL`
and refuses the transaction rather than writing half a pair. Grandfathering — a
stored unpaired pair the save leaves untouched — moved INSIDE the predicate, so
no caller re-derives it. Clearing the Processing Date now clears the Delivery
Date with it (header and every `line_delivery_date`, via
`p_apply_delivery_date`); the reverse stays a refusal, because cascading it would
clear the Processing Date and become the road around
`scm.so.remove_processing_date`. The `/status` and header-PATCH reads are bound
to `SO_PROCESSING_DATE_COLUMN`; the two request-body reads go through a new
`readSoProcessingDateFromBody`, which takes the canonical `processingDate` and
still accepts the legacy spelling; and `so-amendments.ts` now actually calls the
canonicaliser it imported. The 2990 mirror is the ONE deliberate exclusion — it
replicates rows 2990 already committed, and a refusal there wedges its outbox
retrying forever — and the route now says so in a comment the test asserts.

**Why the test is a source scan.** `tests/soDatePairWiring.test.ts` anchors on
each path's source, with comments stripped, and fails if one stops calling the
predicate; it also fails on any live mention of `internal_expected_dd`. Eleven of
its fifteen assertions fail against the tree this PR branched from. A unit test
over the predicate would have passed throughout the entire bug: the logic was
never wrong, the enumeration was.

**Ref** — 2026-08-14, this PR. Related: **BUG CLASS optional-param-noop** below
(same shape, different mechanism: there the compiler was silenced by `?`, here by
the value being a string).

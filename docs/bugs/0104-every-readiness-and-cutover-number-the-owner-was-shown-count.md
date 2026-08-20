## Every readiness and cutover number the owner was shown counted a different population than the screens he compared them against [medium]

**Symptom** - the ops scripts and the app disagreed about which orders are
"processed". Nothing threw; the numbers were simply about a different set of
orders than the ones on screen, and the gap widened the moment the Processing
Date moved.

**Root cause** - "has a Processing Date" had two storages and the two halves of
the system picked different ones. Every screen reads
`scm.mfg_sales_orders.internal_expected_dd` - it is what the UI writes, what
`soProcessingLocked` reads (`mfg-sales-orders.ts`) and what MRP reads
(`mrp.ts`). Ten `backend/scripts/` diagnostics instead asked
`proceeded_at IS NOT NULL`, and `proceeded_at` is stamped only at the
IN_PRODUCTION transition, so it always named a NARROWER set. `unify-processing-date.mjs`
then migrated 519 company-1 orders' dates into `internal_expected_dd` on
2026-08-13, leaving both companies at zero split - which made the scripts
authoritative-looking and wrong at the same time, because the proceed rule the
owner keeps restating ("只要有 Processing Date，就代表他 Proceed 了") is now
answered by a column none of them read.

**Fix** - re-pointed the ten diagnostics that were asking "does this order have
a Processing Date". Deliberately NOT re-pointed, because they are asking a
different question and are named as such in the code: the three allocator
explainers (`check-status-disagreement-why`, `check-bedframe-sofa-status-truth`,
`check-stock-vs-autocount`) and section 7 of `check-cutover-metrics`, all of
which reproduce the gate `so-stock-allocation.ts` actually applies - and that
allocator still gates on `proceeded_at`. They must move in the SAME change that
moves it, or they stop describing production. `check-migration-fidelity` also
stays: it verifies what the IMPORTER transcribed into `proceeded_at`, not
whether an order is proceeded.

**Lesson** - **when one fact gets a second storage, the diagnostics are the last
place anyone looks and the first place the split becomes invisible.** A readiness
report has no test and no user to notice it is off; it just prints a smaller
number with the same confidence. The tell was already in the tree - the app's
own comment at `mfg-sales-orders.ts:455` says the lock stopped requiring
`proceeded_at` "because that is stamped only at the IN_PRODUCTION transition" -
and no sweep carried that same reasoning across to the scripts.

**Ref** - `fix/proceeded-at-diagnostics`, 2026-08-13

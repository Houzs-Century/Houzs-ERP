## The word "processingDate" meant three different facts in the scan payloads, and an audit had already been fooled by it [medium]

**Symptom** - no runtime failure. The damage shows up as repeated bugs around
the Sales Order's Processing Date, and as documentation that confidently
describes the wrong thing: `docs/ocr-prompt-audit.md` C-2 stated that "scan-so
never reads a receipt's `paidAt`/swipe date", which was false when written.
scan-so has always read each receipt's printed transaction date; it just called
that field `processingDate`, so it did not read as a receipt date to the person
auditing it.

**Root cause** - one word, three unrelated facts, all reachable from the same
scan payload:

1. `ExtractedSlip.processingDate` - the HANDWRITTEN SLIP'S OWN DATE (the day the
   rep wrote the order). Read by the duplicate probe as `slipDate`, a local
   variable that already used the honest name.
2. `ExtractedPayment.processingDate` - a CARD TERMINAL'S PRINTED TRANSACTION
   DATE, coalesced in `planReceiptPayments` and clamped by `resolvePaidAt` into
   the payment-ledger row's `paid_at`. This one moves money to a date.
3. `processingDate` proper - the Sales Order's Processing Date,
   `scm.mfg_sales_orders.internal_expected_dd`, the factory-start date.

Nothing in the types, the prompt or the docs distinguished them, so the next
person picks whichever one autocomplete offers.

**Fix** - (1) is now `slipDate` and (2) is now `receiptTxnDate`, across the
Claude vision prompt (extraction rule 6, the `payments[]` rule, both OUTPUT
schema blocks), the `ExtractedSlip` / `ExtractedPayment` types, `normalizeSlip`,
the duplicate probe, `PlanReceiptPaymentsInput.slipProcessingDate` →
`slipDate`, the planner's `paidAt` resolution, the two tests, and the frontend
types the wire shape flows into (`ScanOrderModal`'s `ExtractedSlip` /
`ScanPrefill`, `ReconciledPrefill`, `MobileScanPrefill`). Only the third fact is
still called `processingDate`. `CARRIED_NOT_INVERTED` carries `'slipDate'`, and
its test now also asserts `'processingDate'` is NOT in the array, so the entry
cannot silently drift back to the overloaded name.

**Back-compat** - stored `so_scan_samples.extracted` / `corrected` blobs still
carry the old key, and the few-shot pool feeds those blobs into the prompt
verbatim, so the model can echo `processingDate` back. `normalizeSlip` reads
`slipDate ?? processingDate` and `receiptTxnDate ?? processingDate`. Without
that, a scan whose example pool predates the rename would lose its receipt date
and book `paid_at` at today.

**Deliberately NOT done** - no value was moved. The rename exposed a real
two-surfaces-one-field divergence, left exactly as it was with comments saying
so: `MobileNewSO` seeds the SO's Processing Date from `slipDate` (the day the
rep WROTE the slip), while desktop derives it from Delivery − 6 weeks and never
reads the slip's date. Both then invert the SO's Processing Date back into the
slip's `slipDate` when building a `corrected` blob. **All of it is latent, not
live:** `MobileNewSO`'s `scanPrefill` prop is never supplied by any
`setScreen({t:"new-so"})` call site (the live mobile path,
`createDraftFromPrefill`, sends `internalExpectedDd: null`), desktop's
`soScanPrefill` handoff has a reader and no writer, and the `corrected` blob is
inert because `slipDate` is in `CARRIED_NOT_INVERTED`. It fires the moment
someone re-wires either handoff - which this module has done before. Written up
in `docs/modules/scan-to-so.md` §2b rather than fixed inside a rename.

**Lesson** - **a name that fits three facts will eventually be read as the wrong
one, and the first casualty is the documentation, not the code.** The audit
entry that got this wrong was written by someone reading the prompt carefully;
the name defeated them. Renaming is not cosmetic when the old name is what makes
a reviewer stop looking.

**Ref:** `pd/overloaded-names`, 2026-08-13. Naming only - no behaviour change,
no migration, no API path change. **NOT verified:** no real slip was
round-tripped through a live model, so the vision model's compliance with the
renamed OUTPUT keys is reasoned from the prompt, not observed.

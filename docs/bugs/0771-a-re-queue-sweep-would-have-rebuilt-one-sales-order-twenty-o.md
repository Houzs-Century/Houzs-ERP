## A re-queue sweep would have rebuilt one sales order twenty-one times [high]

**Symptom.** `HC-SO-012312` could not reach AutoCount: three of its lines carried
a Description 2 over the account book's 100 characters, and every save while that
was true left another refused row in `scm.autocount_outbox` — twenty-one of them.
Once #3485 taught the composer to abbreviate on the way out, the re-queue sweep
was run in DRY RUN against production (run `34393385833`) and answered
**`21 row(s) examined — would-requeue 21`** for what is ONE sales order. APPLY
would have queued twenty-one rebuilds of it.

That is not twenty-one wasted rows. A rebuild clears the document's details in
the live licensed account book and lays the ERP's lines down again, destroying
and reissuing every `DtlKey` on it, and each one is a separate `InternalSave`
over the ZeroTier tunnel to the office PC — where heavy AutoCount work is already
known to starve the write-back and surface as a lock timeout that reads exactly
like a permissions refusal, which is why the line-order sweep is a button and not
a page-load (`frontend/src/lib/acLineOrderSweep.ts`).

**Root cause (traced).** The CREATE path has asked "is there already a live row
for this document" since it was written — `existingCreateRow`, consulted at
`autocount-requeue.ts`'s create rung. The EDIT path never did.
`editRebuildVerdict` went straight to `enqueueEdit`, and `enqueueEdit` writes its
row with `dedupeKey: null` on purpose ("two successive saves are two different
intents and must both be applied"), which is right for a save and wrong for a
re-queue: a rebuild is not a delta. It lays down the ERP's lines AS THEY STAND,
so the first one already carries what all twenty-one saves added up to.

Traced by reading the two rungs against each other after the dry run's own count
contradicted the document count — one document, twenty-one "would-requeue".

**Fix.** Two guards, because one of them cannot answer during a dry run.

1. `pendingRowForDocument` — a PENDING row for this document (any op) refuses the
   rebuild with `already-queued`. Pending only, never `sent`: a document the
   write-back has succeeded on carries a `sent` edit row for every save it ever
   made, and vetoing on those would refuse every document that has ever worked.
2. `REQUEUE_PUTS_IT_ON_ITS_WAY` plus a per-document set in `requeueSkipped`'s
   loop — so the DRY RUN predicts the one send APPLY will make. A dry run writes
   no pending row, so guard 1 is blind to it, and this module's own promise is
   that a dry run "can only disagree with APPLY about whether the row lands".

Six tests in `backend/src/scm/lib/autocount-requeue-edit-rebuild.test.ts`, and
they were **proved RED on the unfixed tree**: with both guards short-circuited,
four of them fail (`Tests 4 failed | 11 passed`), including the one that counts
the QUEUE rather than the verdict. Green with the fix: `Tests 88 passed (88)`
across both requeue suites.

**Ref.** `fix/requeue-one-rebuild-per-document`, 2026-09-09.

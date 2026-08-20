## The ERP composed an AutoCount edit that would append duplicate lines, and its own refusal would have been invisible [critical]

**Symptom** - none observed: the write-back has never been switched on. Had it
been, editing any sales order or purchase order would have appended a second
copy of every untouched line into the live AED_HOUZS book.

**Root cause (traced, not guessed)** - `composeEdit` emitted a line with no
`DtlKey` whenever `linked_ac_dtlkey` was NULL, and AcSyncService's `/edit` read
a keyless line as "genuinely new" and called `AddDetail()`. The reading is only
sound if keyless means new. It did not: the create routes returned the DocNo
alone and never the created DtlKeys, so every ERP-created document had NULL line
identity forever, and the cutover-migrated documents were never backfilled.
Measured on production 2026-08-11 from a read, BEFORE the backfill: **0 of
13,907** SO lines and **0 of 864** PO lines on AutoCount-linked documents
carried a key. The PR's own tests asserted the appending behaviour as correct.

**Fix** - `composeEdit` now throws `KeylessLineError` when ANY line lacks a
usable DtlKey, refusing the whole edit; `enqueueEdit` records it as a `skipped`
outbox row reading `refused, nothing sent: ...` and naming the offending line.
Widening `noteReadFailure` to carry that second error type was load-bearing, not
tidying: it only handled `AcReadError`, so without it the refusal would have
been swallowed by the catch and returned false - a write-back that silently
declines to sync is indistinguishable from one that has quietly broken.

Two follow-on findings, both caught by tests rather than by reasoning:

- composing the edit EAGERLY broke a legitimate path. When a document's create
  is still unsent in the outbox, an edit replaces that create's payload instead
  of queueing an edit - and a document that has never reached AutoCount cannot
  have line keys yet, so the refusal fired on a case that was always fine.
  `composeSoState` / `composePoState` now return the edit as a thunk.
- create and convert responses now carry `lines: [{Seq, DtlKey, ItemCode,
  Desc2}]` and `persistLineKeys` stores them, but it VERIFIES the index-zip by
  count and ItemCode first and writes nothing if either disagrees. A wrong
  DtlKey is worse than none: a missing key is refused loudly by the new guard, a
  wrong one silently edits a different line in a live account book.

**Ref** - 2026-08-11, PR #1936 (feat/ac-erp-line-identity). C# half in #1935.

## Three documents were in the account book and the ERP still offered to send them again [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On 2026-08-17 ~01:00 MYT three documents were written into the
production AutoCount book `AED_HOUZS` by calling `AcSyncService` DIRECTLY on the
shop-floor host, bypassing the outbox drain. Read back out of the book by direct
SQL the same night: `DO HC-DO-2608-001` (from `HC-SO-2608-003`), `DO
HC-DO-2608-002` (from `HC-SO-2608-002`) and `IV HC-SI-2608-001` (from
`HC-DO-2608-002`), all `300-C002`, all `Cancelled=F`, two lines of Qty 1.0 each,
with `TransferedQty = 1.0` now on seq 16 and 32 of both sales orders. The ERP
knew none of it: the two delivery orders were still `failed` in
`scm.autocount_outbox` (6/6 attempts, `Invalid transfer item.`), the invoice was
still `skipped`, and no ERP document carried a `linked_ac_docno`.

**Root cause of the RISK — traced through the ladder, not guessed.** The
mismatch was not cosmetic. `status` was the only thing between those rows and a
second copy of a live accounting document, and on the two delivery orders it was
the wrong value:

- `acRowIsRequeueable` (`scm/lib/autocount-outbox-status.ts:399`) returns
  `state === 'failed'` for a transfer op, so the AutoCount Sync page put a live
  **Send again** button on both delivery-order rows, desktop and mobile.
- `requeueOutboxRow` refuses `sent` and refuses `pending`; a `failed` row falls
  through to `requeueOneRow` with `resendingThisRow: true`.
- `transferVerdict` then re-sends a transfer when `status = 'failed'` AND the
  payload is composed AND the ERP document carries no `linked_ac_docno`. All
  three held. Its duplicate guard reads exactly the column that was null.

So the window was **open from the moment #2330 relaxed the transfer rule** (a
`failed` transfer became re-sendable, correctly — it is the shape a rebuilt host
fixes) **until this repair ran**. #2330 is not the bug; the bug is that a
hand-made send left the recorded state saying "the service refused this", which
is precisely the state #2330 made re-sendable. The invoice was never exposed:
`skipped` fails `transferVerdict`'s first fact and comes back `not-recoverable`.

**Fix.** `backend/scripts/repair-outbox-sent-by-hand.mjs` +
`.github/workflows/repair-outbox-sent-by-hand.yml` — mark the three outbox rows
`sent` with their `ac_doc_no`, and write `linked_ac_docno` onto the three ERP
documents. That closes the window twice over and independently: `sent` is
refused at `requeueOneRow`'s first rung, which has no exception, and a non-null
`linked_ac_docno` is refused at `transferVerdict`'s own guard. The three
document numbers are hard-coded and `DOC` can only narrow to one of them; a
repair that could mark an arbitrary document `sent` would be a worse hazard than
the one it fixes, because `sent` is the state that makes the ERP stop asking.
The script refuses and exits 3 rather than guessing when it finds a row already
`sent` without its own marker, or any `pending` row for the three.

**What it deliberately does NOT do.** It cannot see the account book, and it
says so in its own output rather than only in a comment: it asserts that the ERP
now claims what a human measured in `AED_HOUZS`, nothing more. It also does not
store the lines' AutoCount DtlKeys — the service was never asked, so they do not
exist on this side — which means `composeEdit` will refuse an edit of these
three until somebody backfills the keys from the book. A refused edit is the
safe direction; a wrong DtlKey silently rewrites a different line in a live book.

**Ref.** PR #2343, 2026-08-17.

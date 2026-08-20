## A purchase order that landed in AutoCount under AutoCount's own number could not be sent again by ANY path [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-PO-2608-001` reached the live book as `PO-009968`. #2365 fixed
the cause — the SO-to-PO transfer arm built the body with `composeCreatePo` and
then threw it away, so no `DocNo` went with the transfer and AutoCount named the
document itself. `PO-009968` was then cancelled in `AED_HOUZS` with the owner's
explicit approval (`POST /cancel {"DocType":"PO","DocNo":"PO-009968"}` ->
`{"ok":true}`; `SELECT DocNo, Cancelled FROM PO WHERE DocNo='PO-009968'` ->
`Cancelled = T`; nothing downstream, `TransferedQty = 0` on both lines). The ERP
still recorded the order as being in AutoCount, and re-sending it turned out to
be impossible through every tool that exists.

**Root cause (traced through the three guards, not guessed).**
`purchase_orders.linked_ac_docno` still held `PO-009968`, and the three paths
that could re-send all read it:

- `enqueuePoCreate` (`scm/lib/autocount-outbox.ts:752`) —
  `if (header.linked_ac_docno) return false;`
- `enqueueEdit` (`:1441`) — `if (!composed.linkedAcDocNo) return false;`, so
  CLEARING the column does not make an ERP-side save re-send it either. An edit
  of an unlinked document is a silent no-op.
- `requeueOneRow` (`scm/lib/autocount-requeue.ts:703`) refuses a `sent` row
  outright, and `requeueSkipped`'s select is `.in('status',
  ['skipped','failed'])` — it can never return one. So the "re-queue a refused
  document" workflow reports nothing to do for a document that WAS sent.

`PATCH /:id/confirm` is the fourth door and it short-circuits on an
already-`SUBMITTED` PO before it reaches `enqueuePoCreate`. All four guards are
correct: each of them exists to stop a SECOND copy of a document reaching a
licensed account book, where an accepted document cannot simply be deleted. What
was missing was any way to express the one case where a re-send IS right — the
counterpart was cancelled by a human.

**Fix.** `backend/scripts/reraise-hc-po-2608-001.mjs` +
`.github/workflows/reraise-hc-po-2608-001.yml`. Scoped to ONE document by
constant (a `DOC_NO` that is not `HC-PO-2608-001` exits 2), and the `UPDATE`
carries `AND linked_ac_docno = 'PO-009968'` so the only value it can erase is
the one it was told about. Any other value stops the run. It clears the link and
then calls the REAL `enqueuePoCreate` — imported from `src/` and driven through
`scripts/lib/pgrest-shim.mjs`, never re-implemented — because clearing alone
leaves the document unlinked AND unqueued, which is worse than the state it
started in. `MODE=plan` by default; apply needs
`CONFIRM="PO-009968 IS CANCELLED IN AUTOCOUNT"`, which is the fact the script
cannot check for itself: it has one connection and it is to the ERP's Postgres.

**The verification asserts the defect, not the row count.** On a fresh
connection it re-reads `linked_ac_docno` and requires SQL `NULL` (an empty string
reads identically in a report and is not the same value), then reads the queued
row's `payload->'body'->>'DocNo'` and requires it to equal `HC-PO-2608-001`.
That field's absence is what produced `PO-009968`, so its presence in the queued
body is the only pre-drain evidence that the fix carried.

**Still unproven, deliberately.** Whether the document lands in `AED_HOUZS`
under `HC-PO-2608-001` is not knowable from the ERP — a `sent` outbox row means
AutoCount answered, not that the book holds the number expected. And a PO does
NOT record its sales source in `FromDocType`: `PODTL` uses `FromSODtlKey` /
`FromSODocList`, and on the cancelled `PO-009968` the line keys `905345` /
`905346` were written correctly while `FromSODocList` was EMPTY, where
AutoCount's own POs carry e.g. `SO-013000`. Whether the new send fills it in is
open.

**Ref.** PR #2369, 2026-08-17.

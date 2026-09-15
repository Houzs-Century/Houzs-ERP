## Moving a line to a new delivery order left it on the old one in AutoCount, so the book delivered it twice [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34850891130)
listed two sales order edits and one delivery order that AutoCount refused:

- HC-SO-008447's edit: *"The quantity of the item code AK- ESSENTIAL BOLSTER is
  less than the quantity it was partially transferred to other document"*;
- HC-DO-2609-103's transfer: *"Invalid transfer item"*, with the source line
  229176 on SO-003434 reading `Qty=3 TransferedQty=3`.

In the book, read-only on 2026-09-14: HC-DO-2609-044 still holds line 929094
*AK- ESSENTIAL BOLSTER x2*, transferred from SO line 585388, and HC-DO-2609-102
holds the same bolster from the same SO line, so SO-008447's line reads
`Qty 2, TransferedQty 4` — two bolsters delivered twice. HC-DO-2609-058 still
holds 929248 *AK- ESSENTIAL BOLSTER x3* from 229176, which is why DO-103 could
not take it. HC-DO-2609-039 still holds 928894 *AK-EQUINOX MATT (Q) x1* from
SO-013064's line 887649, a line no ERP delivery order carries.

**What happened (PROVEN, `scm.entity_audit_log`).** Each was a person removing
a line in the ERP: `HC-DO-2609-039` "Line removed: AKEMI EQUINOX MATT (Q)" at
2026-09-11 06:56:48Z; `HC-DO-2609-044` "Line removed: AK- ESSENTIAL BOLSTER" at
2026-09-14 04:26:42Z, then `HC-DO-2609-102` created at 04:27:17Z;
`HC-DO-2609-058` the same at 04:27:51Z, then `HC-DO-2609-103` at 04:28:27Z.

**Root cause (traced).**

1. At the moment of each removal none of the document's rows carried an
   AutoCount key (0897). The delete route names the removal for AutoCount with
   `retiredLineOf` (`backend/src/scm/lib/autocount-outbox.ts`), which returns
   nothing for a row with no `linked_ac_dtlkey`; the edit composed after the save
   was refused whole anyway (`KeylessLineError`, ten rows for DO-044 at 04:26Z).
2. The keys were filled later (the relink sweep's apply at 13:05Z, the
   DocTransfer stamp), and the edits sent then (DO-044 and DO-058 at 13:05Z)
   carry the document as it is now. The removed row is absent, and `/edit`
   applies only the lines it is given (the `Lines` loop in `AcSyncService.cs`),
   so the book kept the line live. Nothing left in the ERP names it.
3. The new delivery order's transfer then took the same sales line again.
   DO-102's was accepted; DO-103's was refused. Why AutoCount accepted a transfer
   from a line that was already fully transferred is UNKNOWN, and the repair
   does not depend on it.

**Fix.** `backend/scripts/retire-book-only-conversion-lines.mjs` (workflow *Zero
AutoCount DO / GR lines the ERP removed*). From the book snapshot, it finds the
lines of an ERP-numbered DO or GRN that no ERP row claims, and sends the same
instruction the delete route sends for a keyed row: the Worker's own
`enqueueEdit` with `retire`. It sends only when every ERP row of that document
is keyed, the line still has a quantity, and nothing downstream holds it. The
book snapshot is `backend/scripts/data/ac-conversion-line-keys.json.gz`, and its
exporter now records `qty` and `transferredOn`. The decision is in
`backend/scripts/lib/book-only-line-plan.mjs`, pinned by
`backend/tests/bookOnlyLinePlan.test.mjs`. Its decision, run read-only against
production with the snapshot of 2026-09-14T13:47Z: 3 lines to zero (the three
above), 22 held. Six of the held lines are on four goods receipts whose rows
still lack a key (HC-GRN-2609-008, -012, -026, -057). The other sixteen are on
HC-DO-2608-* / HC-GRN-2608-* test documents the ERP no longer has.

**Not fixed here.** The retirement is lost at the source for as long as a
converted document's rows arrive without keys. That ends when the office host
runs the `CreatedLines` build of 0898 and conversions are keyed as they drain.
Until then, this lane and the DocTransfer stamp are the recovery. HC-SO-008447's
edit and HC-DO-2609-103's transfer have to be sent again after the retirements
land.

**Ref.** fix/ac-moved-line-retire, 2026-09-14.

## A converted document could be rebuilt, which destroys its transfer link [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** No operator saw this one — it was caught by a test that had been red
for a day and was never run. A delivery order carrying a line AutoCount could not
match was queued for a REBUILD instead of being refused. A rebuild clears the
book's details and lays the ERP's list down, so the delivery order would have come
back holding lines that record nothing about the sales order they were delivered
against.

**Root cause (traced).** `docs/bugs/0610-a-document-that-cannot-be-matched-was-refused-forever.md`
widened the rebuild to any document whose rebuild was not BLOCKED, and
`rebuildBlocked` is set in exactly one place — `backend/src/scm/lib/autocount-outbox.ts`,
only for a sales order with a purchase order raised from it. So for the four
documents built by conversion — delivery order, goods received, sales invoice,
purchase invoice — nothing was ever set, and nothing refused.

**Why those four are different, in the book's own columns.** A converted document
records where it came from ON ITS LINES. `AcSyncService.DetailWanted` asks for
`FromDocType`, `FromDocNo`, `FromDocDtlKey` and `FullTransferFromDocList`, and its
own comment names them "the DOWNSTREAM shape — DODTL / IVDTL / GRDTL / PIDTL".
Clearing the details deletes the rows that hold the link.

**The host's guard could not catch it, and that is the part worth remembering.**
`AnyLineTransferred` reads `ISNULL(d.TransferedQty,0) > 0`, which is what this
document passed ONWARD. A delivery order that has not been invoiced yet reads as
untransferred right up to the moment its INCOMING link is cleared. The guard was
correct and asked the wrong direction. AutoCount's own recovery for a document in
that state is raw SQL plus Management Studio's Fix Deleted Document Transfer
Problem (`docs/bugs/0606-a-deleted-line-stayed-in-autocount-at-quantity-zero.md`).

**Fix, in two layers, because neither layer can see the whole answer.**

* The ERP does not ask. `ERP_OWNS_THE_LINES` in `backend/src/services/ac-line-gone.ts`
  holds SO and PO — the two documents whose lines the ERP creates — and
  `rebuildAllowed()` refuses everything else. An explicit `rebuild: true` from a
  caller does not override it: a caller asking is a preference, this is a fact
  about the account book.
* The host refuses a purchase order the BOOK says was raised from a sales order.
  `AnyLineTransferred` now also tests `PODTL.FromSODtlKey IS NOT NULL` for a PO,
  which is the incoming link the ERP cannot see reliably. Measured in the
  committed live-book extract and quoted in `DetailWanted`: 10,338 of 18,148
  non-cancelled PODTL rows carry one.

**Verified.** `backend/src/scm/lib/autocount-add-delete-line.test.ts` gains "a
converted document is never rebuilt, whatever its line set did";
`backend/tests/acRebuildDetails.test.ts` pins both refusals and that an explicit
request is checked AFTER them. 680 tests pass. `AcSyncService.cs` compiles —
`backend/scripts/autocount-service/build-local.ps1` printed
`COMPILES CLEAN - 110592 bytes`.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.

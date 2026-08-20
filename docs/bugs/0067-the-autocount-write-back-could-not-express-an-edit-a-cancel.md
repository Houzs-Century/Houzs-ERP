## The AutoCount write-back could not express an edit, a cancel or a create for most of the ERP's documents, and the gaps were invisible [high]

**Symptom** - the owner's go-live criterion 1 is "every document type syncs to
AutoCount - SO, PO, DO, GR, PI, SI - on create, convert AND edit, not just
create". A matrix of the 24 cells (6 doc types x create/convert/edit/cancel)
found 10 wired, 4 partial, 9 missing. `AcSyncService` could edit all six types
and cancel all six; the ERP could ask for two edits and four cancels. Nothing
reported the difference, and one test's NAME asserted the opposite.

**Root cause (traced, not guessed)** - four separate causes, not one:

1. **A type narrowing.** `enqueueEdit`'s `docType` was declared `'SO' | 'PO'`
   (autocount-outbox.ts) and `composeEdit`'s first parameter likewise, so
   `case "DO"`, `"IV"`, `"GR"` and `"PI"` in `AcSyncService.Edit()` were fully
   built and unreachable from the ERP. `AcSyncService.Cancel()`'s `"IV"` and
   `"PI"` cases had never been called by anything.
2. **A missing column.** An edit addresses a detail row by AutoCount's `DtlKey`,
   and 0273 put `linked_ac_dtlkey` only on the two line tables the ERP can
   CREATE in AutoCount. The four downstream line tables had no column to read a
   key from, so every downstream edit would have been refused for a reason that
   looked like data and was actually schema.
3. **A guard with no else.** `convertSosToPosCore` - the converter behind
   `POST /from-sos` AND the MRP agent's `createDraftPosFromPicks`, i.e. every PO
   the ERP raises from a Sales Order - recorded its audit row and queued
   nothing. It was not covered by the confirm-time hook either, because it
   writes `'SUBMITTED'` directly whenever a warehouse resolves, so
   `PATCH /:id/confirm` never runs for these. The same shape appeared four more
   times: a parentless DO / GRN / SI / PI fell out of an `if` writing no outbox
   row at all, not even a `skipped` one, so a document that can never exist in
   the account book left no trace of the fact.
4. **A test that asserted a set and checked a list.** `tests/autocountWriteback
   Wiring.test.ts`'s "every SO mutation path queues an edit" and "every PO
   mutation path queues an edit" each pinned a handful of named anchors. Five
   real mutation paths were outside them: the admin price `override` (which
   writes `unit_price_centi`, an AutoCount field), `applySoAmendment` and
   `applyPoAmendment` (the sanctioned ways to change a CONFIRMED document),
   `bulk-supplier-date`, and `convert-from-so`.

**Fix** - migration 0280 adds `linked_ac_dtlkey` to the four downstream line
tables; `AcDocType` replaces the two narrowings; `queueAcDoEdit` /
`queueAcGrnEdit` / `queueAcSiEdit` / `queueAcPiEdit` are wired to all sixteen
downstream header/line routes; SI and PI cancel are wired inside their atomic
CANCELLED branches; the five uncovered SO/PO paths queue an edit; the SO->PO
converter queues a create gated on the status literal that was inserted; and
`recordParentlessCreate` writes a visible `skipped` row for the four document
shapes AutoCount cannot hold. Every edit is an EDIT - no path expresses a change
as delete-and-recreate, which would also destroy AutoCount's own `DocTransfer`
links.

`tests/autocountWritebackCells.test.ts` is built the other way round from the
test that failed us: it READS the `case` labels out of `AcSyncService.cs`'s
`Cancel()` and `Edit()` switches and asserts the ERP asks for exactly that set,
so a service capability the ERP cannot reach fails automatically. **17 of its 18
tests fail against the pre-fix tree; 18 of 18 pass with the fix.**

**Ref** - feat/ac-writeback-remaining-cells, 2026-08-11.

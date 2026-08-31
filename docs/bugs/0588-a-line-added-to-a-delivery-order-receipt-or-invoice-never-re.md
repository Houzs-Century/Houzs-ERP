## A line added to a delivery order, receipt or invoice never reached the account book [medium]

**Symptom.** The last four cells of the add-a-line matrix: adding a line to a
delivery order, a goods receipt, a sales invoice or a purchase invoice refused
the WHOLE document's edit, exactly as the purchase order did before 2026-08-31.
The operator sees "The ERP cannot tell which lines AutoCount already has".

**Root cause.** The same missing wire, in four more places: `composeEdit` will
honour a declared-new line, and none of the four routes declared anything.
`composeDownstreamState` had no `newLineIds` parameter at all.

**A claim of mine was wrong, and this is the correction.** `NEW_LINE_TABLE`
shipped on 2026-08-31 saying "two entries, not six ... only the sales order and
the purchase order have a route that inserts a line by hand; the others are built
by CONVERSION". That reasoning was never checked. Every one of the six carries a
`POST /:id/items` — `grep -c "\.post('/:id/items'"` returns 1 for each of
`delivery-orders-mfg`, `grns`, `sales-invoices` and `purchase-invoices`. The map
now covers all six, and the four downstream tables are DERIVED from `DOWNSTREAM`
rather than re-listed, so "which documents this ERP syncs" still has one home.

**Fix.** `newLineIds` threaded through the four helpers (`queueAcDoEdit`,
`queueAcGrnEdit`, `queueAcSiEdit`, `queueAcPiEdit`) → `enqueueEdit` →
`composeDownstreamState` → `composeEdit`, and each `POST /:id/items` passes the
row it just inserted. The guard is unchanged: a keyless line the route did NOT
name still refuses the whole document, because guessing "new" appends a duplicate
into a live account book.

**Owner's decision, recorded.** This was raised as a question rather than a gap —
a delivery line with no parent sales line is stock that no order asked for — and
he answered 「全部都做完」. The ERP still writes what it always wrote; this only
stops the account book being left behind when it does.

**Tests.** Two in `autocount-add-delete-line.test.ts` (declared travels as
`IsNewLine`; undeclared still refused), the first RED against the unfixed tree
(`expected false to be true`). The four source-anchored assertions in
`autocountWritebackCells.test.ts` were repointed at the declaring call.

**Ref.** feat/downstream-add-line, 2026-08-31.

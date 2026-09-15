## A payment on a sales order whose lines AutoCount refused never reached the book's balance [medium]

**Symptom.** The owner asked on 2026-09-14 whether syncing payments into
AutoCount first would clear the documents stuck in the write-back. Measured on
production the same day (read-only): of the 137 payments staff recorded in the
ERP since go-live (2026-09-07), 133 were carried to AutoCount by a later
successful send, and 4 payments on 3 orders were not — `HC-SO-012025` and
`HC-SO-012736` (every later send refused, `SofaCollapseError`) and
`HC-SO-2609-063` (`body too large`). On those orders the book's `UDF_BALANCE`
kept the balance from before the payment. Where the send did land, the book
matched: `SO.UDF_BALANCE` equalled the value last sent on all 124 orders
checked.

**Root cause (traced).** `recordSoPaymentRow` (`scm/lib/so-payment-row.ts`) and
the payment `PATCH` / `DELETE` routes queued `enqueueEdit` — the WHOLE sales
order. `composeSoState` builds the edit from the header AND every line, and
`composeEdit` (`services/autocount-writeback.ts`) throws `KeylessLineError` or
`SofaCollapseError` while composing the lines; `enqueueEdit` catches it and
writes a `skipped` row with an empty body, so the header — where BALANCE and
PAYEMENT live — is discarded with the lines. A sent edit also carries every
line photograph, attached by the drain, so a photo-heavy order exceeds
AcSyncService's 2 MB `MaxBody` and fails with HTTP 413 (`body too large`),
again taking the balance with it. A payment changes no line; it was refused for
reasons that belong to lines.

The host never needed the lines: `AcSyncService.Edit()` applies `Header`, then
runs the key pre-flight and the line loop over `Lines`, and only
`Rebuild: true` clears details. An empty `Lines` touches nothing.

**Fix.** `backend/src/scm/lib/ac-so-payment-edit.ts`: `enqueueSoPaymentEdit`
queues `{ DocType: 'SO', DocNo, Header: { UDF: { BALANCE, PAYEMENT } }, Lines: [] }`
for an order already in the book, with the same two rules as the full header
(`"0.00"` when settled; no reference omits PAYEMENT). An order not in the book
yet still goes through `enqueueEdit` (a pending create absorbs the payment), and
a failed header read falls back to it. The insert core and both routes call it.
Tests in `backend/src/scm/routes/soPaymentQueuesAcEdit.test.ts` and
`backend/tests/autocountWritebackWiring.test.ts`; proved RED with
`so-payment-row.ts` and `mfg-sales-orders.ts` restored to `main` (3 failed:
the header-only body, the keyless line, the wiring pin).

**Not fixed here.** The 3 orders above keep their stale balance until their
next payment action or a re-queue; clearing the stuck documents is the next
step of the same work. The lines themselves are still refused on those orders.

**Ref.** fix/ac-payment-header-only, 2026-09-14.

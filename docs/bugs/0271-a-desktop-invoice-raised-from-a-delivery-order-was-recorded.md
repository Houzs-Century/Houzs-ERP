## A desktop invoice raised FROM a delivery order was recorded as having no delivery order [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SI-2608-001` sits `skipped` in `scm.autocount_outbox` reading
"created with no source Delivery Order", and a skipped TRANSFER row is not
re-queueable (`acRowIsRequeueable`) — so the invoice can never reach the account
book even once the transfer itself is fixed. The owner raised it from a delivery
order, on desktop, and is right to expect it linked.

**Root cause (traced, not guessed).** `POST /sales-invoices` called
`recordParentlessCreate` **unconditionally**, with `missing: 'no source Delivery
Order'` — a fact the handler never tested. The same handler accepts a source on
both halves of the document: `deliveryOrderId` on the header (stored as
`sales_invoices.delivery_order_id`) and `doItemId` per line (stored as
`sales_invoice_items.do_item_id`), and the desktop flow sends both —
`SalesInvoiceFromDo.tsx` navigates to `?fromDo=`, and `SalesInvoiceNew.tsx`
posts `deliveryOrderId: fromDo` plus a `doItemId` on every prefilled line. So
every desktop from-DO invoice was filed as ERP-only and never enqueued. Mobile
went through `POST /sales-invoices/from-dos`, which resolves the source DOs and
enqueues `do_to_iv` — **the repo's named recurring bug class, one surface
wired.** Of the four `recordParentlessCreate` call sites, this was the only one
whose claim was neither checked (as `delivery-orders-mfg.ts` checks `soDocNo`)
nor argued (as `grns.ts` argues that a hand-typed receipt must not transfer).

**Fix.** `scm/lib/si-autocount-source.ts` decides it from what was WRITTEN — the
persisted line links, then the header link — so any future caller of `POST /`
gets the right answer without passing anything. One source DO with every line
linked queues `do_to_iv`; several sources record the merged-conversion skip in
the same words `/from-dos` uses (that phrase is the classifier's needle); a
linked line beside a standalone line is refused as the new `mixed-source-lines`
kind, because AutoCount's transfer would produce an invoice missing the
standalone half and understate revenue in a live book; only a genuine no-source
invoice is recorded parentless. The route delegates in 13 lines, so the
over-ceiling file did not grow.

**Chosen deliberately.** The alternative was pointing the desktop page at
`POST /from-dos`. That route takes `{ picks }` and copies the DO header
verbatim, so it would discard everything the operator edited on the create form
— prices, dates, address, payment drafts. Fixing the server also fixes every
future caller rather than one page.

**What this does NOT fix.** `HC-SI-2608-001` itself. It already carries a
`skipped` transfer row, and the re-queue ladder refuses those by design. Whether
to cancel and re-raise it through the from-DO flow, or enter it in AutoCount by
hand, is the owner's call.

**Found in passing, not fixed.** `POST /purchase-invoices` has the same shape —
it accepts `grn_item_id` per line (the `?grnId=` draft path) and calls
`recordParentlessCreate` unconditionally. Whether that is the SI defect or the
GRN's deliberate refusal is a judgement about hand-typed quantities that needs
the owner; it is not a silent gap any more.

**Test.** `backend/tests/salesInvoiceAutoCountSource.test.ts` drives the exported
handler through a fake PostgREST client and asserts the queued row. Verified to
FAIL on the pre-fix code — six of its eight tests, the first with
`expected 'skipped' to be 'pending'`. Plus a branch anchor in
`autocountWritebackCells.test.ts` so the record cannot become unconditional
again.

**Ref.** PR #2337, fix/invoice-from-do-enqueue, 2026-08-17.

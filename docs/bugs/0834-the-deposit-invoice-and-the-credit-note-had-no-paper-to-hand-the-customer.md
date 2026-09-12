## The deposit invoice and the credit note had no paper to hand the customer [low]

<!-- area: Accounting + GL -->

**Symptom.** The deposit invoice (docs/bugs/0828) and the credit, debit and
supplier credit notes (docs/bugs/0827) lived only on their pages — no print,
no PDF, nothing to hand or send to a customer — while the payment voucher
and the official receipt have had theirs since 2026-09-04. With 2990's
switch on (171 deposit invoices and their credit notes about to be raised)
the counter had nothing to give. Owner 2026-09-12: 打印版，根据 PV/OR PDF
可以，需要显示 SO 号和付款方式，要批量打印; CN 要显示它关的 DI 号和 final
invoice 号.

**Root cause.** Not a defect: the two documents shipped without a print.
And the credit-note rows carried the final invoice only as
`sales_invoice_id` — no number to print.

**Fix.** Two client-side sheets in the payment voucher's and the receipt's
shape. `frontend/src/vendor/scm/lib/deposit-invoice-pdf.ts` (A5 landscape):
the customer, the sales order, how it was paid, the amount in figures and in
words, the credit note that closed it, a CANCELLED watermark with the reason
when it is void. `frontend/src/vendor/scm/lib/credit-note-pdf.ts` (A4) under
the kind's title: the party, the sales order, the deposit invoice it closes
(a `-DI-` reference) or the reference as typed, the final invoice, the
reason, a line per account with the chart's name, TOTAL, the amount in
words, a DRAFT or CANCELLED watermark. `withInvoiceNumbers` in
`backend/src/scm/routes/credit-notes.ts` puts `sales_invoice_number` on the
list and the detail. On the Credit & Debit Notes and Deposit Invoices pages:
Print in the detail prints the one document (a cancelled deposit invoice
too); ticked rows print as ONE document in list order, a page each, from a
bar that appears once something is ticked. Both builders draw into a shared
jsPDF (`renderXInto`) so the batch is the single sheet repeated, not a
second layout.

Pinned by `backend/tests/creditNotes.test.ts` (the invoice number on list and
detail), `frontend/src/vendor/scm/lib/deposit-invoice-pdf.test.ts` and
`frontend/src/vendor/scm/lib/credit-note-pdf.test.ts` (what each sheet
draws — captured off `doc.text`), `frontend/src/pages/scm-v2/CreditNotes.test.tsx`
and `frontend/src/pages/scm-v2/DepositInvoices.test.tsx` (the detail's Print
with its lines and names, the ticked batch in list order, the cancelled
invoice printing).

**Ref.** acc/print-notes-di, 2026-09-12.

## A refund on a deposit invoice handed the money back and left the sale standing [medium]

<!-- area: Accounting + GL -->

**Symptom.** With the deposit-invoice switch on (2990 since 2026-06-01), a
customer payment books a sale the day it is received: the payment Dr money /
Cr AR, the deposit invoice Dr AR / Cr 509 DEPOSIT PAY BY CUSTOMER
(docs/bugs/0828). Refunding that customer through the Customer Refund
voucher (§14, Dr AR / Cr bank) returned the money and touched nothing else:
the customer's AR netted to nothing while 509 still said the deposit was
earned, and the deposit invoice stood ISSUED as if the sale were still on.
The CN half was manual, nothing linked it to the invoice, and a PART refund
had no shape at all. Owner 2026-09-13: partial refund 可以做; 就 DI 也需要开 CN.

**Root cause (traced).** The refund voucher (`lib/pv-refund.ts`, 2026-09-07)
predates deposit invoices (2026-09-12). Its posting composes one journal —
the AR leg and the money leg — and knows nothing of the invoice the deposit
raised; the close-out that does raise a note per deposit invoice runs only at
the final invoice (`applyDepositInvoicesToInvoice`, docs/bugs/0831) and for
the invoice's whole amount.

**Fix.** `backend/src/acc/deposit-refunds.ts` (new):
- when a refund voucher naming a Sales Order POSTS, one credit note per
  deposit invoice the refund draws on — oldest first, Dr 509 / Cr AR with the
  customer as party, dated the voucher's day, `source_doc_no` the invoice,
  `refund_pv_id` the voucher (migration
  `backend/src/db/migrations-pg/20260913T1800_acc_credit_notes_refund_pv.sql`
  adds the nullable column and a partial index) — for what still stands on
  the invoice, until the refund is covered;
- refunded in full, the note closes the invoice (`credit_note_id`); in part,
  the invoice stands for the remainder, and the final invoice's close-out
  note is now for the REMAINDER (`applyDepositInvoicesToInvoice` reads
  `refundedByInvoice`);
- a cancelled refund voucher contras its notes and the invoices stand again;
- idempotent per (voucher, invoice); money no deposit invoice covers raises
  no note (the refund's own Dr AR answers that payment's Cr AR) and is logged.
The route file keeps two one-line hooks (`payment-vouchers.ts` post and
cancel; `refundHookInput` in `lib/pv-refund.ts` composes the input). The
refund source carries `deposits` (count and what stands) and the New PV form
says it before the voucher is raised; the Deposit Invoices list and detail
show what each was refunded, note by note, with the voucher. This is the
e-invoice shape too: a Refund Note referencing the original document.

Not done here, with management (owner 2026-09-13): the closed-invoice cancel
guard and converting payments to a new order.

Pinned by `backend/tests/depositRefund.test.ts` (the two notes, the
remainder at the final invoice, the cancel, idempotency, the uncovered part,
the refund source, the list and detail),
`frontend/src/pages/scm-v2/DepositInvoices.test.tsx` and
`frontend/src/pages/scm-v2/PaymentVoucherNew.test.tsx`.

**Ref.** acc/deposit-refund-credit-notes, 2026-09-13.

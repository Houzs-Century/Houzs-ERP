## A deposit invoice stayed open after the final invoice — the sale counted twice, and the Collection report measured the balance against the order instead of the invoice [medium]

<!-- area: Accounting + GL -->

**Symptom.** The deposit-invoice design (owner 2026-09-12; docs/bugs/0828,
0830) recognises the deposit as a sale the day it is received and raises
the final invoice at delivery — but nothing closed the deposit invoice
when the final invoice arrived. The deposit stood on 509-0000 DEPOSIT PAY
BY CUSTOMER while the final invoice booked the same goods on SALES OF
SOFA / BEDDING / …: the sale counted twice and the customer's receivable
read 150,000 too high on every order that took a deposit. The credit note
per deposit invoice the design calls for (owner: CN at delivery, 1:1 per
DI at final invoice) had no way to be raised: the note core lived inside
the /credit-notes route handlers, unreachable from the posting path. And
the Collection report's balance view measured the balance against the
order's amount even where a final invoice with a different total existed
(owner: 一个是看 balance paid / convert to sales invoice Sales).

**Root cause (traced).** No hook between "the final invoice posted its
revenue" and the deposit invoices standing on the order; the note's
number / header / lines / journal / contra were route-bound.

**Fix.** `backend/src/acc/credit-notes.ts` — the note core with no request
context (`insertCreditNote`, `postCreditNote`, `cancelCreditNote`;
`routes/credit-notes.ts` keeps the caller's half: permissions, the party
lookup, the leaf check, the draft edit). `acc/deposit-invoices.ts` —
`applyDepositInvoicesToInvoice`: at the final invoice, one credit note per
standing deposit invoice on the order, Dr 509-0000 / Cr AR (party the
customer) for the deposit's amount, dated the invoice's day, posted, and
linked on `credit_note_id` (idempotent; a note already raised for the
pair is linked, not duplicated); `releaseDepositInvoicesFromInvoice`: a
cancelled final invoice cancels those notes by contra and the deposit
invoices stand again (a note Finance raised by hand stays). The apply
hook sits in `postSiRevenue` (`lib/post-si-revenue.ts`) — the one gate
every issued invoice passes; the release hook at the invoice CANCEL in
`routes/sales-invoices.ts`. The deposit-invoice page names the note that
closed each. The Collection report (`routes/accounting-collection.ts`)
now reads the order's live sales invoice: the balance is measured against
what was BILLED (the invoice's total, else the order's — `billedSen`), the
invoice is named beside the order, and an invoiced order is at the balance
stage whatever its status says.

Net effect on the customer's ledger: deposits −D, deposit invoices +D,
the final invoice +T, the notes −D → AR = T − D, the balance still owed;
509-0000 nets to zero; the sale stands once, on the group sales accounts.

Pinned by `backend/tests/depositInvoiceCloseout.test.ts` (the notes, their
lines, the linking, the customer's receivable netting; a second posting;
an order with no deposit invoice; the release and a hand-raised note
staying; the list naming the note), `backend/tests/collectionReport.test.ts`
(an invoiced CONFIRMED order at the balance stage on its invoice's total, a
cancelled invoice no invoice) and `frontend/src/pages/scm-v2/CollectionReport.test.tsx`.

**Ref.** acc/deposit-closeout, 2026-09-12.

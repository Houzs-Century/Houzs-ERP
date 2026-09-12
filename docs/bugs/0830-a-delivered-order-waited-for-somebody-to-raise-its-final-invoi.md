## A delivered order waited for somebody to raise its final invoice — the deposit-invoice flow had no final invoice to close on, and a 2990 invoice's receivable sat under no customer [medium]

<!-- area: Accounting + GL -->

**Symptom.** The deposit-invoice design (owner 2026-09-12; docs/bugs/0828)
recognises the deposit as a sale the day it is received and closes it with
a credit note when the FINAL invoice is raised — but nothing raised that
invoice. 2990 has 0 sales invoices: a fully delivered order stayed DELIVERED
until somebody opened the picker, so the deposit invoices could never be
closed and the delivered goods were never billed in the books. On top of
that, a 2990 invoice's AR line carried no party: `postSiRevenue` stamped
`debtor_code`, which 2990 does not keep, while the payment, the deposit
invoice and the credit note all stamp the order's `customer_id` — so the
customer's sub-ledger could never net across the four documents.

**Root cause (traced).** The from-DO conversion lived inside
`POST /sales-invoices/from-dos` with the request context threaded through
it (company, prefix, user, actor), so no headless caller could raise an
invoice; the delivery reconciler that flips an order to DELIVERED
(`lib/so-delivery-sync.ts`) had nowhere to send it. The SI poster's party
rule predated `customerPartyCode` (docs/bugs/0788).

**Fix.** `backend/src/scm/lib/si-from-do.ts` — the conversion as a core with
no request context (`createSalesInvoiceFromDoLines`: the migrated refusal,
the remaining check, one customer per invoice, the race guard, the totals,
the audit row, the AutoCount enqueue, the revenue posting, the customer
credit, and the paid roll — now ALWAYS, so an invoice off a deposit-paid
order reads PARTIALLY_PAID / PAID from birth), with `recomputeTotals`,
`buildItemRow`, `recordSiCreate` and `migratedRefusalForDeliveries` moved
beside it (a lib may not import a route; the router shrank by ~500 lines).
The route is a thin door on the core. `lib/auto-final-invoice.ts` — when the
company's deposit-invoice switch is on, the reconciler invoices a
just-delivered order by itself off every delivered line not yet billed (the
picker's own gate on delivery status), skipping an order that already has a
live invoice, and never blocking the delivery. `postSiRevenue` stamps the AR
party the way the payment does: the debtor code when the business keeps one,
else the order's `customer_id`.

Next (④c-B): one credit note per deposit invoice at this moment
(`acc_deposit_invoices.credit_note_id`), and the Collection report's balance
view keyed on "has a sales invoice".

Pinned by `backend/tests/autoFinalInvoice.test.ts` (the switch off; on —
the invoice, its lines, the revenue per group with the customer as party,
the audit row; a second run; a line already billed left out; nothing to
bill; the picker path through the same core) and
`backend/src/scm/lib/post-si-revenue.test.ts`.

**Ref.** acc/auto-final-invoice, 2026-09-12.

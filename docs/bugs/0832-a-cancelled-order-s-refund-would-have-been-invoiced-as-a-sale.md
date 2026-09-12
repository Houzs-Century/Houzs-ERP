## A cancelled order's refund would have been invoiced as a sale, and the orders delivered before the switch had no way to their final invoice [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990 switched the deposit-invoice flow on (2026-09-12) with a
June start day. The page counted 174 payments still without a deposit
invoice. Three of them (RM 6,521) were payments on CANCELLED orders — money
owed back or credited, never a sale — and "Issue them now" would have
invoiced them. Sixty-four (RM 146,042.50) were on orders delivered before
the switch existed and carrying no sales invoice: their deposit invoices
would have been raised and never closed, the sale parked on 509-0000 for
good, because the automatic final invoice fires only on a delivery that
happens AFTER the switch is on. Owner: 已送货的我希望根据程序走，让他开 DI，
然后 delivered 了开 sales invoice 和 CN.

**Root cause (traced).** `issueDepositInvoice` and `missingDepositInvoices`
never read the order's status; the delivery reconciler is the only caller
of the automatic final invoice, so an order already delivered had no entry
point.

**Fix.** `acc/deposit-invoices.ts`: a payment on a DRAFT or CANCELLED order
earns no deposit invoice (`not_due` / `order_not_live`), at the hook and in
the backlog. `lib/auto-final-invoice.ts`: `deliveredUninvoiced` lists the
company's delivered-or-beyond orders with no live sales invoice, each with
the day its goods left (the latest `delivered_at` of its invoiceable
deliveries, else the customer delivery date); `invoiceDeliveredOrders` raises
each one's final invoice on that day (`createSalesInvoiceFromDoLines` now
takes `invoiceDate`), so the revenue lands in the month the goods left and
the deposit invoices on it close by credit note as the revenue posts.
`POST /deposit-invoices/invoice-delivered` and the count on the settings read
put it on the Deposit Invoices page as a second button that waits until the
deposit invoices have been issued — the owner's order: DI first, then the
final invoice and its credit notes.

Pinned by `backend/tests/depositInvoices.test.ts` (the cancelled order's
payment refused by name, absent from the backlog, the rest still issued),
`backend/tests/autoFinalInvoice.test.ts` (the backlog names the order and
its delivery day; the invoice and its journal carry that day; an invoiced
order leaves the backlog; the switch off skips by name) and
`frontend/src/pages/scm-v2/DepositInvoices.test.tsx` (the button waits for
the deposit invoices, then invoices).

**Ref.** acc/di-backlog, 2026-09-12.

## Money on a cancelled sales order had no exit but a hand-raised refund voucher; it could not move to a new order at all [high]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15 evening, bringing the "convert" he had taken
to management forward: 「关于那个 convert cancel bill 的 payment 去新的 bill 要提上来先
了 … 他们会 cancel bill，然后 cancel 的 bill 会可以是 refund，可以是 convert 去新的 so
（要支持 partial refund … 要可以一张 so convert to 多个 new so … 多个 cancel so
convert to 1 new so）… 他应该是 convert or refund，所以功能要做一起 … 这个按钮我觉得
挨着一起」. On 2990 HOME three cancelled orders were holding money (SO-2607-010
RM 1,723 with a refund voucher raised by hand, SO-2607-024 RM 3,365,
SO-2608-028 RM 1,433), and the only way to put a customer's deposit onto a
replacement order was to key the money again — twice in the books.

**Root cause (traced).** Cancelling an order touched neither its payments
nor its deposit invoices (by design), and nothing read what was left on it:
the Customer Refund voucher (`backend/src/scm/lib/pv-refund.ts`) knew the
refund headroom, but no code path moved money between orders, no payment
method could say "from that order", and the deposit invoice on the
cancelled order would have stood as a sale while a re-keyed deposit
recognised it a second time.

**Fix (the backend; the screens follow in their own PR).**

- **Migration
  `backend/src/db/migrations-pg/20260915T1800_so_payment_conversions.sql`**:
  `mfg_sales_order_payments.converted_from_so_doc_no` (a converted row names
  the cancelled order — the link is to the ORDER, like a refund voucher's,
  because money on an order is one pool) and
  `acc_credit_notes.converted_payment_id` (a note raised by a conversion,
  beside `refund_pv_id`). Additive, nullable, verified on staging.
- **`backend/src/scm/lib/so-money.ts`** — the one pool: `orderMoney` reads
  what an order collected (booked), the refund vouchers on it (draft or
  posted), the converted rows on other orders naming it, and the remaining;
  `convertGuard` is the ceiling (a cancelled order of the company with that
  much left, never itself); `convertSources` lists the customer's cancelled
  orders with money (any order can be named outright);
  `cancelledOrdersWithMoney` is Finance's list; `afterConvertedRowBooked`
  raises the credit note against the cancelled order's deposit invoices for
  the moved amount and issues the new order's own deposit invoice dated the
  day of the move; `refundDraftBody` is the refund request.
- **`backend/src/scm/routes/so-money-routes.ts`**, registered in
  `backend/src/scm/routes/mfg-sales-orders.ts` behind its per-order guard:
  `GET /:docNo/money`, `POST /:docNo/money/refund` (a Customer Refund
  voucher DRAFT for Finance through the voucher door's own core —
  `createPaymentVoucherCore` in `backend/src/scm/routes/payment-vouchers.ts`
  — with the customer as payee and the company's default bank as Paid From),
  `GET /:docNo/convert-sources`, `GET /cancelled-with-money`.
- **The conversion is a payment row** with method `converted`
  (`CONVERTED_METHOD` in `backend/src/acc/payments.ts`): `POST
  /:docNo/payments` and the order create
  (`backend/src/scm/lib/so-create-payment-slips.ts` schema) take
  `convertedFromDocNo`; the row keeps the cancelled order's first payment
  day and collector (owner: 原本当天，collected by 不影响), its sheet says
  "Converted from SO-x", it gets no receipt (`backend/src/scm/lib/so-payment-row.ts`),
  and its entry is the transfer Dr AR (cancelled order's customer) / Cr AR
  (new order's customer) dated the day of the move — `orderMoneyTransferLines`
  in `backend/src/acc/rules.ts`, `postConvertedPayment` in
  `backend/src/acc/payments.ts`, source type `SOCONV`. Sales is recognised
  once: the old deposit invoice +X, its note −X, the new invoice +X.
- **Un-convert** is deleting the row (the same-day / amend gate): the
  transfer is reversed (`reverseSoPayment` tries SOPAY, then SOCONV), the
  notes are cancelled by contra (`releaseConversionNotes` in
  `backend/src/acc/deposit-refunds.ts`), the new invoice cancelled. The PATCH
  door refuses a converted row.
- **Readers**: the refund headroom subtracts what was moved
  (`backend/src/scm/lib/pv-refund.ts`); the deposit takers count conversion
  notes as well as refund notes (`takeFromDepositInvoices`,
  `refundedByInvoice`); the drawer count (`backend/src/acc/daily-close.ts`),
  the drift check (`backend/src/acc/payment-drift.ts`) and receipt healing
  (`backend/src/acc/receipts.ts`) leave converted rows alone; the unbooked
  scan counts a SOCONV entry as booked; the journal references name the new
  order and the cancelled one (`backend/src/acc/journal-refs.ts`); the five
  journals file SOCONV under GENERAL (`backend/src/acc/journal-class.ts`).
- **`backend/src/scm/lib/fake-postgrest.ts`**: a delete chain that asks
  (`.select().maybeSingle()`) is handed the removed row, the way PostgREST's
  `DELETE … RETURNING` is — the payment DELETE reads it.

No new number series (the refund draft takes the voucher's Draft series).

Proved RED on main's source: `backend/tests/soMoneyConvert.test.ts` (no
handlers to import), `backend/src/acc/journal-refs.test.ts` (SOCONV read as
its key), `backend/src/acc/daily-close.test.ts` (a converted row counted as
takings), `backend/tests/depositRefund.test.ts` (the note shape). Green
after.

**Ref.** acc/so-payment-convert, 2026-09-15.

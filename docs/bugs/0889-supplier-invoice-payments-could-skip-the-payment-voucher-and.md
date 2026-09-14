## Supplier invoice payments could skip the payment voucher and the books [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit (row
DOC-10, defect B-2). On the phone, a Purchase Invoice with money owed offered
Record Payment. Typing an amount marked the invoice paid or partly paid at once:
no payment voucher was raised, so Finance never checked or approved it, no
journal entry was booked for the money, and an invoice on hold took the payment
anyway. On the desktop the same invoice offered two buttons that did nothing
useful: Record payment reopened the page it was on, and Mark paid could only
fail.

**Root cause (traced in the source).** One legacy route that was never retired,
and three screens deciding on their own:
- `PATCH /purchase-invoices/:id/payment` in
  `backend/src/scm/routes/purchase-invoices.ts` added `amountSen` straight onto
  `paid_sen` and set the status. It refused only DRAFT and CANCELLED. It never
  read the hold, never posted to the GL, never clamped to the total, and no
  voucher stood behind it. The real path, an AP Payment voucher that settles the
  invoice through `scm.settle_pi_paid_sen` when it posts, arrived with the
  2026-09-02 voucher flow; this route stayed beside it.
- The phone's generic detail (`frontend/src/mobile/MobileModuleDetail.tsx`,
  `paymentKind`) offered its Record Payment sheet for `purchase-invoices` as
  well as `sales-invoices`, and the sheet sent the typed amount to that route.
- The desktop detail and the list drawer sent Record payment to
  `/scm/purchase-invoices/:id?tab=payments&record=1`. The detail page reads only
  `?edit=1`, so nothing opened. Mark paid appeared only when nothing was owed
  and sent `amountSen: 0`, which the route refuses (`amount <= 0` is
  `invalid_amount`).

**Fix.** One rule, `frontend/src/vendor/scm/lib/pi-payment-path.ts`: an invoice
that still takes a payment (POSTED or PARTIALLY_PAID, something owed, not held,
the same list the AP Payment page offers) is paid with an AP Payment opened at
`/scm/payment-vouchers/new?type=ap&supplier=<id>&pi=<id>`, offered only to a
user who can open that page (`scm.access` or `scm.finance.accounting`, the doors
`ScmGuard` opens for it). The AP Payment page now reads `?supplier=` and ticks
`?pi=` in full once. The route answers every call with 409
`payment_voucher_required` and touches no table. The phone offers no sheet on a
purchase invoice and names where the payment is recorded
(`frontend/src/mobile/doc-payment.ts`). The desktop's Record payment opens the AP
Payment; Mark paid and `useRecordPiPayment` are gone.

Pinned by `backend/tests/piDirectPaymentRetired.test.ts`,
`frontend/src/vendor/scm/lib/pi-payment-path.test.ts`,
`frontend/src/mobile/doc-payment.test.ts` and the "opened from a purchase
invoice" block of `frontend/src/pages/scm-v2/PaymentVoucherNew.test.tsx`. With
the five changed source files put back to `main` (bytes confirmed restored by
`git diff`), 9 of those tests fail: 7 frontend, 2 backend.

**What it left behind.** A payment typed this way moved the invoice's paid
amount with no journal entry. How many exist is UNKNOWN at the time of writing.
`backend/scripts/probe-pi-direct-payments.mjs` (Actions:
probe-pi-direct-payments, read-only) counts them from the audit trail, which
reaches back only to 2026-07-18, so its count is a floor.

**Ref.** fix/pi-payment-via-vouchers, 2026-09-14.

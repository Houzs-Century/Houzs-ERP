# Payment Voucher (PV)

Records money leaving the company — expenses, supplier settlements, internal
transfers, and customer refunds. One route serves several document "types"
distinguished by `purpose`. Used by Finance/AP staff; desktop only.

## Statuses and flow

- `DRAFT` → **Prepare** (`/submit`) → still DRAFT, `submitted_at/by` stamped →
  **Check** (`/check`, `checked_at/by`) → **Approve** (`/approve`) → posts the
  GL in the same request → `POSTED` (list pill reads **Approved**).
- Four layers are marker columns on the row, not new status values: `status`
  stays `DRAFT` until approve posts it. No fast path — every voucher walks all
  layers; check and approve can be the same person.
- **Prepared can still be edited**; **Checked locks editing** (409
  `not_editable` outside DRAFT).
- **Reject** (either check or approve key) → back to raw `DRAFT`, every mark
  cleared, reason on the audit trail.
- **Withdraw** — preparer's own back-out — only works before Check.
- `CANCELLED` reverses the GL and unwinds settlement; retains any adopted FX
  rate (does not revert to 1).
- Batch actions (Prepare/Check/Approve&post) run in **voucher-date order**,
  never tick order — the formal number mints at Check.

## Permissions

- `scm.payment_voucher.create` — create, OCR extract.
- `scm.payment_voucher.write` — edit DRAFT, withdraw, attach/delete files.
- `scm.payment_voucher.check` — Check step.
- `scm.payment_voucher.approve` — Approve step (also allowed to reach `/post`).
- `scm.payment_voucher.post` — direct post (normally reached through approve).
- `scm.payment_voucher.cancel` — cancel a POSTED voucher.
- All gated behind area guard `scm.finance.accounting`.

## Rules that must not break

- A `purchase_invoice` on hold cannot be settled — `allocationPisOnHold`
  refuses 409 `allocation_on_hold` at the point the invoice id enters; fails
  closed on a read error.
- **`applied_sen`, not `amount_sen`, is what a cancel reverses** — record what
  the DB actually applied (post-clamp), never the requested amount.
- Never cap an allocation in the caller — the clamp is evaluated by Postgres
  (`scm.settle_pi_paid_sen`) at write time under a row lock; a caller-side cap
  lets two vouchers each pay their "share" and double-pay the invoice.
- FX rate adoption (`planPvRateAdoption`) only ADOPTS when the PI's stored
  rate is exactly 1 (never-set marker); any other stored rate is left
  UNCHANGED (`report_mismatch`) — never overwrite a real rate.
- The rate/recost step must never throw — the money already left the bank;
  every failure is logged and stepped over.
- A negative or fractional amount is refused (400), never silently clamped to
  0.
- An allocation names a PI **or** an AP invoice, never both or neither
  (`allocation_two_targets` / `allocation_pi_required`).
- An invoice a saved unposted (Draft/Prepared/Checked) voucher already applies
  to must be excluded/reduced in the picker (`pendingReservations`) — else two
  vouchers can apply the same invoice in full.
- Paid From must be a money account (`acc_money`, company `BANK_DEFAULT`
  role); server refuses any non-money credit account.
- Lines take only LEAF, non-control accounts (`requireLeafAccount`) — except
  the AP control debit (AP Payment) or AR debit (Customer Refund), which are
  the one exempted line each.
- AP Payment debits the **supplier's own control** account (400-0000 normal,
  405-0000 for an "other creditor"/405-prefixed supplier) — refused
  `wrong_ap_control` otherwise.
- `voucher_date`: create defaults to today when blank; **edit refuses a blank
  date** (400 `voucher_date_required`) — the column is NOT NULL, do not
  "harmonise" the two paths.
- `POST /:id/post` and the cancel path must stay company-scoped (was
  unscoped once — a cross-company id could post/cancel another company's GL).
- The idempotency read before posting must report its own failure (500), never
  treat a failed read as "no existing JE" — that caused a double-post.
- Attachments: a CANCELLED voucher accepts no more files (409
  `voucher_cancelled`); delete is refused once `checked_at` is stamped (409
  `evidence_locked`).
- Foreign-currency guards (`fx-guard.ts`) block a new/flipped non-MYR
  GRN/PI/PV with no positive rate anywhere (422 `foreign_rate_unset`) — not a
  PV route itself, but the PV's error message points at it.
- `CurrencySelect` and its FX logic (`fx-rate.ts`) are shared with GRN and PI
  — a change there touches three documents.
- There is **no mobile surface** for this module.

## Gotchas

- Two logical documents ride one route/table: **Payment Voucher**
  (`purpose='OTHER'`, free-text payee, hand-written lines, no supplier) vs
  **AP Payment** (`purpose='SUPPLIER_PAYMENT'`, supplier required, tick
  invoices to pay, page composes the single AP-control GL line) — do not
  reintroduce a "Purpose" dropdown; the document type IS the purpose.
  **Customer Refund** (`purpose='CUSTOMER_REFUND'`) is a third kind: no
  payee/lines, names an SO/SI, composes a single Dr AR line, refundable only
  up to booked-minus-already-refunded headroom; an SI can only be refunded
  once CANCELLED.
- An **AP Payment prepay** beyond ticked invoices books to
  `scm.acc_supplier_advances`; spending it (`/apply-advance`) posts nothing
  new, only settles `paid_sen`/`applied_sen` — a voucher whose advance has
  been spent refuses to cancel (`advance_applied`).
- The OCR bill reader (`/payment-vouchers/extract`) **writes nothing** — every
  scan lands on the New page for a human to confirm before save; supplier
  matching falls back to NO match rather than guess wrong.
- Vendor memory (`scm.acc_vendor_memory`) only learns from what the operator
  actually **saved**, never from a model guess; AP payments teach nothing
  (their one line is fixed by role).
- Numbering: a new voucher mints on a per-company **Draft series**
  (`{co}Draft-YYMM-NNN`); the **formal** number
  (`{co}{bankLetter}PV-YYMM-NNN`, or fixed `{co}CPV-...` for cash) mints only
  at Check — a bank with no configured letter refuses the check (409
  `bank_letter_missing`).
- Internal transfers and cash bank-ins ride this same document (non-AP mode,
  a 付款/内部转账 toggle) — the route refuses a line debiting the Paid From
  account itself (`same_account`).
- Print/attachments: the bill(s) the OCR read should be attached to the
  created voucher (`pv-file-handoff.ts` stash, module memory — never
  `location.state`) so `print-bundle` can append them after the voucher page;
  a print must refuse rather than silently omit files it cannot list.

## Where the code is

- `backend/src/scm/routes/payment-vouchers.ts` — routes, handlers.
- `backend/src/scm/routes/pv-files.ts`, `backend/src/scm/lib/doc-files.ts` —
  attachments + print-bundle.
- `backend/src/scm/lib/pv-approval.ts` — the four-layer state machine.
- `backend/src/scm/lib/pv-rate-adoption.ts` — the FX-rate decision table
  (pure).
- `backend/src/scm/lib/pi-settlement.ts`, `backend/src/scm/lib/recost.ts`,
  `backend/src/scm/lib/fx.ts`, `backend/src/scm/lib/fx-guard.ts`,
  `backend/src/scm/lib/doc-no.ts`, `backend/src/scm/lib/pv-refund.ts` —
  settlement, costing cascade, FX helpers, numbering, refund rules.
- `backend/src/acc/bill-extract.ts` — OCR extraction.
- `frontend/src/pages/scm-v2/PaymentVouchers.tsx` (list),
  `PaymentVoucherNew.tsx` (create/AP Payment/refund/transfer),
  `PaymentVoucherScan.tsx` (bill pile), `PaymentVoucherDetail.tsx`
  (detail/edit).
- `frontend/src/vendor/scm/lib/payment-voucher-queries.ts`,
  `payment-voucher-pdf.ts`, `pv-file-handoff.ts`, `pv-type-label.ts`.
- `frontend/src/pages/scm-v2/fx-rate.ts` — shared FX resolution (GRN/PI/PV).

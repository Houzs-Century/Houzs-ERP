# Sales Invoice (SCM)

Doc-flow position: SO → DO → SI — the end of the sell chain, and the only
document in it that leaves the building as the customer's own copy. A clone
of the Delivery Order API, plus two things neither DO nor GRN has: **GL
revenue posting** and a hard **ISSUED = FROZEN** rule. Used by sales and
accounting staff. Money is integer sen.

## Statuses and flow

- Canonical set (`SI_STATUS_CANON`, applied before any branch via
  `canonicalSiStatus`): `DRAFT | SENT | PARTIALLY_PAID | PAID | OVERDUE |
  CANCELLED`. `SI_LEGAL_TRANSITIONS` is the single transition authority —
  nothing moves back to DRAFT; a CANCELLED invoice may only reopen to SENT.
  An unrecognised persisted status fails **open** (never bricked).
- `DRAFT`: manual (create with the draft flag). Commits no AR/GL, no
  customer credit.
- `SENT`: manual on confirm or create-not-draft; also written **back**
  automatically by `recomputePaid` whenever a paid total rolls back to 0.
- `PARTIALLY_PAID` / `PAID`: **automatic only** — `recomputePaid` derives
  these from the payments ledger, triggered by a payment add/delete on this
  invoice OR on its source Sales Order's deposit. No route sets `PAID`
  directly.
- `OVERDUE`: no writer exists anywhere in the backend; it is a legal
  transition target and is read by reporting agents, but nothing computes
  or writes it. Filed in the `sent` status bucket.
- `CANCELLED`: manual (status PATCH). Reverses revenue (`reverseSiRevenue`)
  and mints a customer credit (`creditFromCancelledSi`).
- **ISSUED = every status except DRAFT and CANCELLED** — not PAID. Freezes
  exactly four header fields (`invoiceDate`, `currency`, `debtorName`,
  `debtorCode`) and freezes ALL line add/edit/delete wholesale. The
  sanctioned correction for an issued invoice is **cancel → fix → reopen**;
  there is no in-place revision table.
- A live invoice's line/total edit calls `resyncSiRevenue` (void + repost
  of the GL journal) — correct specifically because the ISSUED gate sits in
  front of it and a DRAFT can still be freely edited.
- Migrated (AutoCount cutover) invoices are flagged `migrated_no_stock`:
  `postSiRevenue` and `applyCustomerCreditToSi` both check the flag and
  short-circuit — no GL journal, no customer-credit spend — because
  AutoCount already accounted for that money. A carried-over delivery is
  invoiced by hand like any native one — the ERP is the sole book
  (`AUTOCOUNT_IS_ACTIVE_BOOK = false`, owner 2026-09-22), so
  `deliveryMustMirrorAutoCount` returns false for all; the `do_to_iv`
  write-back stays suppressed for a migrated source so nothing double-books in
  AutoCount. Flip the flag back to true to restore the mirror regime, where the
  `migrated-deliveries-not-invoiced.generated.ts` allow-list governs exceptions.
- Stock is **never** moved by this document, at any status — the goods left
  at the Delivery Order; the SI only ever moves money and the ledger.

## Permissions

- `scmAreaGuard('scm.sales.invoices', { readInheritsFrom: 'scm.sales.orders'
  })` — a salesperson may read (and re-send) invoices raised off their own
  Sales Orders even without the invoices read permission; any write needs
  `edit` on `scm.sales.invoices`.
- Desktop route: `<ScmGuard area="scm.sales.invoices" allowSales>` for list
  and detail; `new` and `from-do` do **not** carry `allowSales`.
- `canOperateSalesInvoices` (`frontend/src/auth/salesAccess.ts`) is the
  shared operate-gate for mobile and the desktop list — it refuses the
  Sales cohort (view + print only). The desktop **detail** page instead
  gates its own Add-line on a raw `pageAccess` edit check — a recorded,
  deliberate difference, not a bug.
- List/detail/payments reads are additionally scoped to the caller's own
  sales via `resolveSalesScopeIds` — pass the Houzs user id, not the auth
  `user.id`.
- Finance columns (`SI_FINANCE_KEYS` on the header, `SO_ITEM_FINANCE_KEYS`
  on lines) are deleted server-side from every row unless the caller passes
  `canViewScmFinance`.

## Rules that must not break

- Every line-CRUD verb (`POST/PATCH/DELETE /:id/items[/:itemId]`,
  `POST /:id/items/from-do/:doId`) must prove the invoice belongs to the
  active company with the **strict** pair — `requireActiveCompanyId` +
  `scopeToCompanyId` — never the read-oriented `scopeToCompany`, which
  silently degrades to no predicate when the company is unresolved. A
  `company_id` stamp on the insert is not a scope check.
- The company gate must run **before** business validation, or a
  cross-company caller is told their item code is wrong instead of being
  refused outright.
- A `do_item_id` / `so_item_id` accepted from the request body must be
  asserted to name the **same product** as the line (409
  `link_material_mismatch`) — a failed identity read must refuse (503), never
  pass. This is re-checked on an edit to an already-linked line too, using
  the line's effective post-patch item code.
- The Sales Order's deposit is **read through**, never copied into
  `sales_invoice_payments` — copying would double-post (both ledgers debit
  cash/bank and credit AR, and daily cash-up sums both tables).
- `so_deposit_applied_sen` must be stamped identically wherever an
  invoice's outstanding is shown (list, detail, `/outstanding/si`, the
  detail-listing report, the KPI/summary) — a partial rollout makes screens
  disagree about the same invoice's balance.
- A failed deposit-stamp read must render as `null`, read by every
  consumer as "no deposit" (the larger, safer figure) — never as zero
  deposit collected, which would be the smaller, wrong direction.
- `recomputePaid` and `recomputeTotals` fail **closed**: a failed read
  aborts (logs) rather than writing `paid_sen = 0` or a zeroed total — a
  transient blip must never silently revert a PAID invoice to unpaid or
  blank a live total.
- GL posting is keyed on `(source_type='SI', source_doc_no=invoice_number)`
  so a retry or a resync can never double-post the same invoice.
- Desktop and mobile DO→SI conversion deliberately diverge: desktop routes
  through an editable review form (`POST /`); mobile always sends
  `asDraft: true` on `POST /from-dos` and never issues an invoice directly
  from the convert wizard — the operator must confirm from the document.
- FOC (free-of-charge) status is decided by exactly one shared function
  (`isFocLine`) — never re-derived per surface, or two documents can
  disagree about whether the same line was free.
- A document's status **label** (badge, pill, filter tab) must be read from
  the shared canonical mapping (`status-pill.ts`), never a per-page
  hand-written map — several surfaces have already drifted apart on the
  same stored value.

## Gotchas

- Do not make "Mark paid" write `{status: 'PAID'}` directly — it must
  record a real payment row (`POST /:id/payments`, net of the source
  order's deposit) and let `recomputePaid` derive the status, or
  `paid_sen` and `status` desync the moment anything else touches the
  invoice.
- Do not default a payment method on an automated "mark paid" action — a
  silent `cash` default lands in the daily cash-up and leaves the drawer
  short; always stop at the payments editor for the operator to choose.
- Do not read or write `do_doc_no` on a sales invoice — that column exists
  only on Delivery Returns. The SI's parent delivery number is `do_number`,
  stamped at read time from `delivery_order_id` by `stampDoNumber`, and
  must be stamped on all three read paths (both list paths + detail).
- Do not render a uuid-fragment fallback when a linked document's readable
  number is missing — show a dash; a hex fragment reads as a real (wrong)
  reference and can be mistaken for a broken link.
- Every migrated delivery is invoiceable by hand now (`AUTOCOUNT_IS_ACTIVE_BOOK
  = false`). Were AutoCount reinstated as the book, only deliveries on
  `migrated-deliveries-not-invoiced.generated.ts` bill freely and one migrated
  line anywhere in a batch pick would refuse the **whole** invoice (a partial
  invoice cannot carry AutoCount's number).
- Do not treat a short/incomplete migrated invoice as an SI-side bug — an
  absent migrated invoice is a symptom of a short Delivery Order (a missing
  line or price); fix the delivery, and the invoice writes itself.
- Do not let a swallowed read on the deposit application silently proceed
  as if there were no deposit — `orderDepositUnavailable` must be surfaced
  as a warning, and the "mark paid" flow must refuse (`deposit_unknown`)
  rather than record a receipt against an unverified balance.
- Do not add a new AR/outstanding aggregate (a materialized view, a raw SQL
  sum) without applying the same order-deposit adjustment the row-level
  reads already apply — several legacy aggregates (collection/document
  agents) are still known to overstate outstanding for this reason.

## Where the code is

- Routes: `backend/src/scm/routes/sales-invoices.ts` (mounted at
  `/api/scm/sales-invoices`), `sales-invoice-exports.ts`, `outstanding.ts`,
  `reports.ts` (detail-listing report).
- Backend libs: `backend/src/scm/lib/si-order-deposit.ts` (deposit
  read-through + `recomputeSiPaid`), `si-from-do.ts` (from-DO conversion
  core), `si-outstanding-summary.ts`, `si-list-read.ts`,
  `si-status-buckets.ts`, `si-list-stamps.ts`, `si-autocount-source.ts`,
  `si-export-rows.ts`, `customer-credits.ts`, `recost.ts`
  (`restampSiFromDo`), `do-line-remaining.ts`, `migrated-chain.ts`,
  `migrated-deliveries-not-invoiced.generated.ts`,
  `line-link-item-identity.ts`, `auto-final-invoice.ts`.
- Shared: `backend/src/scm/shared/do-shipped-states.ts`, `so-outstanding.ts`.
- Migration/repair scripts: `backend/scripts/create-migrated-invoices.mjs`,
  `list-migrated-deliveries.mjs`, `export-migrated-deliveries-not-invoiced.py`.
- Desktop: `frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx`,
  `SalesInvoiceDetailV2.tsx`, `SalesInvoiceNew.tsx`, `SalesInvoiceFromDo.tsx`,
  `SalesInvoiceAddLine.tsx`, `SalesInvoiceDetailListing.tsx`,
  `markPaidPlan.ts`, `siPaymentIntent.ts`.
- Frontend data/shared libs: `frontend/src/vendor/scm/lib/sales-invoice-queries.ts`,
  `si-outstanding.ts`, `si-list-export.ts`, `foc-line.ts`, `status-pill.ts`,
  `line-add-lock.ts`; `frontend/src/auth/salesAccess.ts`.
- Mobile: `frontend/src/mobile/MobileModuleList.tsx`, `MobileModuleDetail.tsx`,
  `MobileConvertWizard.tsx`, `MobileAddLine.tsx`.

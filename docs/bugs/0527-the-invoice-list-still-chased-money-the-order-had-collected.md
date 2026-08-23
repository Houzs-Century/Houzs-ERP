## The invoice list still chased money the order had collected [high]

**Symptom.** PR #2681 taught the Sales Invoice DETAIL page that a deposit taken
on the source Sales Order settles part of the invoice. Measured on production
the day it shipped, `HC-SI-2608-004` (order `HC-SO-2608-006` collected MYR
2,000 cash, invoice total 4,400):

| screen | outstanding shown |
|---|---|
| SI detail | 2,400 — the deposit applied |
| SI **list** | **4,400** |
| the list's Outstanding **KPI card** | **10,200** |

So the two screens disagreed about the same invoice, and the wrong one was the
LIST — which is the screen the office scans to decide who to chase. The owner's
original complaint was「payment record怎么没带去invoice那边呢」and the harm he
named was chasing a customer who had already paid; the detail-only fix did not
remove that harm.

**Root cause (traced).** The rule was correct and nothing called it.
`grep -c "deposit\|orderDeposit\|so_deposit" frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx`
returned **0**. Six surfaces each carried their own copy of
`Math.max(0, total_sen - paid_sen)`:

- `SalesInvoicesListV2.tsx` — the Outstanding column, the cards view, the
  quick-view drawer, the Outstanding KPI (four copies in one file), and the CSV
  export, which serialises the column's `getValue`
- `MobileModuleList.tsx` `balanceSen` — the mobile card footer and quick view
- `MobileModuleDetail.tsx` — the SI Balance stat, and the Record-Payment sheet,
  which **pre-fills the amount to collect** (it would have asked the customer
  for the deposit a second time)
- `sales-invoice-pdf.ts` — the invoice handed to the customer who paid it
- `reports.ts` `balance_sen` — the SI Detail Listing report and its Outstanding
  tile
- `outstanding.ts` — the `/scm/outstanding` ledger, straight off
  `scm.v_si_outstanding`

The deeper cause is the shape, not any one file: a money rule with six
implementations is fixed in one of them at a time.

**Fix.** The backend stamps ONE field, `so_deposit_applied_sen`, onto every
Sales Invoice row it serves — list, detail, `/outstanding/si`, and the detail
listing — through `stampOrderDeposit` (`backend/src/scm/lib/si-order-deposit.ts`),
three batched reads per page in the style of `stampSoDates` / `stampDoNumber`.
The allocation is keyed by `so_doc_no`, never by the page's ids: a sibling
invoice can sit on another page, and a page-local split would hand the same
money to two pages.

`paid_sen` still means receipts banked against THIS invoice — the GL,
`scm.v_si_outstanding` and the AutoCount write-back read it. The two are kept
apart, and each screen shows them as separate labelled lines.

The six frontend copies became one, `frontend/src/vendor/scm/lib/si-outstanding.ts`.
`scm.v_si_outstanding` and `scm.mv_ar_aging` were **not** touched — recreating a
view is a new object with an empty ACL (the 0189 incident), and the split is a
per-order rule no SQL column can express; `/outstanding/si` adjusts the served
row instead.

Pinned by `backend/src/scm/lib/si-order-deposit-list.test.ts` (13) and
`frontend/src/vendor/scm/lib/si-outstanding.test.ts` (14). The frontend suite
reads each surface's SOURCE and asserts it reaches the shared rule, because the
failure mode here is a screen that never calls the function — which no amount of
testing the function can see. Proved RED: sixteen guards deleted one at a time,
sixteen red, including one per surface that reproduces exactly what production
was doing.

**Ref.** `feat/the-list-knows-it-too`, 2026-08-23. Follows #2681.

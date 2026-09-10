## A receiptless scan draft double-counted its deposit, so the SO showed twice what the customer paid [high]

**Symptom.** A Sales Order scanned from the handwritten slip WITHOUT the merchant
copy, then completed by an operator adding the payment by hand, showed **Paid
RM2,800** against a single **RM1,400** payment row — exactly double. The PAYMENTS
list carried one row, so nothing tallied, and because admin arranges delivery off
the SO's remaining balance, the order looked more paid (less owing) than it was.
Owner: "customer just paid 1400 but system show 2800 ... this big issue".

**Root cause (traced).** Paid is the header aggregate `paid_sen_total`, not the
sum of the visible rows. It is `soPaidSen` (`backend/src/scm/shared/so-outstanding.ts:102`):
`(depositInLedger ? 0 : headerDepositSen) + ledgerPaidSen` — the header
`deposit_sen` is added ON TOP of the ledger UNLESS an `is_deposit` row already
represents it. That function's own docstring names the load-bearing assumption:
"the SO create path writes the deposit as a ledger row ... adding the header
column on top would DOUBLE COUNT". The scan path breaks it:
1. `buildDraftSoBodyFromSlip` stamps `depositSen` from the slip's handwritten
   `depositRm` UNCONDITIONALLY (`scan-so.ts:3896`).
2. The create core books the backing `is_deposit` row only when the method is in
   the LOWERCASE ledger whitelist `['cash','merchant','transfer','installment']`
   (`mfg-sales-orders.ts:5314`); the scan sends the CAPITALIZED dropdown value
   `'Merchant'` (`scan-so.ts:3822`), which never matches, so `deposit_sen` is
   stamped header-only (`:5181`), no ledger row.
3. With no merchant-copy photo, `recordScanReceiptPayments` books nothing
   (`receiptIdxs.length===0` early return, `scan-so.ts:3407`), so nothing else
   supplies the is_deposit row either.
Result: header `deposit_sen=140000`, no is_deposit row. When the operator adds the
real payment as an ordinary `is_deposit=false` row, `soPaidSen` = header 140000 +
ledger 140000 = **280000** (RM2,800). The manual New SO path is safe: its client
maps the method to the lowercase code before posting
(`MobileNewSO.tsx:1488`, `paymentMethodCodeForValue`), so the is_deposit row is
always booked — only the scan path skips that step. Confirmed against main: the
same expression in the list rollup (`mfg-sales-orders.ts:2203`) and the detail
(`:2661` via `soPaidInputsOf`/`soPaidSen`), so the double shows on the list,
the detail and the customer PDF, and it persists past DRAFT into the confirmed SO.

**Fix.** `scan-so.ts` runScanJob drops the header deposit unless a backing
is_deposit row will actually be booked: `safeScanDepositSen`
(`backend/src/scm/lib/scan-header-deposit.ts`) zeroes `body.depositSen` unless the
draft is non-shell AND has a CLASSIFIED payment receipt (the same gate
`recordScanReceiptPayments` books on). The receipt-backed case is byte-identical —
its is_deposit row already makes `soPaidSen` ignore the header, so `deposit_sen`
is left intact for reports/PDF. The receiptless / shell case now lands Paid=0 and
the operator adds the payment on review — the owner rule the module already states
(`scan-so.ts` ~:3395, "never book money off an unclassified photo"). Pinned by
`backend/tests/scanHeaderDeposit.test.ts` (no-receipt → 0, shell → 0, receipt →
kept, negative/NaN → 0). Verified on the equivalent full-deps tree; this fresh
worktree has no node_modules, so tsc/vitest gate on CI.

**Existing data.** The ledger is NOT corrupted — every payment row is real and
correctly `is_deposit=false`. The defect is a header AGGREGATE, so the repair is
to zero each orphan `deposit_sen`. A read-only audit lists the affected SOs before
any write: `backend/scripts/check-orphan-scan-deposits.mjs` +
`.github/workflows/orphan-scan-deposit-check.yml` (Actions → Run workflow). The
repair itself is a separate owner-approved change.

**Known residual (deferred).** A classified receipt that books nothing because its
amount is RM0 (self-resolving: `depositRm` is then 0 too) or because cross-SO
receipt dedup skipped it (same receipt photo on two SOs — rare) still keeps a
header deposit. The reported case (receiptless scan) is fully closed; the dedup
edge needs post-booking reconciliation and is left for a follow-up.

**Lesson.** "Header field mirrors a ledger fact" holds only if EVERY writer books
the ledger row. `soPaidSen`'s whole no-double-count design leaned on that; a
second writer (scan) that stamped the header without the row re-opened it. When a
rollup reads `headerField unless a marker row exists`, audit every path that
writes the header for whether it also writes the marker.

**Ref.** fix/scan-so-deposit-double-count, 2026-09-10.

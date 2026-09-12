## The Performance P&L left the ledger's other income out [low]

<!-- area: Accounting + GL -->

**Symptom.** The Performance P&L (docs/bugs/0835) ran from gross profit
straight to the expenses: rent received, interest and the like — the
OTHER INCOMES and EXTRA-ORDINARY INCOME sections the standard P&L shows —
were nowhere on it, so its net read lower than the books by whatever the
month earned outside sales. Asked whether it should join, the owner
(2026-09-12): performance GL 要放 other income.

**Root cause.** A scope decision left open at 0835 (the owner had only
named sales, cost and expenses); not a defect in the arithmetic.

**Fix.** `backend/src/scm/routes/accounting-performance.ts` cuts the same
ledger read the expenses come from to the two other-income sections,
credit-positive, and hands them to `buildPerformanceReport`
(`backend/src/acc/performance-pnl.ts`), which answers `otherIncome` /
`otherIncomeSen` and nets gross profit + other income − operating expense −
other expenses. The summary lines in
`frontend/src/vendor/scm/lib/performance-report-queries.ts` show the income
rows and their total between gross profit and the operating expense, so the
screen, the CSV and the PDF all carry it; the notes say other income is as
booked, by journal date.

Pinned by `backend/tests/performanceReport.test.ts` (an in-range and an
out-of-range other-income entry; net), `frontend/src/vendor/scm/lib/performance-pnl-pdf.test.ts`
and `frontend/src/pages/scm-v2/PerformancePnl.test.tsx` (the rows, the total,
the net and the CSV).

**Ref.** acc/performance-other-income, 2026-09-12.

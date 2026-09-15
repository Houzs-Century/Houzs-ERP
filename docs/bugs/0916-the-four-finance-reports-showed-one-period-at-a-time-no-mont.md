## The four Finance reports showed one period at a time: no month-by-month view, no cumulative column, no % toggle [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, with a sample table beside the four
reports: 「然后我还有就是能看每个月的就类似这样每个月的」— the sample carried a
累计 column on the far left, the newest month next to it and older months to
the right, and a switch between amounts and %. Every report page drew one
period only: to compare July with August a person ran the report twice and
read across two screens.

**Root cause (traced).** Each page held one `useQuery` for one period
(`Reports.tsx`, `PerformancePnl.tsx`, `ReceiptsPayments.tsx`) and drew that
answer; nothing asked the same endpoint for several periods, and nothing
could lay two answers side by side, because a laid tree differs from period
to period (a category prints only when something under it did) and the
lines carried no ids to line them up by.

**Fix.** A monthly view every report page can switch to, computed from the
report's own endpoint — one request per column, so a month's figure can
never disagree with the single-period screen for the same month.

- `frontend/src/vendor/scm/lib/report-monthly.ts` (pure): `monthColumns`
  builds the columns — 累计 (the whole range) leftmost when the report has
  one, then the months newest → oldest; `pnlLines`, `balanceSheetLines`,
  `performanceLines`, `rpLines` turn each report's answer into the lines its
  screen prints (block titles, the laid tree by its node ids, totals, net),
  and `mergeColumns` unions the columns' lines by id, every line kept where
  its own column first had it, a cell left empty where a column never
  printed the line; `monthlyLinesAtLevel` folds by depth; `monthlyCsv`
  prints the table.
- `frontend/src/pages/scm-v2/MonthlyReport.tsx`: the view — latest month,
  3 / 6 / 12 months, RM / % toggle, L1..Ln, Export — and `ByMonthButton`,
  the switch each page wears. The balance sheet has no cumulative column: a
  month's column is the balance as at that month's end
  (`fetchBsColumn` asks `asOf` = the month's last day). The Performance
  P&L's lines are the groups' sales, cost and gross profit with their totals,
  then the summary the single-period screen draws (its lines now carry an
  `id`); Receipts & Payments shows the Total column of the ticked accounts
  (the ticks and the party toggle apply to every month); Print steps aside
  while the monthly view is on.

No backend change, no migration.

Proved RED on main's source (the seven source files stashed, the tests
kept): `frontend/src/vendor/scm/lib/report-monthly.test.ts` and
`frontend/src/pages/scm-v2/MonthlyReport.test.tsx` could not import;
`Reports.test.tsx`, `PerformancePnl.test.tsx` and `ReceiptsPayments.test.tsx`
found no By month button. Green after.

**Ref.** acc/report-monthly, 2026-09-15.

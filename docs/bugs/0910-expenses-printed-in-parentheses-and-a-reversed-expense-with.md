## Expenses printed in parentheses and a reversed expense with a minus inside them; the Performance P&L summary sat off its columns [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, reading the Performance P&L and the P&L:
「弄整齐可能 expense 的 column 和 gp 同一排，percentage 也是。然后 expense 可以不用
（）吗？因为本身就是费用，除非他当月是 ct 大过 debit 才（）」. On the Performance
P&L the summary under the groups (gross profit, other income, the computed
operating expense, the expenses as booked, net) was a second table whose
amount column did not line up with GROSS PROFIT and whose % sat in a note
column, not under GP %; every expense wore parentheses. On the P&L every
cost and expense line wore parentheses too, and a line reversed in the
period printed "(RM -1,139.19)" — a minus inside the brackets.

**Root cause (traced).** Two renderings of one convention. `Reports.tsx`
gave its cost, expense and taxation `Section`s a `negate` flag that wrapped
EVERY row in parentheses regardless of sign, and `fmtSen` spells a negative
as "RM -x", so a credit-balance expense came out doubly signed.
`performanceSummaryLines` negated the operating expense, every booked expense
and their total (`amountSen: -e.amountSen`) so `fmtPerf` would bracket them,
carried the % only as a free-text `note`, and the screen drew the lines in a
second table with its own three columns.

**Fix.** One rule on the four Finance reports (P&L, Balance Sheet,
Performance P&L, Receipts & Payments): a figure is the positive amount it is;
only a line whose credits beat its debits in the period — a reversal, the
closing-stock credit — prints in parentheses; a loss is a negative net and
reads the same way; never a minus inside the brackets.
`fmtSenParen` (`frontend/src/vendor/shared/format.ts`) carries it on the
standard statements: `Reports.tsx` lost the `negate` flag and formats every
row, total, gross, profit-before-tax, net and balance-sheet figure through
it. On the Performance P&L, `performanceSummaryLines`
(`vendor/scm/lib/performance-report-queries.ts`) keeps expenses as their
positive amounts and gives every line `pct` (its % of sales; gross profit
and net keep their own %); the screen (`PerformancePnl.tsx`) draws the
summary in the SAME table as the groups — the label across the three group
columns, the amount under Gross profit, the % under GP % — and the CSV and
the PDF (`performance-pnl-pdf.ts`) print `% of sales` as their third column.
Receipts & Payments already printed this way (no "RM", parentheses for a
negative) and is unchanged.

Proved RED on the unfixed tree: `Reports.test.tsx` (an expense plain, the
reversed line "(RM 15.00)", the closing-stock credit "(RM 100.00)", no
"(RM -" anywhere; a credit-side liability in parentheses),
`PerformancePnl.test.tsx` (the operating expense "800.00" with "15.3%" in
the fifth column, the label spanning three columns, the total other expenses
plain, the net "(44,080.00)" with "-842.8%"; the CSV's third column) and
`performance-pnl-pdf.test.ts` (every summary line's `pct`, expenses
positive).

**Ref.** acc/performance-tidy-and-signs, 2026-09-15.

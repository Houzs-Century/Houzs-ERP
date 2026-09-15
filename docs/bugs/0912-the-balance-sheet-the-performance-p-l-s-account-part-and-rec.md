## The Balance Sheet, the Performance P&L's account part and Receipts & Payments printed flat lists with no layout, no levels and no % on their lines [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, on the four Finance reports: 「关于这些 report 这边
我想要有 level，就是父子 account 分层」…「P&L, Balance Sheet, Performance P&L,
Receipt & Payment 都需要」…「balance sheet 也需要」(the %); on 2026-09-15 he said
做 for the queue and PR 1 (docs/bugs/0911) put the P&L on a layout. The other
three still printed flat: the Balance Sheet one account per line under
Assets / Liabilities / Equity with no %; the Performance P&L's lower part a
list of booked accounts under the computed operating expense; Receipts &
Payments one row per account with no way to group the rows into the big
groups the owner asked for on 2026-09-07 (showroom 费用 / operation 费用 …).

**Root cause (traced).** The layout engine (`backend/src/acc/report-layout.ts`)
knew ONE report — `ReportKey = 'pnl'` and one entry in `REPORT_BLOCKS` — and
one row per code with one amount: `layOutBlock` keyed its lines by code
(`new Map(lines.map((l) => [l.code, l]))`), so a control account by party
(two rows on one code) or a transfer (a row on another money account's
code) could not be laid out, and a row with a figure per money column had
nowhere to keep them. The three routes never asked for a layout, and the
three screens drew their own lists. A second defect surfaced on the way:
`validateLayout`'s id rule (`/^[A-Za-z0-9:_-]{1,64}$/`) refused the section
categories the default tree names after the section ("sec:SALES
ADJUSTMENTS", "sec:APPROPRIATION A/C"), so a P&L layout saved after any
edit was refused with "a category needs an id" whenever the chart had a
two-word section — the deployed PR 1 could not save 2990's default tree.

**Fix.**

- `backend/src/acc/report-layout.ts`: four report keys, each with its blocks
  — `balance_sheet` (assets / liabilities / equity by the section's TYPE, a
  section layer inside each), `performance` (otherIncome / expenses — the
  P&L's two), `rp` (ONE block, every section: the whole chart, laid out
  twice). A line carries an optional `key` (several rows under one code
  print together where the code sits), `label` (the row's own words) and
  `cells` (a figure per column, summed on a category — `LaidNode.cells`);
  `laidLineNode` is exported for a row that is no account. Category ids
  accept spaces, dots and slashes, and a test pins that the chart's own tree
  validates for every report.
- `balanceSheetReport` returns `layout` — each block on the tree for the
  active company, `baseSen` = total assets, % of total assets on every line
  of both sides (`accounting-reports.ts`).
- `performanceLayout` (`backend/src/acc/performance-pnl.ts`) lays the other
  income and the expenses on the report's tree; the computed operating
  expense is a line carrying the CODE of the account it replaces, so it
  prints exactly where the owner placed that account (under Unassigned,
  saying so, when the chart does not carry the code); its sentence
  (`operatingExpenseLabel`) has one home, read by screen, CSV and PDF.
  `accounting-performance.ts` returns it as `layout`.
- `rowsOnTree` (`backend/src/scm/routes/accounting-rp.ts`) lays each side's
  rows on the one tree — a coded row where its code sits (a control
  account's party rows together, a transfer where the other money account
  sits), the supplier-advance row after the tree — every row and category
  with its cells per money column, % of the side's total; returned as
  `layout.receipts` / `layout.payments`.
- Screens: the Balance Sheet (`frontend/src/pages/scm-v2/Reports.tsx`) on
  the tree with "% of total assets", L1..Ln, Layout; the Performance P&L
  (`frontend/src/pages/scm-v2/PerformancePnl.tsx`) draws its summary from
  the tree — `performanceSummaryLines` carries `depth` and a `category`
  kind, `summaryLinesAtLevel` folds by level, the total under the tree is
  "Total expenses (operating expense at N% + as booked)" since the computed
  line now sits inside the tree; CSV and PDF indent by depth; Receipts &
  Payments (`frontend/src/pages/scm-v2/ReceiptsPayments.tsx`) draws
  `LaidRows` with a figure per column (`ReportLayoutTree.tsx` gained
  `columns`, `fmt`, `onPick`), a category's figure opening every row under
  it (`leafKeys`), a % column of the side's total, L1..Ln, Layout; the
  printed table (`rp-report-pdf.ts`) is the tree. The editor
  (`ReportLayoutEditor.tsx`) names all four reports and gained Fold all /
  Unfold all for the chart-sized R&P tree.

No migration: `scm.acc_report_layouts` (docs/bugs/0911) already admits the
four keys.

Proved RED on main's source (the fifteen source files stashed, the tests
kept): 13 backend failures across `report-layout.test.ts`,
`reportLayouts.test.ts`, `accountingReports.test.ts`,
`performanceReport.test.ts`, `rpReport.test.ts` and 12 frontend failures
across `report-layout.test.ts`, `Reports.test.tsx`, `PerformancePnl.test.tsx`,
`performance-pnl-pdf.test.ts`, `ReceiptsPayments.test.tsx`,
`rp-report-pdf.test.ts`, `ReportLayoutEditor.test.tsx`; green after.

**Ref.** acc/report-layouts-2, 2026-09-15.

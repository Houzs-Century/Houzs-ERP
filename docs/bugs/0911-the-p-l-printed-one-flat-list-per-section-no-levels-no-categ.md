## The P&L printed one flat list per section: no levels, no categories of the owner's own, no % on most lines [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, over the P&L, the Balance Sheet, the
Performance P&L and Receipts & Payments: 「关于这些 report 这边我想要有 level，
就是父子 account 分层」…「我要能自己调动排版，然后能自己加大 categories」…「P&L 那边
不是每个 expense 都有 percentage」; asked whether one layout should serve the
companies together: 「做公用然后选要不要，类似 chart of account」. The P&L drew
each section as one flat list of accounts — 2990's Expenses is 198 codes
under 12 headers, three levels deep on the chart, printed as one column —
with no subtotal for a header, no way to group, order or name anything, and
a % only on the Performance P&L's summary lines.

**Root cause (traced).** `accounting-reports.ts` classified by section and
stopped: `lines(inSections(rows, …))` returned `{code, name, section,
amountSen}` per account and `Reports.tsx` printed the five lists as rows
under fixed titles. Nothing in the database or the route knew a level, a
category or a %, because the statements shipped as "numbers first, layout
later" (GL redesign item 6 — the owner's 样板 round was his to call, and he
called it on 2026-09-14).

**Fix.** A report LAYOUT — one tree of categories per report, shared by
every company, each category with a per-company tick — and the P&L drawn
on it. Presentation only: the chart's SECTION still decides which block an
account's money belongs to, so a layout groups, orders and names but never
moves a ringgit between gross profit and net.

- `backend/src/acc/report-layout.ts` (pure): `defaultLayout` builds the
  chart's own tree per block — a header account with children becomes a
  category named after it, leaves are lines, a block spanning two sections
  gets a category per section, a child whose parent sits in another section
  files as a root of its own section's block, an unsectioned row takes its
  type's default shelf; `validateLayout` checks and normalises a saved tree
  (version 1, the report's blocks only, unique ids and codes, names, depth
  ≤ 8) and names what is wrong; `layOutBlock` lays a block's figures on the
  tree for one company — a subtotal on every category, % of the base on
  every line, an empty category never prints, a category the company
  unticked is skipped with its subtree, and whatever the tree does not place
  goes under Unassigned at the foot, so the block's total is always the sum
  of what is printed.
- `scm.acc_report_layouts` (migration `20260915T0900_acc_report_layouts.sql`):
  one row per report, the tree as JSONB, no company column by design.
- `backend/src/scm/routes/accounting-report-layouts.ts`: `GET / PUT / DELETE
  /accounting/reports/layout?report=pnl` behind the statements' key
  (`scm.payment_voucher.post`); GET hands over the stored tree or the
  chart's, with the chart union the editor arranges and the companies the
  ticks name; a save carries another company's ticks through untouched and
  a caller cannot tick for a company outside their grants; a stored tree
  that no longer validates is ignored for the chart's, never a 500.
- `pnlReport` returns `layout` beside its flat lists (unchanged): each block
  on the tree, `baseSen` = sales, `stored`.
- Screen: `frontend/src/pages/scm-v2/Reports.tsx` draws the P&L on the tree
  through `frontend/src/pages/scm-v2/ReportLayoutTree.tsx` — a subtotal on
  every category, % of sales on every row and total, L1..Ln buttons and All
  — and the Layout button opens
  `frontend/src/pages/scm-v2/ReportLayoutEditor.tsx`: rename in place, add
  at the top of a block or under another category, delete (what it held
  moves up a level), drag or ↑ ↓, a tick per company, the block's unplaced
  accounts under Unassigned with Place, Save, Reset to chart; nothing
  reaches the server until Save. Hooks and the editor's pure operations:
  `frontend/src/vendor/scm/lib/report-layout.ts`.

Proved RED on the unfixed tree (the new source files set aside, the route
and page patches stashed): `backend/tests/accountingReports.test.ts` — the
P&L answered no `layout`; `frontend/src/pages/scm-v2/Reports.test.tsx` — no
"% of sales", no category subtotal, no level buttons, no Layout button;
`backend/tests/reportLayouts.test.ts`, `backend/src/acc/report-layout.test.ts`,
`frontend/src/vendor/scm/lib/report-layout.test.ts` and
`frontend/src/pages/scm-v2/ReportLayoutEditor.test.tsx` had nothing to
import. Green after.

**Ref.** acc/report-layouts, 2026-09-15.

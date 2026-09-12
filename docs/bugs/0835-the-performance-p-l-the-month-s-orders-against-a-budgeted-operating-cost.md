## The Performance P&L: the month's orders against a budgeted operating cost [medium]

<!-- area: Accounting + GL -->

**Symptom.** The standard P&L reads one source — the ledger — so it shows
revenue only once a final invoice posts (and, until 2026-09-12, none had), and
it shows operating cost only as far as the bookkeeper has booked it. The
owner runs the business on the ORDERS of the month: 我要多一份 performance
P&L，就是 sales 和 COGS 的数额是根据 sales order 的，expense 其他 remain，但是
expense 的 operating 要根据 sales 的 16% 来算 … 按 SO 日期 … 未送货也算，因为我
是看当月的表现 … 分成 bedframe, mattress, sofa, dining, accessory, service /
transport income … 根据 SO 明显的成本 … 16% 要设计成可调 … 只取代 900-O001，然后
在 performance P&L 要注明 … CSV, PDF, 每组显示 gross profit 和 %. Nothing on
the Reports tab answered that.

**Root cause.** Not a defect: no report read the sales orders as the sales
side, and nothing held an adjustable operating-expense rate per company.

**Fix.** `backend/src/acc/performance-pnl.ts` builds the report, pure: the
orders dated in the period (every status except DRAFT and CANCELLED,
delivered or not), each live line as the order records it — `total_sen` as
sales, `line_cost_sen` (unit cost × quantity) as cost — under BEDFRAME /
MATTRESS / SOFA / DINING / ACCESSORY / SERVICE by the line's group word or
its SVC- code, anything else under OTHERS so the total still ties to the
orders; a legacy header-only delivery fee counts as service, the way the
order's own totals count it. Operating expense is the company's rate of
sales excluding service (basis points, default 1600) IN PLACE OF the one
ledger account the company names (default `900-O001`): that account's
booked figure is shown and left out, every other EXPENSES-section account is
as the standard P&L reads it (`loadSums` / `sectionResolver`, now exported
from `backend/src/scm/routes/accounting-reports.ts`), posted and not
reversed, by journal date. A named account the chart does not carry replaces
nothing, and the report says so. The pair lives on
`scm.acc_company_settings` (migration
`backend/src/db/migrations-pg/20260912T1300_acc_performance_pnl_settings.sql`,
two defaulted columns). `backend/src/scm/routes/accounting-performance.ts`:
`GET /accounting/reports/performance?from&to` and
`POST /accounting/reports/performance/settings` (the financial-statements
permission). The Accounting page's Performance P&L tab
(`frontend/src/pages/scm-v2/PerformancePnl.tsx`, deep-linked from the Finance
sidebar's Reports group) shows a row per group with GP and %, the summary to
net, the notes saying what came from where and what the rate replaced, the
rate-and-account strip with Save, Export (CSV) and PDF
(`frontend/src/vendor/scm/lib/performance-pnl-pdf.ts`) — screen, CSV and PDF
all read the same pure lines in
`frontend/src/vendor/scm/lib/performance-report-queries.ts`. Nothing is
stored; the figures are computed on every read, so a cost filled in later on
an order shows the next time the tab opens.

Pinned by `backend/tests/performanceReport.test.ts` (groups from a world of
orders — cancelled and draft orders out, a cancelled line out, the header
fee as service, OTHERS; the rate in place of the named account; a reversed,
an unposted, an out-of-range and a cost-of-goods entry left out; the unknown
account replacing nothing; the settings round-trip; the refusals),
`frontend/src/vendor/scm/lib/performance-pnl-pdf.test.ts` (the tables and
notes as drawn) and `frontend/src/pages/scm-v2/PerformancePnl.test.tsx` (the
rows, the summary, the notes, Save, the CSV).

**Ref.** acc/performance-pl, 2026-09-12.

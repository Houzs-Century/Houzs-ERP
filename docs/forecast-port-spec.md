# Forecast module — port from Hookka ERP

Porting spec for the parts of Hookka's Forecast module that Houzs does not have yet. Written 2026-11-23, rechecked 2026-11-24 against Hookka `main` (commit bba1d75) and Houzs `main` (aff88a9); part 5 updated 2026-11-24 against Hookka `main` 3c5dd0c (#1578, #1581, #1585, #1586). Each rule below names the Hookka file and line it comes from, so the builder can open the reference instead of guessing.

## 中文摘要（给老板）

Houzs 9 月已经从 Hookka 搬过 **Forecast P&L**（`scm.acc_forecast_pnl`、`ForecastPnl.tsx`）和 **Dashboard 的 forecast 线**。这次要补的是 Hookka 之后做出来的五块：

| # | 要做的 | 用来看什么 |
|---|---|---|
| 1 | **Cash Flow forecast（每月三栏）**：Actual、Forecast（用还开着的单据，按期限）、P&L forecast（把 Forecast P&L 变成现金） | 未来几个月会收多少、付多少、银行会剩多少 |
| 2 | **Capex & financing 表**：12 个月，你填 capex、借款、还款 | 把非日常的大笔进出放进 forecast |
| 3 | **Trade finance 计划**：每个 facility 的额度、tenor、利率；供应商可勾"Can use trade finance"；已过完的月份用真实未付 PI，之后用 Forecast P&L | 哪个月要用 trade finance 付哪些供应商、额度够不够 |
| 4 | **Forecast Balance Sheet**：从上个月底的实际 BS 往后推 | 每个月底资产、负债、负债比率 |
| 5 | **Dashboard**：Cash Flow 卡的图和表跟着 tab（Operating / Investing / Financing / FCF）显示实际和两种 forecast；Detail 每月 Actual \| Forecast，按报表分组；Balance Sheet 卡和 Financial Ratios 卡：每个已过的月份都有「当时的预测」和差额（没有填 Forecast P&L 的月份显示「-」）；6 / 12 个月只看实际，From / To 选到未来才显示 (F) 预测 | 一眼对比实际和预测 |

另外 Houzs 的 Forecast P&L 现在**每个科目只能填一个数**，不能按客户、按供应商分；trade finance 和"按供应商期限付款"都要先补这一块（第 0 步）。

Houzs 和 Hookka 不一样、要你先决定的地方，在最后的「Owner decisions」。最大的三个：客户没有付款期限栏位；Houzs 的收款多数是 SO 订金和尾款；trade finance 目前只是一个银行户口名称，没有 facility 资料。

Hookka 的经验：forecast 每次要读很多个月的 aging，**一次要算 1–2 分钟**，所以一定要把算好的结果存起来（第 1 部分「Performance」）。

---

## 0. What Houzs already has (reuse, do not re-port)

- Forecast P&L storage `scm.acc_forecast_pnl (company_id, month, lines jsonb)` (`backend/src/db/migrations-pg/20260921T2200_acc_forecast_pnl.sql:23`), routes `GET/PUT /forecast`, `GET /forecast/figures` (`backend/src/scm/routes/accounting.ts:234-236`), logic `backend/src/scm/shared/forecast-pnl.ts` (mirrored in `frontend/src/vendor/shared`), page `ForecastPnl.tsx`.
- Dashboard forecast totals (`accounting-dashboard.ts:369` `forecastOf`, `acc/dashboard.ts`).
- Statement builders: P&L `buildPnl` (`accounting-reports.ts:305`), Balance Sheet `buildBalanceSheet` (`:395`), Cash Flow `/reports/receipts-payments` (`accounting-rp.ts`, user-editable tree `scm.acc_report_layouts`), AR/AP aging `/ar-aging`, `/ap-aging`.
- `scm.acc_bill_plans` — planned pay date per AP/purchase bill (`20261103T0700_acc_bill_plans.sql:17`): use it as the AP "expected month" where set.

**Missing in Houzs (checked 2026-11-23):** Houzs `acc_forecast_pnl.lines` is `account code → {bp} | {amtSen}` only (`backend/src/scm/shared/forecast-pnl.ts:26`); nothing per customer or per supplier. Hookka added after 2026-09-21: sales keyed per customer (`salesByCustomer`), material purchases keyed per supplier under each material, RM or % of sales (`purchasesByType`, `FcSupplierCell = number | {bp}`), salaries per department (`dept:` rows) — Hookka `src/lib/forecast-pnl.ts:15-37, 51-120, 441-470`; spec `docs/superpowers/specs/2026-11-10-forecast-suppliers-design.md`. **Step 0** of the build: purchases per supplier under each purchase account (needed by part 3 and by the P&L forecast's supplier terms); per customer is optional (needed only if receipts follow customer terms, D1/D2). Suggested storage, additive and nullable:
```sql
ALTER TABLE scm.acc_forecast_pnl
  ADD COLUMN suppliers jsonb NOT NULL DEFAULT '{}'::jsonb,  -- purchase account code → supplier id → {amtSen} | {bp}
  ADD COLUMN customers jsonb NOT NULL DEFAULT '{}'::jsonb;  -- customer id ("other" allowed) → {amtSen}
-- REVERSAL: ALTER TABLE scm.acc_forecast_pnl DROP COLUMN suppliers, DROP COLUMN customers;
```
Rule from Hookka: when a purchase account has supplier cells, its month amount **is** the sum of its suppliers (the account's own cell is superseded); a `{bp}` supplier cell is worked out against that month's forecast sales.

Conventions to keep (Houzs `CLAUDE.md`, `docs/modules/accounting.md`): money integer sen; new tables `scm.acc_*` with `company_id`, scoped by `companyScope.ts`; migrations in `backend/src/db/migrations-pg/` with `-- REVERSAL:`; reads `scm.payment_voucher.post`, writes `scm.payment_voucher.write`; charts are hand-drawn SVG (`DashboardChart.tsx`), no chart library; accounting is desktop-only.

Hookka stores forecast settings in a `kv_config` JSON row. **In Houzs use tables with `company_id`** (shapes below), because Houzs has two companies and `app_config` is global.

---

## 1. Cash Flow forecast — three columns per month

### What the owner sees
On the Cash Flow report, a Forecast switch. Each month then shows **Actual | Forecast | P&L forecast**; months after the current one show the two forecasts only. Rows and sections are the report's own tree. Bank b/f and c/f roll through each column.

Hookka reference: route `GET /api/accounting/cashflow-forecast` (`src/api/routes/accounting.ts:11917`), loader `loadCashflowForecast` (`:10992-11320`), pure logic `src/lib/cashflow-forecast.ts`, columns/rows types `src/lib/cashflow-engine.ts:353-488`. Specs: `docs/superpowers/specs/2026-11-08-cash-flow-forecast-design.md`, `2026-11-09-forecast-three-columns-design.md`.

### Columns
`__accum__`, then future months newest first (`fc:YYYY-MM` then `fp:YYYY-MM`), then each period month: `YYYY-MM` (actual), `fc:YYYY-MM`, `fp:YYYY-MM`. A month at or before the opening month is blank. Future months appear only when the period is the current month (`cashflow-engine.ts:466-488`).

**Houzs mapping:** Houzs's Cash Flow is a direct-method, user-editable tree (`acc_report_layouts`; categories `cf:in`, `cf:ops:*`, `cf:other-income`, `cf:tax`, `cf:finance`, `cf:funding:*`, `cf:transfers`). Forecast legs must land on **tree category ids**, not Hookka's fixed sections. Build a small map: forecast leg kind → category id (customer receipts → `cf:in`, supplier bills → the category their account sits in, salaries → its category, capex/loans → their account's category, trade finance → the `TF-AP` line / `cf:finance`). Keep the Deposit/Settlement and Card columns out of the forecast columns.

### Forecast column `fc:` — from open documents (Hookka `buildForecastLegs`, `cashflow-forecast.ts:764`)
- **Baseline per shown month** = the aging **as at the 1st of that month**; future months use the aging as at today (`accounting.ts:11007-11027`).
- **Expected month** of a document = document month + term months (`scheduleOpenDocs`, `:84`). Credits (advances, CNs) knock off the oldest expected lines of the same party; floored at 0.
- **Term text → months** (`parseTermMonths`, `:27`): `NETn` / `n days` → round(n/30); `n months` → n; COD/CASH → 0; blank or unknown → 1 and **flagged** (listed under the table).
- **Past due** at the baseline → counted in that month on an "Overdue (past term)" line (`docLegsForColumn`, `:154`).
- **Opening-period credits**: customer receipts dated up to opening month + 1 that are still unapplied pay invoices from before the system and are left out of the netting (`openingCreditCutoffYm` `:122`, `splitOpeningCredits` `:130`).
- **P&L lines in this column** (salaries, overheads, expenses) come from the Forecast P&L, scaled by that month's forecast receipts (ratio × receipts); overhead as keyed; salaries paid the month after; an RM line in a month with no sales as keyed (`accounting.ts:819-858` region of `buildForecastLegs`).
- **Planned payments**: unpaid plans expected by the 1st (Houzs: `acc_bill_plans.planned_on` overrides the bill's due month).

**Houzs mapping (needs owner decision D1, D2):**
- AR: Houzs customer money is mostly SO deposits and balances. Open AR = `mfg_sales_orders.balance_sen` (expected on the delivery / `processing_date`?) **plus** `sales_invoices` outstanding (`total_sen − paid_sen − so_deposit_applied_sen − credit_notes_sen`). `scm.customers` has **no terms column** (D1).
- AP: `purchase_invoices` and `ap_invoices` outstanding (`total_sen − paid_sen`), expected at `acc_bill_plans.planned_on` if set, else `due_date`, else invoice month + supplier `payment_terms`.
- An "aging as at a date" function is needed for past `fc:` columns. Hookka: `src/api/lib/aging-as-at.ts`. If Houzs aging cannot roll back, show `fc:` for the current and future months only (simpler first cut).

### P&L forecast column `fp:` — the Forecast P&L as cash (Hookka `buildPnlForecastLegs`, `:973`)
- **Sales**: a customer-keyed cell arrives after that customer's term ("Other" after 1 month). A month keyed as one total is spread by `receiptMix` = term mix of invoices in the **3 complete months before today** (DRAFT/CANCELLED excluded) (`accounting.ts:11033-11043`, `termMixOf` `:908`, `spreadByMix` `:916` largest remainder).
- **Materials**: supplier-keyed → after each supplier's term; otherwise spread by `materialMix(type)` = the last 3 months of PIs by that material, weighted by supplier term (`accounting.ts:11270-11281`).
- **Same month**: other income, carriage, SST, overheads, expenses. **Salaries the month after.**
- **Non-cash** lines (depreciation, amortisation, write-off, trade-finance interest) are left out and listed (`isNonCashAccount` `:222`, `forecastCashLines` `:231`).
- Horizon: at least the `fc:` last future month, at most 12 months (15 for trade-finance repayments).
- `sharedForecastLegs` (`:1079`) copies trade-finance, planned-payment and keyed-input legs from `fc:` into `fp:`.

**Houzs mapping (D2):** if the Houzs Forecast P&L keys sales as one total, the receipt mix should reflect SO deposit % + balance timing, not invoice terms. Option: deposit share in the order month, balance at delivery month (measure the split from the last 3 months of `mfg_sales_order_payments`).

### Performance — store the result (Hookka lesson, 2026-11-23)
Built afresh, Hookka's `/cashflow-forecast` read an aging as at the 1st of every shown month plus today's: measured on prod at **105 s** (the Forecast BS 55 s), past the browser's 30 s limit, so the forecast vanished from the pages. Fix (Hookka #1571): the result is kept as a stored copy keyed by the query (`reportSnapshot` → `accounting_report_snapshot`), served at once and rebuilt in the background when any source table moves (max `updated_at` + row count) or after 15 minutes; a page handed an older copy (`stale` in the body) asks again on a short schedule (`src/lib/stale-refresh.ts`); the two routes have no 30 s client cut-off (`NO_TIMEOUT_PATH`). After that: first build 107 s, then 3.3 s; Forecast BS 0.17 s. **Build Houzs's forecast routes cached from day one** (a `scm.acc_report_cache (company_id, cache_key, data jsonb, built_from, built_at)` or the existing caching Houzs reports use), with the source tables: invoices, receipts, purchase/AP invoices, payment vouchers, notes, bill plans, customers, suppliers, the forecast tables, journal lines.

### Tests to port (Hookka `tests/`)
`cashflow-forecast.test.mjs`, `cashflow-forecast-route.test.mjs`, `forecast-snapshot-cache.test.mjs`, `cashflow-engine-forecast.test.mjs`, `cashflow-forecast-ui.test.mjs`, `aging-as-at.test.mjs`, `aging-opening-receipts.test.mjs`. Port the pure-function cases as vitest.

---

## 2. Capex & financing inputs

- A popup from the Cash Flow toolbar: a table, every postable account the statement puts under CAPEX or Loan (not depreciation/amortisation) down, 12 months across from the current month. Amount + = money in, − = money out. Forecast only, nothing posted (`keyableAccounts` `:686`, `cleanKeyedInputs` `:702`, `keyedInputGroups` `:726`, `clearKeyedCode` `:745`; route `GET/PUT /cashflow-forecast-inputs` `accounting.ts:12227-12241`).
- Saving replaces the whole map; an account no longer CAPEX/Loan is refused (400) until cleared. In the forecast a keyed amount lands on its account in its month's `fc:` (and `fp:` via shared legs); past months keep what was keyed.

**Houzs table:**
```sql
CREATE TABLE scm.acc_forecast_inputs (
  company_id   integer NOT NULL REFERENCES public.companies(id),
  month        text    NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  account_code text    NOT NULL,
  amount_sen   bigint  NOT NULL CHECK (amount_sen <> 0),
  PRIMARY KEY (company_id, month, account_code)
);
-- REVERSAL: DROP TABLE scm.acc_forecast_inputs;
```
"Which accounts" = the accounts mapped under the tree's capex and funding/loan categories.

---

## 3. Trade finance plan

Hookka reference: `cashflow-forecast.ts:303-674`, route helpers `accounting.ts:11955-12105`, popup `src/pages/accounting/index.tsx` (`CfForecastInputsDialog`), facilities `src/api/lib/trade-finance.ts:24-91`. Specs: three-columns design §5; Hookka WORK-TRACKER 2026-11-23 entries.

### Facility master (new in Houzs — D3)
Houzs only recognises trade finance by account name (`/TRADE\s*FINANCE/`, `accounting-rp.ts:161-164`).
```sql
CREATE TABLE scm.acc_tf_facilities (
  company_id     integer NOT NULL REFERENCES public.companies(id),
  account_code   text    NOT NULL,            -- the TF liability / bank account
  lender_name    text    NOT NULL,
  tenor_days     integer NOT NULL DEFAULT 90 CHECK (tenor_days BETWEEN 1 AND 400),
  limit_sen      bigint,                      -- null = no limit set
  PRIMARY KEY (company_id, account_code)
);
```
**Draws** (needed for "owed now", the default rate, and repayments of existing draws): each credit to the facility account is a draw; its due date and interest come from the document that recorded it. Hookka derives draws from the ledger (`loadTfDraws`, `src/api/lib/trade-finance.ts`) with per-draw due date, interest and bank charge. Houzs needs an equivalent (D3).

### Plan store
```sql
CREATE TABLE scm.acc_tf_plans (
  company_id   integer NOT NULL,
  account_code text    NOT NULL,
  tenor_days   integer,          -- null = facility default
  rate_bp      integer,          -- null = default (below); 0–10000
  months       jsonb   NOT NULL DEFAULT '{}',  -- "YYYY-MM" → principal sen (typed, or saved result of ticks)
  ticks        jsonb,            -- legacy manual ticks: "YYYY-MM" → supplier ids
  off          jsonb   NOT NULL DEFAULT '{}',  -- months unticked by hand: "YYYY-MM" → supplier ids
  PRIMARY KEY (company_id, account_code)
);
```
Cleaning rules (`cleanTfPlans` `:337`): tenor 1–400, rate 0–10000 bp, months `YYYY-MM`, positive whole sen, facility must exist, ids trimmed ≤100 chars, ≤500 per month.

### Supplier eligibility
`ALTER TABLE scm.suppliers ADD COLUMN tf_eligible boolean NOT NULL DEFAULT false;` — follow the `for_purchasing` precedent: add to `SUPPLIER_FINANCE_COLUMNS` / `_BODY_KEYS` (`backend/src/scm/shared/supplier-finance-fields.ts:23-30`), the column constants (`routes/suppliers.ts:129`), and a checkbox "Can use trade finance" in `SupplierMaintenance.tsx:353-415`.

### Rules
- **Dues per supplier and month** (`tfSupplierDues`, `accounting.ts:11992`):
  - purchase month **already ended** → that supplier's **unpaid** bills (AP aging outstanding; advances/credits excluded), due at bill month + supplier term; past due → current month (`tfActualDueBySupplier` `:541`);
  - **current month and later** → Forecast P&L supplier cells, due by supplier term; "Other" supplier excluded (`tfForecastDueBySupplier` `:509` with `firstPurchaseYm = current month`);
  - merged (`tfMergeDues`).
- **Ticks**: with any eligible supplier, every eligible supplier is ticked in every month it has an amount, except months in `off` (`tfAutoTicks` `:576`). Untick a cell → add to `off`; tick again → remove. Name checkbox: all off / all on (`tfToggleOffRow`). A month that comes into view later is ticked automatically. With no eligible supplier, the old manual flow works (typed amounts, "Fill from bills", "Fill from Forecast P&L" + manual ticks).
- **Drawdown per month** (`planTfFill` `:469`, `tfTickedPlan` `:669`): ticked dues, as far as the limit allows **after that month's repayments**; the part over the limit is reported ("Over the limit: Dec'26 RM x — not drawn; the bank pays that part"). The **current month's cell = what this adds + what is already drawn this month** (show "*" and "includes RM x already drawn").
- **Interest** per draw = principal × rate_bp / 10000 (`tfInterestSen` `:371`). **Default rate** = average of the last 6 draws' interest ÷ principal, scaled to the tenor (`defaultTfRateBp` `:375`).
- **Repayment month** = draw month + round(tenor/30) (`tfRepayYm` `:369`), principal + interest. Existing draws repay at their own due dates (past due → current month).
- **Legs** (`tfPlanLegs` `:397`): drawdown + on the facility; interest − on the TF interest account and + "Interest charged by <lender>" on the facility (cash nets 0 in the draw month); repayment − a tenor later. In `fc:` a past month's plan repays nothing and the current month repays only the part not yet drawn; in `fp:` every plan repays in full.
- **Recompute on every load**: current month and later are worked out from today's figures and ticks; months before the current one keep what was saved (`accounting.ts:11221-11255`).
- **Popup display**: per facility — Tenor, Interest % per draw, Owed today, Drawn this month; tick grid rows = eligible suppliers (name + term), cells = due amount with a checkbox; **cells from real unpaid bills shaded blue**, Forecast P&L cells beige, unticked lighter; legend row; computed rows Interest (est.), Repayment, Owed at month end, Room left (limit x).

### Tests to port
`tf-supplier-flag-actual-bills.test.mjs`, `tf-forecast-ticks.test.mjs`, `tf-fill-from-forecast.test.mjs`.

---

## 4. Forecast Balance Sheet

Hookka reference: `GET /api/accounting/bs-forecast` (`accounting.ts:12109`), `src/lib/forecast-bs.ts`, page `src/pages/accounting/monthly-balance-sheet.tsx:105-156`.

- **Start** = the actual Balance Sheet at the last month-end. **Months** = current month to the last month the Forecast P&L has figures for.
- **Each month = double entries** (`forecastBsDeltas` `:94`; every month sums to 0):
  - Forecast P&L accruals: sales Dr AR / Cr profit; materials Dr profit / Cr AP; salaries Dr profit / Cr salary accrual, paid the next month; non-cash Dr profit / Cr accumulated depreciation.
  - Money by the **P&L forecast's timing** (`fp:` legs): receipts settle AR, materials settle AP, trade-finance legs settle **the facility account**, other costs settle profit.
  - Open documents at the start (bills, other debtors, existing TF draws) when due.
  - Capex & financing inputs on their accounts.
  - Customers' open invoices at the start collected by expected month, **capped at the trade debtors on the start sheet** (earliest months dropped first) (`openingReceiptsByYm` `:198`, `capOpeningReceipts` `:212`).
  - Salary accrual owed at the start paid in the first month.
- **View** (`forecastBsView` `:269`): profit on "Current Year Earnings"; cash moves the bank group's total; depreciation moves fixed assets' total; each bank account, stock line and fixed asset shows "—" in forecast columns.
- Forecast P&L trade-finance interest (if keyed) is owed to the facility, not depreciation; with a plan, the plan's interest stands for it.

**Houzs mapping (D4):**
- Use `buildBalanceSheet(asOf = last month-end)` as the start.
- Houzs has **no year-end close**: earnings on the sheet are all-time income − expenses + stock movement (`accounting-reports.ts:421-427`). Forecast profit adds to that line.
- Stock: Houzs is periodic; the current month's closing stock is provisional. Keep stock flat in the forecast (Hookka does: "what it buys is used in the month").
- Customer deposits on SOs are a liability in Houzs (check the account): forecast SO deposits received → Cr deposits; at delivery → Dr deposits / Cr sales.

### Tests to port
`forecast-bs.test.mjs`, `bs-monthly.test.mjs` (forecast parts).

---

## 5. Dashboard

Hookka reference: `src/lib/dashboard-forecast.ts`, `src/lib/cashflow-card.ts`, `src/pages/finance-dashboard.tsx` (#1568, #1569).

- **Cash Flow card — everything follows the tab picked** (Operating / Investing / Financing / Free cash flow; Hookka #1572): the chart's solid line is the tab's actual, its two dashed lines that tab's **forecast (P&L)** from `fp:` and **forecast (documents)** from `fc:`, named by the tab ("Operating forecast (P&L)"); the table's forecast rows carry the same names and figures, plus vs each (actual − forecast). Money in / out bars and the Net change row stay overall. (Hookka first drew the forecast NET beside a tab's table rows; the owner saw different numbers above and below — keep chart and table on the same figure.)
  - Split (`cashFlowCardMonth`): operating = "Net operation surplus" result; investing = CAPEX lines; financing = trade finance + loan + deposit + finance cost lines; free cash flow = operating + investing. **Houzs:** map from tree categories (`cf:ops*`, `cf:funding*`, `cf:finance`, capex category).
- **Balance Sheet card**: periods ahead from the Forecast Balance Sheet — total assets (fixed + current), total liabilities (current + long-term), debt to assets %; bars faded; header "Dec 2026 (F)"; a note under the table.
  - **This month beside its forecast** (Hookka #1573): the month that has happened and that the Forecast Balance Sheet also covers gets rows Forecast total assets / liabilities / debt to assets and vs Forecast (assets / liabilities) = actual − forecast. By month only (a quarter's forecast is its last month-end). A month to date (`*`) is noted: its forecast is the month-end, so the gap closes as the month runs.
  - **Past months beside a back-calculated forecast** (Hookka #1578, #1581; owner chose back-calculating over keeping month-end copies): each shown past month is worked out **as it would have been then** — `GET /bs-forecast?start=YYYY-MM` runs the same Forecast Balance Sheet for that one month with "today" set to its 1st: start = the month-end before it, documents open at its 1st, receipt / material mixes from the three months before it, that month's Forecast P&L (`accounting.ts:12130-12182`). The page asks for the past months **one at a time** (each a stored copy on the server), and adds the month-end before it from `/pl?period=` as the start sheet (`finance-dashboard.tsx:792-823`). **A past month with no Forecast P&L figures gets no forecast ("-")** (`pastHasPnl`, `accounting.ts:12181`): without one only its bills would move the sheet, never its sales, and the figure read ~RM 327k low on Hookka's July. Note under the table: "A past month's forecast is worked out from the month-end before it with that month's Forecast P&L."
- **Financial Ratios card** (Hookka #1586, #1585): the six ratios — gross margin, net margin, current ratio, quick ratio, ROE, ROA — get a forecast with **the same formulas as the actual ones** (`dashForecastRatios`, `dashboard-forecast.ts:258`): margins from the Forecast P&L (sales, gross, net); current / quick ratio from the Forecast Balance Sheet's current assets, current liabilities and stock (`bsTotals` `:49` splits them as the dashboard route does: sections, 330-x = stock; equity = assets − liabilities); ROE / ROA = forecast net ÷ forecast equity / assets. A ratio with nothing to divide by (or equity ≤ 0 for ROE) is "-". (F) periods show the forecast ratio as faded bars; a month that has happened gets a **Forecast** row, a **vs Forecast** row (actual − forecast, in points) and a dashed Forecast line, months only, from that month's Forecast P&L and its Forecast Balance Sheet (this month's, or the past month's back-calculated above) (`finance-dashboard.tsx:999-1015`). Expect ROE to swing wildly when forecast equity is tiny (Hookka Aug: equity ~RM 1.1k → −636%) — the formula is right, the ratio just carries little meaning there.
- **Cash Flow Detail** (Hookka #1570, #1572): its own table — sections in the Cash Flow statement's order, each period **Actual | Forecast** (two sub-columns, as the cost-structure tables); a switch "Forecast from: Forecast P&L | Open documents" (P&L by default). **A section opens to the statement's own groups first** (Raw Materials → PURCHASE - FABRIC / WOODEN / FILLER / OTHERS / PACKING MATERIALS), then a group to its lines: the actuals, the P&L forecast and the Docs forecast name their lines differently (item-group codes, material types, "Opening creditors — <supplier>"), so only the group lines Actual up with Forecast; inside a group, the actuals' lines first, then the forecast's, then the per-party catch-alls; lines the statement does not place go under "Other" (`dashCashLineGroups`, `cashDetailSections`). Row names left-aligned. **Houzs:** the groups are the Cash Flow tree's own sub-categories (`acc_report_layouts`).
- **Which periods show** (Hookka #1586, owner-approved design, replaces the earlier "add periods ahead"): the rolling **6 / 12 months show actual figures only**, up to the current month; future periods show only when the From / To range reaches them, then **every card** shows them as forecast "(F)": "Dec 2026 (F)" (`dashPeriods`, `finance-chart-look.ts:104-116`). A banner says the mode: "Actual · live", "Forecast" or "Actual + Forecast". **Fade the forecast bars** (Hookka #1570 had to fix a bar shape that dropped the fade — check the faded bars actually render). Show "Loading forecast…" until the forecasts arrive. Quarter: cash sums its months; balance sheet reads its last month-end. Income card unchanged.
- Houzs charts are SVG: add a dashed `<path>` per forecast series and an opacity per bar.

### Tests to port
`dashboard-forecast.test.mjs` (incl. past months, the no-Forecast-P&L rule and the forecast ratios) (also pins the period rule, `dashPeriods`).

---

## Build order

1. Forecast P&L per-supplier purchases (step 0 above; per-customer sales if D1/D2 need it).
2. Cash Flow forecast `fp:` column only (needs no aging roll-back), with the category map — **cached from the first PR** (Performance).
3. Capex & financing inputs.
4. `fc:` column (current + future first; past months once aging-as-at exists).
5. Trade finance: facility master + draws, supplier flag, plan, popup.
6. Forecast Balance Sheet.
7. Dashboard: forecast lines and (F) periods, then this month vs forecast, then past months back-calculated, then Financial Ratios.

One PR per step, each with ported tests and a read-only check on production against the Hookka-style numbers described above.

## Owner decisions (before building)

- **D1 — Customer terms.** `scm.customers` has no payment term. Options: (a) add `credit_terms` text like suppliers; (b) one company-wide default (e.g. COD for retail, NET30 for dealers); (c) derive from history (average days invoice → payment over 3 months). Recommended: (a) with (c) as the default when blank.
- **D2 — Receipts timing.** Houzs customer money is SO deposit + balance. Forecast receipts as: deposit share in the order month, balance in the delivery month (shares measured from the last 3 months)? Or by invoice terms only?
- **D3 — Trade finance facilities.** Which lenders, limits, tenors; how a draw's due date and interest are recorded today (PV purpose? a JV?). Without this, part 3 has no "owed now".
- **D4 — Customer deposits on the Forecast Balance Sheet.** Confirm the deposits liability account and that delivery releases it.
- **D5 — Companies.** Forecast per company (Houzs, 2990) only, or a combined view too?

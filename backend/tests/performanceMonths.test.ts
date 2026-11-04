/* The Performance P&L's months, for its chart (the owner's Claude Design,
   batch 6 read c6): GET /accounting/reports/performance/months?from&to.
   Pinned on the real handlers over fake PostgREST (fakeSb):
     • each month's figures are the full report's for that month — the same
       builder: sales, cost of sales, gross profit and its %, other income,
       expenses (operating expense at the rate + as booked), net and its %;
     • the window's orders and their lines are read ONCE, not once a month;
     • a range not written YYYY-MM, a reversed one or one past 24 months is
       refused; the permission gate answers at this end. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { monthsBetween, performanceMonthsHandler, performanceReport } from '../src/scm/routes/accounting-performance';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';

const so = (docNo: string, date: string, status: string): Row => ({ company_id: CO, doc_no: docNo, so_date: date, status, delivery_fee_sen: null });
let lineNo = 0;
const line = (docNo: string, group: string, code: string, qty: number, totalSen: number, unitCostSen: number): Row => ({
  id: `line-${String(++lineNo).padStart(3, '0')}`, company_id: CO, doc_no: docNo, item_group: group, item_code: code,
  qty, total_sen: totalSen, unit_cost_sen: unitCostSen, line_cost_sen: qty * unitCostSen, cancelled: false,
});
const gl = (code: string, name: string, type: string, date: string, dr: number, cr: number): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, entry_date: date, debit_sen: dr, credit_sen: cr, posted: true, reversed: false,
});
const acct = (code: string, name: string, type: string, section: string): Row => ({ company_id: CO, account_code: code, account_name: name, account_type: type, section, is_active: true });

function harness(perms: readonly string[] = [GL_PERM]) {
  lineNo = 0;
  const sb = fakeSb({
    mfg_sales_orders: [
      so('SO-1', '2026-07-02', 'CONFIRMED'),
      so('SO-2', '2026-07-20', 'CANCELLED'),
      so('SO-3', '2026-08-05', 'DELIVERED'),
      so('SO-4', '2026-09-30', 'CONFIRMED'),
    ],
    mfg_sales_order_items: [
      line('SO-1', 'sofa', 'SOFA-L3', 1, 300000, 180000),
      line('SO-1', 'service', 'SVC-DELIVERY', 1, 15000, 0),
      line('SO-2', 'sofa', 'SOFA-L3', 1, 999900, 1),
      line('SO-3', 'mattress', 'MAT-Q', 2, 200000, 60000),
      line('SO-4', 'dining', 'DIN-6', 1, 40000, 25000),
    ],
    v_gl_entries: [
      gl('900-O001', 'OPERATIING EXPENSE', 'EXPENSE', '2026-07-31', 243550, 0),
      gl('900-R048', 'RENTAL OF SHOWROOM', 'EXPENSE', '2026-07-05', 450000, 0),
      gl('900-R048', 'RENTAL OF SHOWROOM', 'EXPENSE', '2026-08-05', 450000, 0),
      gl('590-0000', 'RENT RECEIVED', 'INCOME', '2026-08-15', 0, 50000),
    ],
    accounts: [
      acct('590-0000', 'RENT RECEIVED', 'INCOME', 'OTHER INCOMES'),
      acct('900-O001', 'OPERATIING EXPENSE', 'EXPENSE', 'EXPENSES'),
      acct('900-R048', 'RENTAL OF SHOWROOM', 'EXPENSE', 'EXPENSES'),
    ],
    acc_company_settings: [],
    acc_report_layouts: [],
  });
  /* Count the reads per table, to pin "the window's orders read once". */
  const reads: Record<string, number> = {};
  const counted = { ...sb, from: (t: string) => { reads[t] = (reads[t] ?? 0) + 1; return sb.from(t); } };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, counted as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/reports/performance', performanceReport as never);
  app.get('/accounting/reports/performance/months', performanceMonthsHandler as never);
  return { app, reads };
}

type Month = { month: string; from: string; to: string; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null; otherIncomeSen: number; expensesSen: number; netSen: number; netPct: number | null };

describe('GET /accounting/reports/performance/months', () => {
  test('each month is the full report for that month: sales, cost, gross profit, other income, expenses, net', async () => {
    const { app } = harness();
    const res = await app.request('/accounting/reports/performance/months?from=2026-07&to=2026-09');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: string; to: string; months: Month[] };
    expect(body.months.map((m) => [m.month, m.from, m.to])).toEqual([
      ['2026-07', '2026-07-01', '2026-07-31'], ['2026-08', '2026-08-01', '2026-08-31'], ['2026-09', '2026-09-01', '2026-09-30'],
    ]);
    for (const m of body.months) {
      const full = (await (await app.request(`/accounting/reports/performance?from=${m.from}&to=${m.to}`)).json()) as {
        totals: { salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null };
        otherIncomeSen: number; otherExpensesSen: number; operatingExpense: { amountSen: number }; netSen: number; netPct: number | null;
      };
      expect(m).toEqual({
        month: m.month, from: m.from, to: m.to,
        salesSen: full.totals.salesSen, cogsSen: full.totals.cogsSen, gpSen: full.totals.gpSen, gpPct: full.totals.gpPct,
        otherIncomeSen: full.otherIncomeSen, expensesSen: full.operatingExpense.amountSen + full.otherExpensesSen,
        netSen: full.netSen, netPct: full.netPct,
      });
    }
    /* July by hand: the cancelled order left out; 16% of sales excluding service in place of 900-O001. */
    expect(body.months[0]).toMatchObject({ salesSen: 315000, cogsSen: 180000, gpSen: 135000, expensesSen: 48000 + 450000, netSen: 135000 - 498000 });
  });

  test('the window\'s orders and their lines are read once, not once a month', async () => {
    const { app, reads } = harness();
    await app.request('/accounting/reports/performance/months?from=2026-07&to=2026-09');
    expect(reads.mfg_sales_orders).toBe(1);
    expect(reads.mfg_sales_order_items).toBe(1);
  });

  test('a range not in months, reversed or past 24 months is refused; the gate answers here', async () => {
    const { app } = harness();
    for (const qs of ['from=2026-07-01&to=2026-09-30', 'from=2026-09&to=2026-07', 'from=2026-13&to=2027-01', 'from=2024-01&to=2026-01']) {
      expect((await app.request(`/accounting/reports/performance/months?${qs}`)).status).toBe(400);
    }
    expect((await harness([]).app.request('/accounting/reports/performance/months?from=2026-07&to=2026-07')).status).toBe(403);
  });

  test('monthsBetween walks across a year end', () => {
    expect(monthsBetween('2026-11', '2027-02').map((m) => [m.month, m.to])).toEqual([
      ['2026-11', '2026-11-30'], ['2026-12', '2026-12-31'], ['2027-01', '2027-01-31'], ['2027-02', '2027-02-28'],
    ]);
  });
});

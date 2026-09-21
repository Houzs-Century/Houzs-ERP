/* The Forecast P&L's doors (owner 2026-09-21). Pinned: the accounts a line may
   name are the P&L's active leaves, sectioned as the statement sections them;
   the grid round-trips as jsonb rows, one per month; a whole-grid PUT removes
   the months it no longer carries; the first bad cell is named and nothing is
   kept; the figures endpoint applies the shared arithmetic per month; the
   blocks are the statement's own; the keys are the statements' read key and
   the vouchers' write key. Same fake-PostgREST harness as accountingReports. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { forecastFiguresHandler, forecastGetHandler, forecastPutHandler } from '../src/scm/routes/accounting-forecast';
import { FORECAST_BLOCKS } from '../src/scm/shared/forecast-pnl';
import { REPORT_BLOCKS } from '../src/acc/report-layout';

const CO = 2;
const acc = (code: string, name: string, type: string, section: string | null, over: Row = {}): Row =>
  ({ company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, section, is_active: true, ...over });
const ACCOUNTS: Row[] = [
  acc('310-0010', 'BANK', 'ASSET', 'CURRENT ASSETS'),                                   // a balance-sheet account: not a forecast line
  acc('500-0000', 'SALES', 'INCOME', 'SALES'),                                          // a header: not a line
  acc('500-0003', 'SALES OF SOFA', 'INCOME', 'SALES', { parent_code: '500-0000' }),
  acc('500-0001', 'SALES OF BEDDING', 'INCOME', 'SALES', { parent_code: '500-0000' }),
  acc('520-0000', 'DISCOUNT ALLOWED', 'INCOME', 'SALES ADJUSTMENTS'),
  acc('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('615-0000', 'CARRIAGE INWARDS', 'EXPENSE', null),                                 // unsectioned: the default shelf for a 6xx expense
  acc('590-0000', 'RENT RECEIVED', 'INCOME', 'OTHER INCOMES'),
  acc('900-T003', 'TRANSPORT', 'EXPENSE', 'EXPENSES'),
  acc('900-X999', 'RETIRED', 'EXPENSE', 'EXPENSES', { is_active: false }),              // inactive: not a line
  acc('950-0000', 'TAXATION', 'EXPENSE', 'TAXATION'),
];

function harness(perms: string[] = ['scm.payment_voucher.post', 'scm.payment_voucher.write'], rows: Row[] = []) {
  const sb = fakeSb({ accounts: ACCOUNTS.map((r) => ({ ...r })), acc_forecast_pnl: rows.map((r) => ({ ...r })), acc_report_layouts: [] });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990', name: '2990 Home' }] as never);
    await next();
  });
  app.get('/accounting/forecast', forecastGetHandler as never);
  app.put('/accounting/forecast', forecastPutHandler as never);
  app.get('/accounting/forecast/figures', forecastFiguresHandler as never);
  return { app, sb };
}
const put = (app: Hono, body: unknown) => app.request('/accounting/forecast', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const OCT = { '500-0003': { amtSen: 8_000_000 }, '500-0001': { amtSen: 2_000_000 }, '601-0003': { bp: 5500 }, '615-0000': { amtSen: 100_000 }, '900-T003': { bp: 120 }, '950-0000': { bp: 300 } };
const NOV = { '500-0003': { amtSen: 9_000_000 }, '601-0003': { bp: 5500 } };

describe('the blocks are the statement\'s own', () => {
  test('FORECAST_BLOCKS names the P&L\'s blocks and sections exactly — one home, two copies, one referee', () => {
    expect(FORECAST_BLOCKS.map((b) => ({ key: b.key, sections: [...b.sections] }))).toEqual(REPORT_BLOCKS.pnl.map((b) => ({ key: b.key, sections: [...b.sections] })));
  });
});

describe('GET /accounting/forecast', () => {
  test('hands back the P&L\'s active leaf accounts, sectioned, and an empty grid with the chart\'s own layout', async () => {
    const { app } = harness();
    const res = await app.request('/accounting/forecast');
    expect(res.status).toBe(200);
    const b = await res.json() as { months: Record<string, unknown>; accounts: Array<{ code: string; section: string; name: string }>; layout: { stored: boolean; blocks: Record<string, unknown[]> } };
    expect(b.months).toEqual({});
    expect(b.accounts.map((a) => [a.code, a.section])).toEqual([
      ['500-0001', 'SALES'], ['500-0003', 'SALES'], ['520-0000', 'SALES ADJUSTMENTS'], ['590-0000', 'OTHER INCOMES'],
      ['601-0003', 'COST OF GOODS SOLD'], ['615-0000', 'COST OF GOODS SOLD'], ['900-T003', 'EXPENSES'], ['950-0000', 'TAXATION'],
    ]);
    expect(b.layout.stored).toBe(false);
    expect(Object.keys(b.layout.blocks).sort()).toEqual(['costOfSales', 'expenses', 'otherIncome', 'taxation', 'tradingIncome']);
  });

  test('reading needs the statements\' key', async () => {
    const { app } = harness(['scm.payment_voucher.write']);
    expect((await app.request('/accounting/forecast')).status).toBe(403);
  });
});

describe('PUT /accounting/forecast', () => {
  test('stores one row per month, reads back the same cells, and a later PUT without a month removes it', async () => {
    const { app, sb } = harness();
    const saved = await put(app, { months: { '2026-11': NOV, '2026-10': OCT } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, months: { '2026-10': OCT, '2026-11': NOV }, removed: [] });
    const rows = sb.tables.acc_forecast_pnl as Row[];
    expect(rows.map((r) => [r.company_id, r.month, r.updated_by])).toEqual([[CO, '2026-10', 'Chew'], [CO, '2026-11', 'Chew']]);
    expect(rows[0]!.lines).toEqual(OCT);

    const read = await (await app.request('/accounting/forecast')).json() as { months: Record<string, unknown> };
    expect(read.months).toEqual({ '2026-10': OCT, '2026-11': NOV });

    /* November edited, October gone. */
    const again = await put(app, { months: { '2026-11': { ...NOV, '900-T003': { amtSen: 150_000 } } } });
    expect(await again.json()).toMatchObject({ ok: true, removed: ['2026-10'] });
    expect((sb.tables.acc_forecast_pnl as Row[]).map((r) => r.month)).toEqual(['2026-11']);
    expect((sb.tables.acc_forecast_pnl as Row[])[0]!.lines).toEqual({ ...NOV, '900-T003': { amtSen: 150_000 } });
    /* An added month with nothing keyed yet is still a month. */
    const empty = await put(app, { months: { '2026-11': NOV, '2026-12': {} } });
    expect(empty.status).toBe(200);
    expect((sb.tables.acc_forecast_pnl as Row[]).map((r) => r.month)).toEqual(['2026-11', '2026-12']);
  });

  test('refuses the first bad cell by name and keeps nothing: a header, a balance-sheet account, an inactive account, a percent on a sales line, both keyed, a fraction', async () => {
    const { app, sb } = harness();
    const cases: Array<[unknown, string]> = [
      [{ '2026-10': { ...OCT, '500-0000': { amtSen: 1 } } }, '2026-10 500-0000'],
      [{ '2026-10': { ...OCT, '310-0010': { amtSen: 1 } } }, '2026-10 310-0010'],
      [{ '2026-10': { ...OCT, '900-X999': { bp: 1 } } }, '2026-10 900-X999'],
      [{ '2026-10': { ...OCT, '500-0001': { bp: 1000 } } }, '2026-10 500-0001 percent'],
      [{ '2026-10': { ...OCT, '601-0003': { bp: 1, amtSen: 1 } } }, '2026-10 601-0003'],
      [{ '2026-10': { ...OCT, '900-T003': { amtSen: 1.5 } } }, '2026-10 900-T003 amount'],
      [{ 'Oct-2026': OCT }, 'Oct-2026'],
    ];
    for (const [months, cell] of cases) {
      const res = await put(app, { months });
      expect(res.status, JSON.stringify(months)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_cell', cell });
    }
    expect(sb.tables.acc_forecast_pnl).toEqual([]);
    expect((await put(app, { months: [] })).status).toBe(400);
  });

  test('writing needs the vouchers\' write key', async () => {
    const { app } = harness(['scm.payment_voucher.post']);
    expect((await put(app, { months: { '2026-10': OCT } })).status).toBe(403);
  });
});

describe('GET /accounting/forecast/figures', () => {
  test('applies the shared arithmetic month by month inside the range — sales as keyed, percents of the forecast sales, the P&L\'s totals', async () => {
    const { app } = harness(undefined, [
      { company_id: CO, month: '2026-10', lines: OCT },
      { company_id: CO, month: '2026-11', lines: NOV },
      { company_id: CO, month: '2026-12', lines: {} },
      { company_id: 1, month: '2026-10', lines: { '500-0003': { amtSen: 1 } } },   // another company's: never read
    ]);
    const res = await app.request('/accounting/forecast/figures?from=2026-10&to=2026-11');
    expect(res.status).toBe(200);
    const b = await res.json() as { months: Array<{ month: string; salesSen: number; lines: Array<{ code: string; amountSen: number; bp: number | null }>; totals: Record<string, number> }> };
    expect(b.months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    const oct = b.months[0]!;
    expect(oct.salesSen).toBe(10_000_000);
    expect(oct.lines.map((l) => [l.code, l.amountSen, l.bp])).toEqual([
      ['500-0001', 2_000_000, 2000], ['500-0003', 8_000_000, 8000], ['601-0003', 5_500_000, 5500], ['615-0000', 100_000, 100], ['900-T003', 120_000, 120], ['950-0000', 300_000, 300],
    ]);
    expect(oct.totals).toEqual({
      tradingIncomeSen: 10_000_000, costOfSalesSen: 5_600_000, grossProfitSen: 4_400_000, otherIncomeSen: 0,
      expensesSen: 120_000, profitBeforeTaxSen: 4_280_000, taxationSen: 300_000, netProfitSen: 3_980_000,
    });
    expect(b.months[1]!.totals.grossProfitSen).toBe(4_050_000);
    /* An empty month inside the range is a month of zeros; a bad range is a 400. */
    const dec = await (await app.request('/accounting/forecast/figures?from=2026-12&to=2026-12')).json() as { months: Array<{ salesSen: number; lines: unknown[] }> };
    expect(dec.months).toEqual([{ month: '2026-12', salesSen: 0, lines: [], totals: { tradingIncomeSen: 0, costOfSalesSen: 0, grossProfitSen: 0, otherIncomeSen: 0, expensesSen: 0, profitBeforeTaxSen: 0, taxationSen: 0, netProfitSen: 0 } }]);
    expect((await app.request('/accounting/forecast/figures?from=2026-11&to=2026-10')).status).toBe(400);
    expect((await app.request('/accounting/forecast/figures?from=2026-1&to=2026-10')).status).toBe(400);
  });
});

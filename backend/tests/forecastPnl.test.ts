/* The Forecast P&L's doors (owner 2026-09-21). Pinned: the accounts a line may
   name are the P&L's active leaves, sectioned as the statement sections them;
   the grid round-trips as jsonb rows, one per month; a whole-grid PUT removes
   the months it no longer carries; the first bad cell is named and nothing is
   kept; the figures endpoint applies the shared arithmetic per month; the
   blocks are the statement's own; the keys are the statements' read key and
   the vouchers' write key. Same fake-PostgREST harness as accountingReports. */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { billedAccountsBySupplier, forecastFiguresHandler, forecastGetHandler, forecastPutHandler, recentFrom } from '../src/scm/routes/accounting-forecast';
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

function harness(perms: string[] = ['scm.payment_voucher.post', 'scm.payment_voucher.write'], rows: Row[] = [], bindings: Row[] = [], extra: Record<string, Row[]> = {}) {
  const sb = fakeSb({
    accounts: ACCOUNTS.map((r) => ({ ...r })), acc_forecast_pnl: rows.map((r) => ({ ...r })), acc_report_layouts: [], acc_item_group_accounts: bindings.map((r) => ({ ...r })),
    ...Object.fromEntries(Object.entries(extra).map(([t, rs]) => [t, rs.map((r) => ({ ...r }))])),
  });
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
    expect(await saved.json()).toEqual({ ok: true, months: { '2026-10': OCT, '2026-11': NOV }, suppliers: {}, removed: [] });
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

/* The item-group bindings give a purchase account its basis (owner 2026-09-29:
   purchase of bedding 应该是根据回他的 sales 的 amount 算，而不是 total sales). */
describe("a purchase account's basis comes from the item-group bindings", () => {
  const BINDINGS: Row[] = [
    { company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' },
    { company_id: CO, group_code: 'MATTRESS', sales_account: '500-0001', purchase_account: '601-0001' },   // 601-0001 is not a forecast line here — nothing to stamp
    { company_id: CO, group_code: 'SERVICE', sales_account: '503-0000', purchase_account: '615-0000' },    // 503-0000 is not on the chart — left out, 615 stays on the whole sales
    { company_id: 99, group_code: 'SOFA', sales_account: '500-0001', purchase_account: '601-0003' },       // another company's binding never reaches this one
  ];

  test('GET stamps basis on the bound purchase accounts and nothing else; the figures take a purchase % of its own sales', async () => {
    const { app } = harness(undefined, [{ company_id: CO, month: '2026-10', lines: OCT }], BINDINGS);
    const b = await (await app.request('/accounting/forecast')).json() as { accounts: Array<{ code: string; basis?: string[] }> };
    const basis = Object.fromEntries(b.accounts.map((a) => [a.code, a.basis ?? null]));
    expect(basis['601-0003']).toEqual(['500-0003']);
    expect(basis['615-0000']).toBeNull();
    expect(basis['500-0003']).toBeNull();
    expect(basis['900-T003']).toBeNull();
    const fig = await (await app.request('/accounting/forecast/figures?from=2026-10&to=2026-10')).json() as { months: Array<{ salesSen: number; lines: Array<{ code: string; amountSen: number; basisSen: number }>; totals: { costOfSalesSen: number } }> };
    const oct = fig.months[0]!;
    expect(oct.salesSen).toBe(10_000_000);
    /* 55% of the sofa sales (80,000) = 44,000 — not 55,000 of the whole. */
    expect(oct.lines.find((l) => l.code === '601-0003')).toMatchObject({ amountSen: 4_400_000, basisSen: 8_000_000 });
    expect(oct.lines.find((l) => l.code === '615-0000')).toMatchObject({ amountSen: 100_000, basisSen: 10_000_000 });
    expect(oct.totals.costOfSalesSen).toBe(4_500_000);
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

/* Step 1 of the Hookka forecast port (2026-11-24): a purchase account's month
   split by supplier. Pinned: which lines are purchase accounts; the supplier
   figures round-trip beside the lines; only the active company's suppliers
   (or Other) are taken; a page that sends no suppliers keeps the stored ones;
   the figures door reads a split line as the sum of its suppliers; each
   supplier comes with the purchase accounts its bills landed on lately.
   Made-up suppliers and figures. */
describe('a purchase account split by supplier', () => {
  const SUPPLIERS: Row[] = [
    { id: 'sup-a', company_id: CO, code: '400-A001', name: 'Alpha Trading', status: 'ACTIVE' },
    { id: 'sup-b', company_id: CO, code: '400-B001', name: 'beta Supplies', status: 'ACTIVE' },
    { id: 'sup-c', company_id: CO, code: '400-C001', name: 'Gamma Works', status: 'INACTIVE' },
    { id: 'sup-x', company_id: 1, code: '400-X001', name: 'Another Company Supplier', status: 'ACTIVE' },
  ];
  const gl = (je: string, date: string, source: string, code: string, dr: number, cr: number, over: Row = {}): Row => ({
    company_id: CO, line_id: `${je}:${code}`, je_no: je, entry_date: date, source_type: source, account_code: code, debit_sen: dr, credit_sen: cr,
    party_type: null, party_code: null, posted: true, reversed: false, reversed_by_je: null, ...over,
  });
  const bill = (je: string, date: string, source: string, code: string, supplier: string, sen: number, over: Row = {}): Row[] => [
    gl(je, date, source, code, sen, 0, over),
    gl(je, date, source, '400-0000', 0, sen, { party_type: 'SUPPLIER', party_code: supplier, ...over }),
  ];
  const LEDGER: Row[] = [
    ...bill('PI-1', '2026-10-05', 'PI', '601-0003', '400-A001', 500_000),                         // Alpha billed sofa purchases lately
    ...bill('API-1', '2026-08-01', 'API', '601-0003', '400-B001', 80_000),                        // beta too, on an AP invoice, the window's first day
    ...bill('PI-2', '2026-11-02', 'PI', '615-0000', '400-B001', 20_000),                          // carriage is not a purchase account
    ...bill('PI-3', '2026-11-03', 'PI', '601-0003', '400-C001', 300_000, { reversed: true }),    // a reversed bill counts nowhere
    ...bill('PI-0', '2026-07-31', 'PI', '601-0003', '400-C001', 100_000),                         // before the window
    ...bill('PI-9', '2026-10-05', 'PI', '601-0003', '400-X001', 100_000, { company_id: 1 }),      // another company's bill
  ];
  const world = (rows: Row[] = []) => harness(undefined, rows, [], { suppliers: SUPPLIERS, v_gl_entries: LEDGER });

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-24T04:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  test('GET marks the purchase accounts and lists the company\'s own suppliers, each with the purchase accounts its bills landed on lately', async () => {
    const { app } = world();
    const b = await (await app.request('/accounting/forecast')).json() as {
      suppliers: Record<string, unknown>;
      accounts: Array<{ code: string; purchase?: boolean }>;
      supplierList: Array<{ id: string; code: string; name: string; active: boolean; recent: string[] }>;
    };
    expect(b.accounts.filter((a) => a.purchase).map((a) => a.code)).toEqual(['601-0003']);
    expect(b.suppliers).toEqual({});
    expect(b.supplierList).toEqual([
      { id: 'sup-a', code: '400-A001', name: 'Alpha Trading', active: true, recent: ['601-0003'] },
      { id: 'sup-b', code: '400-B001', name: 'beta Supplies', active: true, recent: ['601-0003'] },
      { id: 'sup-c', code: '400-C001', name: 'Gamma Works', active: false, recent: [] },
    ]);
  });

  test('the window starts on the first day of the month three months back; a bill nets per supplier and account', () => {
    expect(recentFrom('2026-11-24')).toBe('2026-08-01');
    expect(recentFrom('2026-02-10')).toBe('2025-11-01');
    expect(recentFrom('2026-03-01')).toBe('2025-12-01');
    const billed = billedAccountsBySupplier([
      { je_no: 'J1', account_code: '601-0003', debit_sen: 100, credit_sen: 0, party_type: null, party_code: null, posted: true },
      { je_no: 'J1', account_code: '400-0000', debit_sen: 0, credit_sen: 100, party_type: 'SUPPLIER', party_code: 'S1', posted: true },
      { je_no: 'J2', account_code: '601-0001', debit_sen: 0, credit_sen: 40, party_type: null, party_code: null, posted: true },     // a bill that nets to a credit is not a purchase
      { je_no: 'J2', account_code: '400-0000', debit_sen: 40, credit_sen: 0, party_type: 'SUPPLIER', party_code: 'S1', posted: true },
      { je_no: 'J3', account_code: '601-0001', debit_sen: 70, credit_sen: 0, party_type: null, party_code: null, posted: true },     // no supplier on the journal: nobody's
      { je_no: 'J4', account_code: '601-0001', debit_sen: 90, credit_sen: 0, party_type: null, party_code: null, posted: false },    // a draft is not in the books
      { je_no: 'J4', account_code: '400-0000', debit_sen: 0, credit_sen: 90, party_type: 'SUPPLIER', party_code: 'S2', posted: false },
    ], new Set(['601-0003', '601-0001']));
    expect([...billed].map(([s, codes]) => [s, [...codes]])).toEqual([['S1', ['601-0003']]]);
  });

  test('PUT stores the supplier figures beside the lines; GET and the figures read them back; the split line is the sum of its suppliers', async () => {
    const { app, sb } = world();
    const SUP = { '2026-10': { '601-0003': { 'sup-a': { amtSen: 3_000_000 }, 'sup-c': { bp: 1000 }, other: { amtSen: 200_000 } } } };
    const saved = await put(app, { months: { '2026-10': OCT, '2026-11': NOV }, suppliers: SUP });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, suppliers: SUP });
    const rows = sb.tables.acc_forecast_pnl as Row[];
    expect(rows.map((r) => [r.month, r.suppliers])).toEqual([['2026-10', SUP['2026-10']], ['2026-11', {}]]);
    /* The account's own 55% stays stored, superseded while its suppliers carry figures. */
    expect((rows[0]!.lines as Record<string, unknown>)['601-0003']).toEqual({ bp: 5500 });

    const read = await (await app.request('/accounting/forecast')).json() as { months: Record<string, unknown>; suppliers: Record<string, unknown> };
    expect(read.suppliers).toEqual(SUP);
    expect(read.months).toEqual({ '2026-10': OCT, '2026-11': NOV });

    const fig = await (await app.request('/accounting/forecast/figures?from=2026-10&to=2026-11')).json() as { months: Array<{ month: string; lines: Array<{ code: string; amountSen: number; keyed: string; bySupplier: Array<{ supplierId: string; amountSen: number }> }>; totals: { costOfSalesSen: number; grossProfitSen: number } }> };
    const oct = fig.months[0]!;
    /* Sales 100,000.00: Alpha 30,000.00 + Gamma 10% = 10,000.00 + Other 2,000.00 = 42,000.00, not the account's own 55,000.00. */
    expect(oct.lines.find((l) => l.code === '601-0003')).toMatchObject({ amountSen: 4_200_000, keyed: 'suppliers' });
    expect(oct.lines.find((l) => l.code === '601-0003')!.bySupplier.map((x) => [x.supplierId, x.amountSen])).toEqual([['sup-a', 3_000_000], ['sup-c', 1_000_000], ['other', 200_000]]);
    expect(oct.totals.costOfSalesSen).toBe(4_200_000 + 100_000);
    expect(oct.totals.grossProfitSen).toBe(10_000_000 - 4_300_000);
    /* November has no supplier figure: its own 55% stands. */
    expect(fig.months[1]!.lines.find((l) => l.code === '601-0003')).toMatchObject({ amountSen: 4_950_000, keyed: 'percent' });
  });

  test('PUT refuses by name a supplier of another company, an unknown one, a line that is not a purchase account, a month off the grid — and keeps nothing', async () => {
    const { app, sb } = world([{ company_id: CO, month: '2026-10', lines: OCT, suppliers: { '601-0003': { 'sup-a': { amtSen: 1 } } } }]);
    const cases: Array<[unknown, string]> = [
      [{ '2026-10': { '601-0003': { 'sup-x': { amtSen: 1 } } } }, '2026-10 601-0003 sup-x'],
      [{ '2026-10': { '601-0003': { 'sup-gone': { amtSen: 1 } } } }, '2026-10 601-0003 sup-gone'],
      [{ '2026-10': { '615-0000': { 'sup-a': { amtSen: 1 } } } }, '2026-10 615-0000'],
      [{ '2026-12': { '601-0003': { 'sup-a': { amtSen: 1 } } } }, '2026-12'],
      [{ '2026-10': { '601-0003': { 'sup-a': { amtSen: 1.5 } } } }, '2026-10 601-0003 sup-a amount'],
    ];
    for (const [suppliers, cell] of cases) {
      const res = await put(app, { months: { '2026-10': OCT }, suppliers });
      expect(res.status, JSON.stringify(suppliers)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_cell', cell });
    }
    expect((sb.tables.acc_forecast_pnl as Row[])[0]!.suppliers).toEqual({ '601-0003': { 'sup-a': { amtSen: 1 } } });
  });

  test('a page that sends no suppliers keeps each kept month\'s supplier figures; sending them empty clears them', async () => {
    const stored = { '601-0003': { 'sup-a': { amtSen: 3_000_000 } } };
    const { app, sb } = world([
      { company_id: CO, month: '2026-10', lines: OCT, suppliers: stored },
      { company_id: CO, month: '2026-11', lines: NOV, suppliers: { '601-0003': { 'sup-b': { amtSen: 5 } } } },
    ]);
    const res = await put(app, { months: { '2026-10': { ...OCT, '900-T003': { bp: 200 } } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suppliers: { '2026-10': stored }, removed: ['2026-11'] });
    const rows = sb.tables.acc_forecast_pnl as Row[];
    expect(rows.map((r) => [r.month, r.suppliers])).toEqual([['2026-10', stored]]);
    expect((rows[0]!.lines as Record<string, unknown>)['900-T003']).toEqual({ bp: 200 });
    await put(app, { months: { '2026-10': OCT }, suppliers: {} });
    expect((sb.tables.acc_forecast_pnl as Row[])[0]!.suppliers).toEqual({});
  });
});

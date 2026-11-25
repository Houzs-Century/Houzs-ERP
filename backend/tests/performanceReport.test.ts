/* The Performance P&L (owner 2026-09-12, docs/bugs/0835). Pinned:
     • sales and cost of sales come from the SALES ORDERS dated in the period
       — every status except DRAFT and CANCELLED, delivered or not — per line
       as the order records them (total_sen; unit cost × quantity), grouped
       bedframe / mattress / sofa / dining / accessory / service, a line
       outside the six under OTHERS, a cancelled line left out, a legacy
       header-only delivery fee counted as service;
     • operating expense is the company's rate (16% by default) of sales
       excluding service, IN PLACE OF the one account the company names
       (900-O001): that account's booked figure is shown and left out, every
       other EXPENSES-section account is as the ledger booked it by journal
       date (posted, not reversed, in range) — cost-of-goods accounts are not
       expenses here, the cost side is the orders';
     • other income is the ledger's OTHER INCOMES / EXTRA-ORDINARY INCOME as
       booked (owner 2026-09-12: performance GL 要放 other income), added to
       gross profit before the expenses;
     • a named account the chart does not carry replaces nothing, and the
       report says so;
     • the settings round-trip (rate in basis points, the account upper-cased),
       refused by name when out of range; a bad range is refused; the
       permission gate answers at this end;
     • the rate may also cover other accounts (owner 2026-10-06: 2990's
       transport is inside the 16%), each with every account under it: left
       out of the expenses, printed at nil where they sit, named on the rate's
       line; a company that names none (Houzs) keeps them as booked;
     • the fair costs (owner 2026-11-25), for a company that keeps them: rental,
       booth setup and the commission bills as booked, transport 3% / setup &
       dismantle 1% / merchandise 2% of sales excluding service in place of the
       Logistics P&L's own accounts and the drivers' and helpers' pay, the fair
       transport and the terminal charges — one block, first of the expenses;
       Finance's rates saved with the accounts kept.
   Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { performanceMonthsHandler, performanceReport, savePerformanceSettingsHandler } from '../src/scm/routes/accounting-performance';
import { buildPerformanceReport, performanceGroupOf } from '../src/acc/performance-pnl';

const CO = 2;
const GL_PERM = 'scm.payment_voucher.post';

const so = (docNo: string, date: string, status: string, over: Row = {}): Row => ({
  company_id: CO, doc_no: docNo, so_date: date, status, delivery_fee_sen: null, local_total_sen: 0, ...over,
});
let lineNo = 0;
const line = (docNo: string, group: string | null, code: string, qty: number, totalSen: number, unitCostSen: number, over: Row = {}): Row => ({
  id: `line-${String(++lineNo).padStart(3, '0')}`, company_id: CO, doc_no: docNo, item_group: group, item_code: code,
  qty, total_sen: totalSen, unit_cost_sen: unitCostSen, line_cost_sen: qty * unitCostSen, cancelled: false, ...over,
});
const gl = (code: string, name: string, type: string, date: string, dr: number, cr: number, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, entry_date: date,
  debit_sen: dr, credit_sen: cr, posted: true, reversed: false, ...over,
});
const acct = (code: string, name: string, type: string, section: string): Row => ({ company_id: CO, account_code: code, account_name: name, account_type: type, section, is_active: true });

const CHART: Row[] = [
  acct('500-0003', 'SALES OF SOFA', 'INCOME', 'SALES'),
  acct('590-0000', 'RENT RECEIVED', 'INCOME', 'OTHER INCOMES'),
  acct('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', 'COST OF GOODS SOLD'),
  acct('900-O001', 'OPERATIING EXPENSE', 'EXPENSE', 'EXPENSES'),
  acct('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', 'EXPENSES'),
  acct('900-R048', 'RENTAL OF SHOWROOM', 'EXPENSE', 'EXPENSES'),
];

function world(settings: Row[] = []) {
  lineNo = 0;
  return fakeSb({
    mfg_sales_orders: [
      so('SO-1', '2026-07-02', 'CONFIRMED'),
      so('SO-2', '2026-07-10', 'DELIVERED'),
      so('SO-3', '2026-07-15', 'CANCELLED'),                         // not an order
      so('SO-4', '2026-08-01', 'CONFIRMED'),                         // outside the range
      so('SO-5', '2026-07-20', 'DRAFT'),                             // not an order
      so('SO-6', '2026-07-25', 'CONFIRMED', { delivery_fee_sen: 8000 }), // legacy: the fee on the header, no SVC line
      so('SO-7', '2026-07-28', 'SHIPPED'),
    ],
    mfg_sales_order_items: [
      line('SO-1', 'sofa', 'SOFA-L3', 1, 300000, 180000),
      line('SO-1', 'service', 'SVC-DELIVERY', 1, 15000, 0),
      line('SO-2', 'mattress', 'MAT-Q', 1, 100000, 60000),
      line('SO-2', 'accessory', 'GIFT-PILLOW', 2, 0, 6000),          // a free gift: no sales, real cost
      line('SO-2', 'bedframe', 'BF-Q', 1, 50000, 20000),
      line('SO-2', 'dining', 'DIN-6', 1, 40000, 25000),
      line('SO-2', 'sofa', 'SOFA-X', 1, 99999, 1, { cancelled: true }), // a cancelled line is not sold
      line('SO-3', 'sofa', 'SOFA-L3', 1, 999900, 1),                 // on a cancelled order
      line('SO-4', 'sofa', 'SOFA-L3', 1, 777700, 1),                 // outside the range
      line('SO-5', 'sofa', 'SOFA-L3', 1, 555500, 1),                 // on a draft
      line('SO-7', 'bedlines', 'BL-SET', 2, 10000, 2000),            // outside the six → others
    ],
    v_gl_entries: [
      gl('900-O001', 'OPERATIING EXPENSE', 'EXPENSE', '2026-07-31', 243550, 0),   // the replaced account, as booked
      gl('900-R048', 'RENTAL OF SHOWROOM', 'EXPENSE', '2026-07-05', 4500000, 0),
      gl('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '2026-07-20', 100000, 0),
      gl('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '2026-07-21', 5000, 0, { reversed: true }),  // reversed: not live
      gl('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '2026-07-22', 7000, 0, { posted: false }),   // unposted: not live
      gl('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '2026-08-02', 9000, 0),                      // outside the range
      gl('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', '2026-07-09', 500000, 0),   // cost of goods: the orders carry the cost side
      gl('500-0003', 'SALES OF SOFA', 'INCOME', '2026-07-09', 0, 300000),
      gl('590-0000', 'RENT RECEIVED', 'INCOME', '2026-07-15', 0, 50000),      // other income, as booked
      gl('590-0000', 'RENT RECEIVED', 'INCOME', '2026-08-15', 0, 90000),      // outside the range
    ],
    accounts: CHART.map((r) => ({ ...r })),
    acc_company_settings: settings.map((r) => ({ ...r })),
    acc_report_layouts: [],
  });
}

function harness(perms: readonly string[] = [GL_PERM], settings: Row[] = []) {
  const sb = world(settings);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    await next();
  });
  app.get('/accounting/reports/performance', performanceReport as never);
  app.post('/accounting/reports/performance/settings', savePerformanceSettingsHandler as never);
  return { app, sb };
}
const read = async (app: Hono, qs: string) => {
  const res = await app.request(`/accounting/reports/performance?${qs}`);
  return { status: res.status, body: await res.json() as any };
};
const post = (app: Hono, body: unknown) =>
  app.request('/accounting/reports/performance/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the Performance P&L', () => {
  test('sales and cost per group from the orders of the period; 16% of sales excluding service in place of 900-O001; the rest as booked', async () => {
    const { app } = harness();
    const { status, body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(status).toBe(200);
    expect(body.orders).toEqual({ counted: 4, notDelivered: 3, excludedDraft: 1, excludedCancelled: 1 });
    expect(body.groups.map((g: any) => [g.key, g.lines, g.salesSen, g.cogsSen, g.gpSen, g.gpPct])).toEqual([
      ['bedframe', 1, 50000, 20000, 30000, 60],
      ['mattress', 1, 100000, 60000, 40000, 40],
      ['sofa', 1, 300000, 180000, 120000, 40],
      ['dining', 1, 40000, 25000, 15000, 37.5],
      ['accessory', 1, 0, 12000, -12000, null],
      ['service', 1, 23000, 0, 23000, 100],         // the SVC line + SO-6's header-only fee
      ['others', 1, 10000, 4000, 6000, 60],
    ]);
    expect(body.totals).toEqual({ salesSen: 523000, cogsSen: 301000, gpSen: 222000, gpPct: 42.4, salesExServiceSen: 500000 });
    expect(body.operatingExpense).toEqual({
      rateBp: 1600, baseSen: 500000, amountSen: 80000,
      account: '900-O001', accountName: 'OPERATIING EXPENSE', accountFound: true, bookedSen: 243550,
      also: [], alsoBookedSen: 0,
    });
    /* Live, in range, EXPENSES section, and not the replaced account. */
    expect(body.otherExpenses).toEqual([
      { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', amountSen: 100000 },
      { code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 },
    ]);
    expect(body.otherExpensesSen).toBe(4600000);
    expect(body.otherIncome).toEqual([{ code: '590-0000', name: 'RENT RECEIVED', amountSen: 50000 }]);
    expect(body.otherIncomeSen).toBe(50000);
    expect(body.netSen).toBe(222000 + 50000 - 80000 - 4600000);
    expect(body.netPct).toBe(-842.8);
    expect(body.settings).toEqual({ rateBp: 1600, account: '900-O001', also: [], fair: null });
    expect(body.fair).toBeNull();
    /* The account part on the report's tree (docs/bugs/0912): the chart's
       own — every expense at the root here — the computed operating expense
       standing where 900-O001 sits, under its own sentence, % of SALES on
       every line. */
    type Laid = { kind: string; key?: string; label: string; amountSen: number; pct: number | null; children: Laid[] };
    const flat = (nodes: Laid[]): unknown[] => nodes.map((n) => [n.key, n.label, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);
    expect(body.layout.stored).toBe(false);
    expect(body.layout.baseSen).toBe(523000);
    expect(flat(body.layout.otherIncome)).toEqual([[undefined, 'OTHER INCOMES', 50000, 9.6, [['590-0000', '590-0000 · RENT RECEIVED', 50000, 9.6]]]]);
    expect(flat(body.layout.expenses)).toEqual([
      ['900-A014', '900-A014 · ADVERTISEMENT - SHOWROOM', 100000, 19.1],
      ['900-O001', 'Operating expense — 16.00% of sales excluding service (5,000.00), in place of 900-O001 OPERATIING EXPENSE', 80000, 15.3],
      ['900-R048', '900-R048 · RENTAL OF SHOWROOM', 4500000, 860.4],
    ]);
  });

  test('the account part follows a SAVED performance tree; the computed line goes where its account was placed; an unknown account lands under Unassigned', async () => {
    const tree = { version: 1, blocks: { otherIncome: [], expenses: [
      { kind: 'category', id: 'cat:fixed', label: 'Fixed costs', children: [{ kind: 'account', code: '900-R048' }, { kind: 'account', code: '900-O001' }] },
    ] } };
    const { app, sb } = harness();
    sb.tables.acc_report_layouts.push({ report: 'performance', tree, updated_at: null, updated_by: 'T' });
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    type Laid = { kind: string; key?: string; label: string; amountSen: number; children: Laid[] };
    const flat = (nodes: Laid[]): unknown[] => nodes.map((n) => [n.kind, n.key ?? n.label, n.amountSen, ...(n.children.length > 0 ? [flat(n.children)] : [])]);
    expect(body.layout.stored).toBe(true);
    expect(flat(body.layout.expenses)).toEqual([
      ['category', 'Fixed costs', 4580000, [['account', '900-R048', 4500000], ['account', '900-O001', 80000]]],
      ['unassigned', 'Unassigned', 100000, [['account', '900-A014', 100000]]],
    ]);
    /* An account the chart does not carry: nothing replaced, the computed
       line still prints — under Unassigned, saying so. */
    const { app: odd } = harness([GL_PERM], [{ company_id: CO, performance_opex_rate_bp: 2000, performance_opex_account: '900-Z999' }]);
    const { body: b2 } = await read(odd, 'from=2026-07-01&to=2026-07-31');
    const un = (b2.layout.expenses as Laid[]).find((n) => n.kind === 'unassigned')!;
    expect(un.children.find((n) => n.key === '900-Z999')!.label).toBe('Operating expense — 20.00% of sales excluding service (5,000.00), 900-Z999 not in the chart — nothing replaced');
    /* Only the unknown code is unplaced — the chart's own tree places the three booked accounts, the booked 900-O001 now an ordinary expense. */
    expect(un.children.map((n) => n.key)).toEqual(['900-Z999']);
    expect((b2.layout.expenses as Laid[]).map((n) => n.key ?? n.kind)).toEqual(['900-A014', '900-O001', '900-R048', 'unassigned']);
  });

  test('the rate follows the settings, and an account the chart does not carry replaces nothing — said, not swallowed', async () => {
    const { app } = harness([GL_PERM], [{ company_id: CO, performance_opex_rate_bp: 2000, performance_opex_account: '900-Z999' }]);
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.operatingExpense).toEqual({
      rateBp: 2000, baseSen: 500000, amountSen: 100000,
      account: '900-Z999', accountName: null, accountFound: false, bookedSen: 0,
      also: [], alsoBookedSen: 0,
    });
    expect(body.otherExpenses.map((e: any) => e.code)).toEqual(['900-A014', '900-O001', '900-R048']);
    expect(body.otherExpensesSen).toBe(4843550);
    expect(body.netSen).toBe(222000 + 50000 - 100000 - 4843550);
  });

  test('the settings round-trip: basis points and the account, upper-cased; out of range is refused by name', async () => {
    const { app, sb } = harness();
    const bad = await post(app, { rateBp: 12.5, account: '900-O001' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('bad_rate');
    const tooHigh = await post(app, { rateBp: 10001, account: '900-O001' });
    expect(tooHigh.status).toBe(400);
    const noAccount = await post(app, { rateBp: 1800, account: '  ' });
    expect((await noAccount.json() as { error: string }).error).toBe('account_required');
    const ok = await post(app, { rateBp: 1800, account: '900-o001' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, settings: { rateBp: 1800, account: '900-O001', also: [] } });
    expect(sb.tables.acc_company_settings).toEqual([expect.objectContaining({ company_id: CO, performance_opex_rate_bp: 1800, performance_opex_account: '900-O001', updated_by: 'Chew' })]);
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.operatingExpense.amountSen).toBe(90000);
  });

  test('a bad range is refused; the permission gate answers at this end', async () => {
    const { app } = harness();
    expect((await read(app, 'from=2026-07-31&to=2026-07-01')).status).toBe(400);
    expect((await read(app, 'from=July&to=2026-07-31')).status).toBe(400);
    const { app: noPerm } = harness([]);
    expect((await read(noPerm, 'from=2026-07-01&to=2026-07-31')).status).toBe(403);
    expect((await post(noPerm, { rateBp: 1600, account: '900-O001' })).status).toBe(403);
  });

  test('the classifier: service by group or SVC code, the six by their word, anything else OTHERS', () => {
    expect(performanceGroupOf({ item_group: 'sofa', item_code: 'SOFA-L3' })).toBe('sofa');
    expect(performanceGroupOf({ item_group: 'SOFA', item_code: null })).toBe('sofa');
    expect(performanceGroupOf({ item_group: 'mattress', item_code: 'MAT-Q' })).toBe('mattress');
    expect(performanceGroupOf({ item_group: 'bedframe', item_code: 'BF-Q' })).toBe('bedframe');
    expect(performanceGroupOf({ item_group: 'dining', item_code: 'DIN-6' })).toBe('dining');
    expect(performanceGroupOf({ item_group: 'accessory', item_code: 'GIFT-PILLOW' })).toBe('accessory');
    expect(performanceGroupOf({ item_group: 'service', item_code: 'X' })).toBe('service');
    expect(performanceGroupOf({ item_group: 'others', item_code: 'SVC-LIFT-CARRY' })).toBe('service');
    expect(performanceGroupOf({ item_group: 'bedlines', item_code: 'BL-SET' })).toBe('others');
    expect(performanceGroupOf({ item_group: null, item_code: null })).toBe('others');
  });

  test('a line older than the cost column recomputes its cost from the parts; OTHERS is absent when nothing landed there', () => {
    const r = buildPerformanceReport({
      from: '2026-07-01', to: '2026-07-31',
      orders: [{ doc_no: 'SO-9', so_date: '2026-07-03', status: 'DELIVERED', delivery_fee_sen: null }],
      lines: [{ doc_no: 'SO-9', item_group: 'sofa', item_code: 'SOFA-L3', qty: 2, total_sen: 200000, unit_cost_sen: 70000, line_cost_sen: null, cancelled: false }],
      expenses: [],
      settings: { rateBp: 1600, account: '900-O001', also: [], fair: null },
      account: { code: '900-O001', name: 'OPERATIING EXPENSE' },
      fair: null,
    });
    expect(r.groups.map((g) => g.key)).toEqual(['bedframe', 'mattress', 'sofa', 'dining', 'accessory', 'service']);
    expect(r.groups.find((g) => g.key === 'sofa')).toMatchObject({ salesSen: 200000, cogsSen: 140000, gpSen: 60000, gpPct: 30 });
    expect(r.orders).toEqual({ counted: 1, notDelivered: 0, excludedDraft: 0, excludedCancelled: 0 });
    expect(r.operatingExpense).toMatchObject({ baseSen: 200000, amountSen: 32000, bookedSen: 0 });
    expect(r.otherIncome).toEqual([]);
    expect(r.netSen).toBe(28000);
  });
});

/* 2990's transport is inside the 16% (owner 2026-10-06: 已经算在 operating
   expense 16% 了): 900-T004 and the logistics accounts under it. 900-T008
   TRANSPORTATION FEES - OTHERS (decoration / gift-box freight) is not — it
   stays as booked (「900-T008 … 不包含」). Houzs figures its performance
   differently and names none. */
describe('the rate also covers other accounts', () => {
  const ALSO = { company_id: CO, performance_opex_rate_bp: 1600, performance_opex_account: '900-O001', performance_opex_also: ['900-T004'] };
  const transport = (sb: ReturnType<typeof harness>['sb']) => {
    (sb.tables.accounts as Row[]).push(
      { ...acct('900-T004', 'TRANSPORTATION FEE', 'EXPENSE', 'EXPENSES'), parent_code: '900-0000' },
      { ...acct('900-T006', 'TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', 'EXPENSE', 'EXPENSES'), parent_code: '900-T004' },
      { ...acct('900-T008', 'TRANSPORTATION FEES - OTHERS', 'EXPENSE', 'EXPENSES'), parent_code: '900-0000' },
    );
    (sb.tables.v_gl_entries as Row[]).push(
      gl('900-T006', 'TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', 'EXPENSE', '2026-07-10', 1260720, 0),
      gl('900-T008', 'TRANSPORTATION FEES - OTHERS', 'EXPENSE', '2026-07-12', 19090, 0),
    );
  };
  const flat = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

  test('the covered account — and the ones under it — leave the expenses, print at nil, and the rate names it; 900-T008 stays as booked', async () => {
    const { app, sb } = harness([GL_PERM], [ALSO]);
    transport(sb);
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.operatingExpense).toMatchObject({
      amountSen: 80000,
      also: [{ code: '900-T004', name: 'TRANSPORTATION FEE' }],
      alsoBookedSen: 1260720,
    });
    expect(body.inRate.map((e: any) => [e.code, e.amountSen])).toEqual([['900-T006', 1260720]]);
    expect(body.otherExpenses.map((e: any) => e.code)).toEqual(['900-A014', '900-R048', '900-T008']);
    expect(body.netSen).toBe(222000 + 50000 - 80000 - 4600000 - 19090);
    const lines = flat(body.layout.expenses);
    expect(lines.find((n) => n.code === '900-T006')?.amountSen).toBe(0);
    expect(lines.find((n) => n.code === '900-T008')?.amountSen).toBe(19090);
    expect(lines.find((n) => n.code === '900-O001')?.label)
      .toContain('also covers 900-T004 TRANSPORTATION FEE (with the accounts under them)');
  });

  test('a company that names none keeps its transport as booked', async () => {
    const { app, sb } = harness();
    transport(sb);
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.inRate).toEqual([]);
    expect(body.otherExpenses.map((e: any) => e.code)).toEqual(['900-A014', '900-R048', '900-T006', '900-T008']);
  });

  test('the settings take the list — codes upper-cased, once each, never the rate\'s own account; a bad code is refused', async () => {
    const { app, sb } = harness();
    const ok = await post(app, { rateBp: 1600, account: '900-O001', also: '900-t004, 900-T008 900-T004, 900-o001' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, settings: { rateBp: 1600, account: '900-O001', also: ['900-T004', '900-T008'] } });
    expect(sb.tables.acc_company_settings).toEqual([expect.objectContaining({ performance_opex_also: ['900-T004', '900-T008'] })]);
    const bad = await post(app, { rateBp: 1600, account: '900-O001', also: ['900-T004', 'DROP TABLE;'] });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('bad_also');
  });
});

/* The commission (owner 2026-11-25: 「如果performance PNL就remain invoice amount，
   因为这个是performance」): the bills on PREPAYMENT COMMISSION show on the
   commission expense in the month they pay for, whenever they were booked, in
   place of what the monthly release (COMMREL) booked there; anything else on
   the account stays as booked. Made-up figures. */
describe('the commission is the month\'s bills, not the release', () => {
  const harnessWith = (extraGl: Row[], extraAccounts: Row[]) => {
    const { app, sb } = harness();
    const tables = sb as unknown as { from: (n: string) => { insert: (r: Row | Row[]) => Promise<unknown> } };
    return { app, seed: async () => {
      await tables.from('accounts').insert(extraAccounts);
      await tables.from('v_gl_entries').insert(extraGl);
    } };
  };
  const ACCTS: Row[] = [
    acct('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', 'CURRENT ASSETS'),
    acct('900-C003', 'COMMISSION ( EVENT )', 'EXPENSE', 'EXPENSES'),
  ];
  const GL: Row[] = [
    /* July's bill, booked in August — it is July's. August's own bill. */
    gl('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', '2026-08-15', 120000, 0, { source_type: 'API', source_doc_no: 'API-1', notes: "REVENUE TEAM PAYROLL - JUL'26" }),
    gl('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', '2026-08-31', 90000, 0, { source_type: 'API', source_doc_no: 'API-2', notes: 'REVENUE TEAM PAYROLL AUG26' }),
    /* The release July booked, and a hand journal on the same account. */
    gl('900-C003', 'COMMISSION ( EVENT )', 'EXPENSE', '2026-07-31', 30000, 0, { source_type: 'COMMREL', source_doc_no: 'COMMREL-2-2026-07' }),
    gl('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', '2026-07-31', 0, 30000, { source_type: 'COMMREL', source_doc_no: 'COMMREL-2-2026-07' }),
    gl('900-C003', 'COMMISSION ( EVENT )', 'EXPENSE', '2026-07-10', 5000, 0, { source_type: 'MANUAL' }),
  ];

  test('July shows July\'s bill and the hand journal; the release it booked is left out', async () => {
    const { app, seed } = harnessWith(GL, ACCTS);
    await seed();
    const { status, body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(status).toBe(200);
    expect(body.commission).toEqual({ code: '900-C003', name: 'COMMISSION ( EVENT )', billSen: 120000, months: ['2026-07'], releaseSen: 30000 });
    expect(body.otherExpenses.find((e: any) => e.code === '900-C003')).toEqual({ code: '900-C003', name: 'COMMISSION ( EVENT )', amountSen: 125000 });
    const line = body.layout.expenses.find((n: any) => n.key === '900-C003');
    expect(line.label).toBe('900-C003 COMMISSION ( EVENT ) — the commission bills for Jul 2026, in place of the monthly release');
    expect(line.amountSen).toBe(125000);
  });

  test('a month whose account booked nothing still shows its bill', async () => {
    const { app, seed } = harnessWith(GL, ACCTS);
    await seed();
    const { body } = await read(app, 'from=2026-08-01&to=2026-08-31');
    expect(body.commission.billSen).toBe(90000);
    expect(body.otherExpenses.find((e: any) => e.code === '900-C003')?.amountSen).toBe(90000);
  });

  test('a company with no commission bills reads as before', async () => {
    const { app } = harness();
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.commission).toBeNull();
    expect(body.otherExpenses.some((e: any) => e.code === '900-C003')).toBe(false);
  });
});

describe('the fair costs (owner 2026-11-25): one block, rental, setup, commission, transport, merchandise', () => {
  const FAIR = {
    rental: ['900-R031', '900-R032'], setup: ['900-B003'], transportBp: 300,
    setupDismantleBp: 100, setupDismantle: ['900-T030'], merchandiseBp: 200, merchandise: ['900-T009'],
  };
  const fairAcct = (code: string, name: string, over: Row = {}): Row => ({ ...acct(code, name, 'EXPENSE', 'EXPENSES'), logistics_row: null, ...over });
  let gid = 0;
  const g = (code: string, name: string, dr: number, over: Row = {}): Row => ({ ...gl(code, name, 'EXPENSE', '2026-07-15', dr, 0), line_id: `f${++gid}`, notes: null, ...over });
  function fairHarness(fair: unknown = FAIR) {
    lineNo = 0;
    const sb = fakeSb({
      mfg_sales_orders: [so('SO-1', '2026-07-02', 'CONFIRMED')],
      mfg_sales_order_items: [line('SO-1', 'mattress', 'MAT-Q', 1, 1_000_000, 400_000), line('SO-1', 'service', 'SVC-DELIVERY', 1, 20_000, 0)],
      accounts: [
        fairAcct('900-R032', 'RENTAL - EXHIBITION'), fairAcct('900-B003', 'BOOTH SET UP'), fairAcct('900-C003', 'COMMISSION ( EVENT )'),
        fairAcct('900-T005', 'TRANSPORT (PNG)', { logistics_row: 'outsource_pg' }), fairAcct('900-P006', 'PETROL - LORI VNB 9058', { logistics_row: 'petrol' }),
        fairAcct('900-T030', 'TRANSPORT FAIR - SETUP&DISMANTLE'), fairAcct('900-T009', 'TERMINAL INTEREST CHARGES'),
        fairAcct('900-T008', 'TRANSPORTATION FEES - OTHERS'), fairAcct('900-R048', 'RENTAL OF SHOWROOM'), fairAcct('900-S100', 'STAFF SALARIES & OVERTIME'),
        { ...acct('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', 'CURRENT ASSETS') },
      ],
      v_gl_entries: [
        g('900-R032', 'RENTAL - EXHIBITION', 300_000), g('900-B003', 'BOOTH SET UP', 50_000),
        g('900-T005', 'TRANSPORT (PNG)', 40_000), g('900-P006', 'PETROL - LORI VNB 9058', 10_000),
        g('900-T030', 'TRANSPORT FAIR - SETUP&DISMANTLE', 8_000), g('900-T009', 'TERMINAL INTEREST CHARGES', 18_000),
        g('900-T008', 'TRANSPORTATION FEES - OTHERS', 1_000), g('900-R048', 'RENTAL OF SHOWROOM', 20_000),
        g('900-S100', 'STAFF SALARIES & OVERTIME', 25_000, { notes: "OPERATION DELIVERY SALARY - JUL'26" }),
        g('900-S100', 'STAFF SALARIES & OVERTIME', 30_000, { notes: "FINANCE - SALARY - JUL'26" }),
        /* July's commission bill on the prepayment. */
        { ...gl('360-0050', 'PREPAYMENT COMMISSION', 'ASSET', '2026-08-15', 120_000, 0), line_id: 'bill-1', je_no: 'HC-API-1', source_type: 'API', source_doc_no: 'HC-API-1', notes: "REVENUE TEAM PAYROLL TO COLLECT BACK - JUL'26" },
      ],
      acc_company_settings: [{ company_id: CO, performance_opex_rate_bp: 0, performance_opex_account: '0', performance_opex_also: [], performance_fair: fair }],
      acc_report_layouts: [],
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase' as never, sb as never);
      c.set('companyId' as never, CO as never);
      c.set('houzsUser' as never, { name: 'Chew', permissions_set: [GL_PERM] } as never);
      c.set('allowedCompanyIds' as never, [1, 2] as never);
      await next();
    });
    app.get('/accounting/reports/performance', performanceReport as never);
    app.get('/accounting/reports/performance/months', performanceMonthsHandler as never);
    app.post('/accounting/reports/performance/settings', savePerformanceSettingsHandler as never);
    return { app, sb };
  }

  test('rental, setup and the commission bill as booked; transport, setup & dismantle and merchandise at their rates in place of what the books carry', async () => {
    const { app } = fairHarness();
    const { status, body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(status).toBe(200);
    expect(body.totals).toMatchObject({ salesSen: 1_020_000, cogsSen: 400_000, gpSen: 620_000, salesExServiceSen: 1_000_000 });
    expect(body.fair.lines.map((l: any) => [l.key, l.kind, l.amountSen, l.replacedSen ?? null])).toEqual([
      ['rental', 'booked', 300_000, null],
      ['setup', 'booked', 50_000, null],
      ['commission', 'booked', 120_000, null],
      /* 3% of 1,000,000 in place of the logistics accounts (40,000 + 10,000) and the driver's pay (25,000). */
      ['transport', 'rate', 30_000, 75_000],
      ['setupDismantle', 'rate', 10_000, 8_000],
      ['merchandise', 'rate', 20_000, 18_000],
    ]);
    expect(body.fair.totalSen).toBe(530_000);
    /* What is left as booked: the showroom, the gift-box freight, the payroll less the driver's line. */
    expect(body.otherExpenses).toEqual([
      { code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 20_000 },
      { code: '900-S100', name: 'STAFF SALARIES & OVERTIME', amountSen: 30_000 },
      { code: '900-T008', name: 'TRANSPORTATION FEES - OTHERS', amountSen: 1_000 },
    ]);
    expect(body.netSen).toBe(620_000 - 530_000 - 51_000);
    /* One block, first of the expenses: the booked accounts open their lines, the rates say what they stand in for. */
    const block = body.layout.expenses[0];
    expect(block).toMatchObject({ kind: 'category', id: 'perf:fair', label: 'Fair costs', amountSen: 530_000 });
    expect(block.children.map((n: any) => [n.code ?? null, n.amountSen])).toEqual([
      ['900-R032', 300_000], ['900-B003', 50_000], ['900-C003', 120_000], [null, 30_000], [null, 10_000], [null, 20_000],
    ]);
    expect(block.children[2].label).toBe('900-C003 COMMISSION ( EVENT ) — the commission bills for Jul 2026, in place of the monthly release');
    expect(block.children[3].label).toContain("Transport — 3.00% of sales excluding service (10,000.00), in place of the logistics accounts (the Chart of Accounts' Logistics column) and the drivers' and helpers' pay (750.00 booked)");
    expect(block.children[5].label).toContain('in place of 900-T009 TERMINAL INTEREST CHARGES (180.00 booked)');
    /* Nothing the block took prints again on the tree. */
    const codes = (ns: any[]): string[] => ns.flatMap((n: any) => [...(n.code ? [n.code] : []), ...codes(n.children ?? [])]);
    const rest = codes(body.layout.expenses.slice(1));
    for (const c of ['900-R032', '900-B003', '900-C003', '900-T005', '900-P006', '900-T030', '900-T009']) expect(rest).not.toContain(c);
    /* The chart's month carries the same expenses. */
    const months = await (await app.request('/accounting/reports/performance/months?from=2026-07&to=2026-07')).json() as any;
    expect(months.months[0]).toMatchObject({ expensesSen: 530_000 + 51_000, netSen: body.netSen });
  });

  test("Finance's three rates saved, the accounts kept; a rate out of range refused; a company with no fair block refused", async () => {
    const { app, sb } = fairHarness();
    const res = await post(app, { rateBp: 0, account: '0', also: [], fair: { transportBp: 350, setupDismantleBp: 100, merchandiseBp: 180 } });
    expect(res.status).toBe(200);
    expect(sb.tables.acc_company_settings![0]!.performance_fair).toEqual({ ...FAIR, transportBp: 350, merchandiseBp: 180 });
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.fair.lines.find((l: any) => l.key === 'transport').amountSen).toBe(35_000);
    expect((await post(app, { rateBp: 0, account: '0', also: [], fair: { transportBp: 10_001, setupDismantleBp: 100, merchandiseBp: 200 } })).status).toBe(400);
    const none = fairHarness(null);
    const refused = await post(none.app, { rateBp: 0, account: '0', also: [], fair: { transportBp: 300, setupDismantleBp: 100, merchandiseBp: 200 } });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).error).toBe('no_fair_block');
    expect((await read(none.app, 'from=2026-07-01&to=2026-07-31')).body.fair).toBeNull();
  });
});

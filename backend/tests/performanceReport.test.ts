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
     • a named account the chart does not carry replaces nothing, and the
       report says so;
     • the settings round-trip (rate in basis points, the account upper-cased),
       refused by name when out of range; a bad range is refused; the
       permission gate answers at this end.
   Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { performanceReport, savePerformanceSettingsHandler } from '../src/scm/routes/accounting-performance';
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
    ],
    accounts: CHART.map((r) => ({ ...r })),
    acc_company_settings: settings.map((r) => ({ ...r })),
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
    });
    /* Live, in range, EXPENSES section, and not the replaced account. */
    expect(body.otherExpenses).toEqual([
      { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', amountSen: 100000 },
      { code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 },
    ]);
    expect(body.otherExpensesSen).toBe(4600000);
    expect(body.netSen).toBe(222000 - 80000 - 4600000);
    expect(body.netPct).toBe(-852.4);
    expect(body.settings).toEqual({ rateBp: 1600, account: '900-O001' });
  });

  test('the rate follows the settings, and an account the chart does not carry replaces nothing — said, not swallowed', async () => {
    const { app } = harness([GL_PERM], [{ company_id: CO, performance_opex_rate_bp: 2000, performance_opex_account: '900-Z999' }]);
    const { body } = await read(app, 'from=2026-07-01&to=2026-07-31');
    expect(body.operatingExpense).toEqual({
      rateBp: 2000, baseSen: 500000, amountSen: 100000,
      account: '900-Z999', accountName: null, accountFound: false, bookedSen: 0,
    });
    expect(body.otherExpenses.map((e: any) => e.code)).toEqual(['900-A014', '900-O001', '900-R048']);
    expect(body.otherExpensesSen).toBe(4843550);
    expect(body.netSen).toBe(222000 - 100000 - 4843550);
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
    expect(await ok.json()).toEqual({ ok: true, settings: { rateBp: 1800, account: '900-O001' } });
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
      settings: { rateBp: 1600, account: '900-O001' },
      account: { code: '900-O001', name: 'OPERATIING EXPENSE' },
    });
    expect(r.groups.map((g) => g.key)).toEqual(['bedframe', 'mattress', 'sofa', 'dining', 'accessory', 'service']);
    expect(r.groups.find((g) => g.key === 'sofa')).toMatchObject({ salesSen: 200000, cogsSen: 140000, gpSen: 60000, gpPct: 30 });
    expect(r.orders).toEqual({ counted: 1, notDelivered: 0, excludedDraft: 0, excludedCancelled: 0 });
    expect(r.operatingExpense).toMatchObject({ baseSen: 200000, amountSen: 32000, bookedSen: 0 });
    expect(r.netSen).toBe(28000);
  });
});

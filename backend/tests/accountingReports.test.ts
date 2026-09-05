// The standard statements (GL redesign item 6). Pinned:
//   • the P&L splits the owner's way: trading income vs the 700 tree, 6xx as
//     cost of sales (the month-close 620 pair INCLUDED — that is what makes
//     gross profit read purchases + opening − closing), everything else below
//     the line; reversed/unposted lines never count;
//   • the balance sheet balances THROUGH current earnings, and its self-check
//     is zero on a clean ledger;
//   • bad dates are 400 sentences.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { pnlReport, balanceSheetReport } from '../src/scm/routes/accounting-reports';

const CO = 2;

const ACCOUNTS: Row[] = [
  { company_id: CO, account_code: '310-0010', account_name: 'BANK', account_type: 'ASSET', parent_code: null },
  { company_id: CO, account_code: '330-0000', account_name: 'STOCK', account_type: 'ASSET', parent_code: null },
  { company_id: CO, account_code: '400-0000', account_name: 'AP', account_type: 'LIABILITY', parent_code: null },
  { company_id: CO, account_code: '501-0000', account_name: 'SALES', account_type: 'INCOME', parent_code: null },
  { company_id: CO, account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null },
  { company_id: CO, account_code: '590-0000', account_name: 'RENT RECEIVED', account_type: 'INCOME', parent_code: '700-0000' },
  { company_id: CO, account_code: '601-0003', account_name: 'PURCHASE OF SOFA', account_type: 'EXPENSE', parent_code: null },
  { company_id: CO, account_code: '620-0000', account_name: 'STOCKS AT END', account_type: 'EXPENSE', parent_code: null },
  { company_id: CO, account_code: '900-A001', account_name: 'ADVERT', account_type: 'EXPENSE', parent_code: '900-0000' },
];

const gl = (code: string, type: string, dr: number, cr: number, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_type: type,
  account_name: code, debit_sen: dr, credit_sen: cr,
  entry_date: '2026-08-15', posted: true, reversed: false, ...over,
});

function harness(glRows: Row[]) {
  const sb = fakeSb({ v_gl_entries: glRows, accounts: ACCOUNTS.map((r) => ({ ...r })) });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    await next();
  });
  app.get('/accounting/reports/pnl', pnlReport as never);
  app.get('/accounting/reports/balance-sheet', balanceSheetReport as never);
  return { app };
}

/* One trading month in miniature: RM1,000 sale, RM600 purchases, RM100
   closing stock (the month-close pair), RM50 rent received under 700,
   RM120 advertising — plus a REVERSED line and an unposted draft that must
   not count. */
const WORLD: Row[] = [
  gl('501-0000', 'INCOME', 0, 100_000),
  gl('310-0010', 'ASSET', 100_000, 0),
  gl('601-0003', 'EXPENSE', 60_000, 0),
  gl('400-0000', 'LIABILITY', 0, 60_000),
  gl('330-0000', 'ASSET', 10_000, 0, { entry_date: '2026-08-31' }),   // closing stock pair
  gl('620-0000', 'EXPENSE', 0, 10_000, { entry_date: '2026-08-31' }),
  gl('590-0000', 'INCOME', 0, 5_000),
  gl('310-0010', 'ASSET', 5_000, 0),
  gl('900-A001', 'EXPENSE', 12_000, 0),
  gl('310-0010', 'ASSET', 0, 12_000),
  gl('501-0000', 'INCOME', 0, 999_999, { reversed: true }),
  gl('501-0000', 'INCOME', 0, 888_888, { posted: false }),
];

describe('GET /accounting/reports/pnl', () => {
  test('bad range is a 400', async () => {
    const { app } = harness([]);
    expect((await app.request('/accounting/reports/pnl?from=x&to=y')).status).toBe(400);
  });

  test('splits the owner\'s way and the arithmetic holds', async () => {
    const { app } = harness(WORLD);
    const res = await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    const b = await res.json() as {
      tradingIncome: Array<{ code: string; amountSen: number }>;
      costOfSales: Array<{ code: string; amountSen: number }>;
      otherIncome: Array<{ code: string; amountSen: number }>;
      expenses: Array<{ code: string; amountSen: number }>;
      totals: Record<string, number>;
    };
    expect(b.tradingIncome).toEqual([{ code: '501-0000', name: '501-0000', amountSen: 100_000 }]);
    // 620's CREDIT reduces cost of sales — purchases + opening − closing.
    expect(b.costOfSales.map((l) => [l.code, l.amountSen])).toEqual([['601-0003', 60_000], ['620-0000', -10_000]]);
    expect(b.otherIncome.map((l) => l.code)).toEqual(['590-0000']);
    expect(b.expenses.map((l) => l.code)).toEqual(['900-A001']);
    expect(b.totals).toMatchObject({
      tradingIncomeSen: 100_000,
      costOfSalesSen: 50_000,
      grossProfitSen: 50_000,
      otherIncomeSen: 5_000,
      expensesSen: 12_000,
      netProfitSen: 43_000,
    });
  });
});

describe('GET /accounting/reports/balance-sheet', () => {
  test('balances through current earnings — the self-check reads zero', async () => {
    const { app } = harness(WORLD);
    const res = await app.request('/accounting/reports/balance-sheet?asOf=2026-08-31');
    expect(res.status).toBe(200);
    const b = await res.json() as { totals: Record<string, number>; assets: Array<{ code: string; amountSen: number }> };
    // Bank 100k + 5k − 12k = 93k; stock 10k.
    expect(b.assets.map((l) => [l.code, l.amountSen])).toEqual([['310-0010', 93_000], ['330-0000', 10_000]]);
    expect(b.totals).toMatchObject({
      assetsSen: 103_000,
      liabilitiesSen: 60_000,
      equitySen: 0,
      earningsSen: 43_000,
      checkSen: 0,
    });
  });
});

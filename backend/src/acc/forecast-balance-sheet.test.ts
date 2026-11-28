import { describe, expect, test } from 'vitest';
import { FC_CASH, FC_DEPN, FC_PROFIT, bsDeltas, capReceipts, cumulate, forecastSheet, type StartSheet } from './forecast-balance-sheet';

const months = ['2026-11', '2026-12'];
const accounts = { ar: '300-0000', ap: '400-0000', accrual: '410-0010' };

describe('the movements', () => {
  test('each month adds up to zero: the accruals, the money, what was open at the start', () => {
    const d = bsDeltas({
      months, accounts,
      accruals: { '2026-11': { salesSen: 1_000, purchasesSen: 400, salariesSen: 200, depnSen: 30 }, '2026-12': { salesSen: 500, purchasesSen: 0, salariesSen: 200, depnSen: 0 } },
      moves: [
        { ym: '2026-11', sen: 600, against: '300-0000', flow: 'in' },
        { ym: '2026-12', sen: 400, against: '400-0000', flow: 'out' },
        { ym: '2026-12', sen: 50, against: FC_PROFIT, flow: 'out' },
        { ym: '2027-01', sen: 999, against: FC_PROFIT, flow: 'out' },
      ],
      openingBills: [{ ym: '2026-09', sen: 70 }, { ym: '2026-12', sen: 80 }],
      openingReceipts: [{ ym: '2026-11', sen: 25 }],
      openingSalarySen: 150,
    });
    for (const ym of months) expect(Object.values(d[ym]!).reduce((s, v) => s + v, 0)).toBe(0);
    expect(d['2026-11']).toEqual({
      '300-0000': 1_000 - 600 - 25, [FC_PROFIT]: -1_000 + 400 + 200 + 30, '400-0000': -400 + 70, '410-0010': -200 + 150,
      [FC_CASH]: 600 + 25 - 70 - 150, [FC_DEPN]: -30,
    });
    expect(d['2026-12']).toEqual({ '300-0000': 500, [FC_PROFIT]: -500 + 200 + 50, '400-0000': 400 + 80, [FC_CASH]: -200 - 400 - 50 - 80 });
  });

  test('without a salary accrual, salaries are left to the money that pays them', () => {
    const d = bsDeltas({
      months, accounts: { ...accounts, accrual: null },
      accruals: { '2026-11': { salesSen: 0, purchasesSen: 0, salariesSen: 200, depnSen: 0 } },
      moves: [], openingBills: [], openingReceipts: [], openingSalarySen: 150,
    });
    expect(d).toEqual({ '2026-11': {}, '2026-12': {} });
  });

  test("customers' money to come never beyond the start's debtors, the earliest dropped first", () => {
    const rows = [{ ym: '2026-12', sen: 300 }, { ym: '2026-11', sen: 200 }, { ym: '2026-12', sen: 100 }];
    expect(capReceipts(rows, 0)).toEqual([]);
    expect(capReceipts(rows, -50)).toEqual([]);
    expect(capReceipts(rows, 450)).toEqual([{ ym: '2026-11', sen: 50 }, { ym: '2026-12', sen: 400 }]);
    expect(capReceipts(rows, 5_000)).toEqual([{ ym: '2026-11', sen: 200 }, { ym: '2026-12', sen: 400 }]);
    expect(cumulate(months, { '2026-11': { A: 1 }, '2026-12': { A: 2, B: -2 } })).toEqual({ '2026-11': { A: 1 }, '2026-12': { A: 3, B: -2 } });
  });
});

describe("a month's sheet", () => {
  const start: StartSheet = {
    assets: [
      { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', section: 'CURRENT ASSETS', amountSen: -500 },
      { code: '310-0010', name: 'CASH AT BANK - SAMPLE BANK', section: 'CURRENT ASSETS', amountSen: 9_000 },
      { code: '202-1005', name: 'ACCUM. DEPRN. - EQUIPMENT (OFFICE)', section: 'FIXED ASSETS', amountSen: -100 },
    ],
    liabilities: [{ code: '400-0000', name: 'ACCOUNT PAYABLE', section: 'CURRENT LIABILITIES', amountSen: 2_000 }],
    equity: [{ code: '100-0000', name: 'CAPITAL', section: 'CAPITAL', amountSen: 6_000 }],
    earningsSen: 400,
  };
  const chartOf = (code: string) => (code === '460-0009' ? { name: 'TRADE FINANCE - SAMPLE BANK', side: 'liabilities' as const, section: 'LONG TERM LIABILITIES' } : null);
  const anchors = { cash: { code: '310-0010', section: 'CURRENT ASSETS' }, depn: { code: '202-1005', section: 'FIXED ASSETS' } };

  test('an asset up by a debit, a liability by a credit, a new account from the chart, the forecast lines beside their accounts, the profit on the earnings', () => {
    const f = forecastSheet(start, { '300-0000': 700, '400-0000': 300, '460-0009': -900, [FC_CASH]: 1_200, [FC_DEPN]: -30, [FC_PROFIT]: -1_270 }, chartOf, anchors);
    expect(f.assets).toEqual([
      { code: '300-0000', name: 'ACCOUNT RECEIVEABLE', section: 'CURRENT ASSETS', amountSen: 200 },
      { code: '310-0010', name: 'CASH AT BANK - SAMPLE BANK', section: 'CURRENT ASSETS', amountSen: 9_000 },
      { code: '202-1005', name: 'ACCUM. DEPRN. - EQUIPMENT (OFFICE)', section: 'FIXED ASSETS', amountSen: -100 },
      { code: '310-0010', key: FC_CASH, name: 'Forecast cash in / out (since the start)', label: 'Forecast cash in / out (since the start)', section: 'CURRENT ASSETS', amountSen: 1_200 },
      { code: '202-1005', key: FC_DEPN, name: 'Forecast depreciation (since the start)', label: 'Forecast depreciation (since the start)', section: 'FIXED ASSETS', amountSen: -30 },
    ]);
    expect(f.liabilities).toEqual([
      { code: '400-0000', name: 'ACCOUNT PAYABLE', section: 'CURRENT LIABILITIES', amountSen: 1_700 },
      { code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK', section: 'LONG TERM LIABILITIES', amountSen: 900 },
    ]);
    expect(f.earningsSen).toBe(1_670);
    const total = (ls: Array<{ amountSen: number }>) => ls.reduce((s, l) => s + l.amountSen, 0);
    expect(total(f.assets) - total(f.liabilities) - total(f.equity) - f.earningsSen).toBe(total(start.assets) - total(start.liabilities) - total(start.equity) - start.earningsSen);
  });

  test('a line moved to nothing goes; with nothing to file beside, the forecast lines stand alone', () => {
    const f = forecastSheet(start, { '400-0000': 2_000, [FC_CASH]: -2_000 }, () => null, { cash: null, depn: null });
    expect(f.liabilities).toEqual([]);
    expect(f.assets.at(-1)).toMatchObject({ code: FC_CASH, key: FC_CASH, section: 'CURRENT ASSETS', amountSen: -2_000 });
  });
});

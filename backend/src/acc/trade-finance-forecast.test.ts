/* The Cash Flow's trade-finance plan, the rules (step 5 of the forecast port;
   the door is backend/tests/cashFlowForecast.test.ts). Pinned: a facility is a
   liability named TRADE FINANCE, not the bank account of the same name; the
   repayments pay the oldest draws first; the rate per draw is the last six
   repayments' interest over their principal; a draw is repaid a tenor after
   it (past due in the current month) with its interest on the interest
   account; a chosen supplier's dues — owed bills, then Forecast P&L figures
   from the current month on — are drawn in their month unless unticked and
   repaid a tenor later; the months owed run on. Made-up names and figures. */
import { describe, expect, test } from 'vitest';
import type { CashLeg } from './cashflow-pnl-forecast';
import { defaultRateBp, interestOf, isFacilityAccount, lenderOf, openDraws, repayYm, supplierDues, tfPlan } from './trade-finance-forecast';

describe('the facility and its draws', () => {
  test('a liability named TRADE FINANCE, not its bank account; the lender from the name', () => {
    expect(isFacilityAccount({ name: 'TRADE FINANCE - SAMPLE BANK', type: 'LIABILITY', money: false })).toBe(true);
    expect(isFacilityAccount({ name: 'CASH AT BANK - SAMPLE BANK (TRADE FINANCE)', type: 'ASSET', money: true })).toBe(false);
    expect(isFacilityAccount({ name: 'LOAN - SAMPLE BANK', type: 'LIABILITY', money: false })).toBe(false);
    expect(lenderOf('TRADE FINANCE - SAMPLE BANK')).toBe('SAMPLE BANK');
    expect(lenderOf('TRADE FINANCE')).toBe('TRADE FINANCE');
  });

  test('the repayments pay the oldest draws first; the rate is the last six repayments’ interest over principal', () => {
    expect(openDraws([
      { date: '2026-08-31', debitSen: 0, creditSen: 100 },
      { date: '2026-09-14', debitSen: 0, creditSen: 200 },
      { date: '2026-10-20', debitSen: 150, creditSen: 0 },
      { date: '2026-11-05', debitSen: 0, creditSen: 50 },
    ])).toEqual([{ date: '2026-09-14', sen: 150 }, { date: '2026-11-05', sen: 50 }]);
    const rep = (date: string, principalSen: number, interestSen: number) => ({ date, principalSen, interestSen });
    /* The oldest of seven is left out; one with no interest does not count. */
    expect(defaultRateBp([rep('2026-01-01', 100, 50), ...['02', '03', '04', '05', '06'].map((m) => rep(`2026-${m}-01`, 10_000, 100)), rep('2026-07-01', 10_000, 200), rep('2026-08-01', 10_000, 0)])).toBe(117);
    expect(defaultRateBp([])).toBe(0);
    expect(repayYm('2026-11', 60)).toBe('2027-01');
    expect(repayYm('2026-11', 90)).toBe('2027-02');
    expect(interestOf(900_000, 67)).toBe(6_030);
  });
});

describe('the plan', () => {
  test("a chosen supplier's dues: an owed bill in its month, a past one in the current month; Forecast P&L figures from the current month on; a year at most", () => {
    expect(supplierDues({
      currentYm: '2026-11', lastYm: '2027-10', chosen: new Set(['A']),
      bills: [{ supplierId: 'A', ym: '2026-09', sen: 10 }, { supplierId: 'A', ym: '2026-12', sen: 20 }, { supplierId: 'B', ym: '2026-12', sen: 99 }, { supplierId: 'A', ym: '2028-01', sen: 5 }],
      forecast: [{ supplierId: 'A', ym: '2026-12', sen: 30 }, { supplierId: 'A', ym: '2026-10', sen: 7 }],
    })).toEqual({ A: { '2026-11': { billSen: 10, forecastSen: 0 }, '2026-12': { billSen: 20, forecastSen: 30 } } });
  });

  const brief = (legs: CashLeg[]) => legs.map((l) => `${l.ym} ${l.flow} ${l.key} ${l.sen}`).sort();
  const base = {
    currentYm: '2026-11', facility: { code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK', lender: 'SAMPLE BANK' },
    interest: { code: '900-L004', name: 'LOAN INTEREST' }, tenorDays: 60, rateBp: 100,
    supplierName: (id: string) => `Supplier ${id}`,
  };
  const months = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

  test('the owed draws repaid a tenor after them, a past-due one in the current month, each with its interest; the planned draws as ticked', () => {
    const r = tfPlan({
      ...base,
      open: [{ date: '2026-08-20', sen: 40_000 }, { date: '2026-11-05', sen: 50_000 }],
      dues: { A: { '2026-12': { billSen: 900_000, forecastSen: 0 }, '2027-01': { billSen: 0, forecastSen: 300_000 } }, B: { '2026-12': { billSen: 0, forecastSen: 100_000 } } },
      off: { '2027-01': ['A'] },
    }, months);
    expect(brief(r.legs)).toEqual([
      '2026-11 out 460-0009 40000', '2026-11 out 900-L004 400',
      '2026-12 in 460-0009:PLAN 1000000',
      '2027-01 out 460-0009 50000', '2027-01 out 900-L004 500',
      '2027-02 out 460-0009 1000000', '2027-02 out 900-L004 10000',
    ]);
    expect(r.legs.find((l) => l.key === '460-0009:PLAN')).toMatchObject({ name: 'Drawdown — planned', party: 'SAMPLE BANK', source: 'tf', note: 'pays Supplier A, Supplier B · forecast only' });
    expect(r.legs.find((l) => l.ym === '2026-11' && l.key === '460-0009')?.note).toBe('drawn 2026-08-20, repaid 2 months after (past due)');
    expect(r.schedule).toEqual([
      { ym: '2026-11', drawSen: 0, repaySen: 40_000, interestSen: 400, owedSen: 50_000 },
      { ym: '2026-12', drawSen: 1_000_000, repaySen: 0, interestSen: 0, owedSen: 1_050_000 },
      { ym: '2027-01', drawSen: 0, repaySen: 50_000, interestSen: 500, owedSen: 1_000_000 },
      { ym: '2027-02', drawSen: 0, repaySen: 1_000_000, interestSen: 10_000, owedSen: 0 },
      { ym: '2027-03', drawSen: 0, repaySen: 0, interestSen: 0, owedSen: 0 },
    ]);
  });

  test('no interest account, no interest leg; nothing chosen, nothing drawn', () => {
    const r = tfPlan({ ...base, interest: null, open: [{ date: '2026-10-01', sen: 10 }], dues: {}, off: {} }, months);
    expect(brief(r.legs)).toEqual(['2026-12 out 460-0009 10']);
  });
});

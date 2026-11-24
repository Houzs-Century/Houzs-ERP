/* The Cash Flow's forecast helpers (steps 2 and 4 of the forecast port): the
   columns — Actual | Orders & bills | P&L forecast, Orders & bills from the
   current month on — each forecast's balances run through on its own, and the
   note — its non-cash lines, a long list of suppliers without a term cut
   short, the orders in no month. The page's own test drives them through the
   screen (ReceiptsPayments.test.tsx). Made-up names and figures. */
import { describe, expect, it } from 'vitest';
import { fcKey, forecastColumns, forecastNote, fpKey, isForecastKey, rollForecast } from './cashFlowForecast';
import type { CashFlowForecast } from '../../../vendor/scm/lib/cash-flow-forecast-queries';
import type { RpReport } from '../../../vendor/scm/lib/rp-report-queries';
import type { StatementColumn } from './statementColumns';

const report = (opening: number, inSen: number, outSen: number): RpReport => ({
  from: '', to: '', byParty: false, columns: [{ code: 'FORECAST', name: 'P&L forecast' }], opening: { FORECAST: opening },
  receipts: [], payments: [], entries: [], card: { takingsSen: 0, transitSen: 0, codes: [] },
  totals: { receipts: {}, payments: {}, closing: {}, openingTotalSen: opening, receiptsTotalSen: inSen, paymentsTotalSen: outSen, closingTotalSen: opening + inSen - outSen },
  layout: { stored: true, tree: [], inSen, outSen },
});
const forecast = (o: Partial<CashFlowForecast> = {}): CashFlowForecast => ({
  from: '2026-10', to: '2026-11', currentMonth: '2026-11',
  months: [
    { month: '2026-10', future: false, report: report(0, 100, 40) },
    { month: '2026-11', future: false, report: report(0, 200, 50) },
    { month: '2026-12', future: true, report: report(0, 10, 300) },
    { month: '2027-01', future: true, report: report(0, 0, 0) },
  ],
  measured: { from: '2026-08-01', to: '2026-10-31' },
  receiptMix: [{ kind: 'DEP', months: 0, pct: 100 }],
  flagged: [], nonCash: [], docs: null, tf: null,
  ...o,
});
/* The Orders & bills column: November as at its 1st, then December and February (a month with nothing in between still shows). */
const docs = (o: Partial<NonNullable<CashFlowForecast['docs']>> = {}): NonNullable<CashFlowForecast['docs']> => ({
  months: [
    { month: '2026-11', future: false, report: report(0, 700, 100) },
    { month: '2026-12', future: true, report: report(0, 50, 400) },
    { month: '2027-01', future: true, report: report(0, 0, 0) },
    { month: '2027-02', future: true, report: report(0, 0, 25) },
  ],
  asAt: '2026-11-01', undated: [], beyond: { orders: 0, orderSen: 0, bills: 0, billSen: 0 }, flagged: [],
  ...o,
});
const MONTHS: StatementColumn[] = [
  { key: 'total', label: 'Total', kind: 'total', from: '2026-10-01', to: '2026-11-30', pct: true },
  { key: '2026-11', label: 'Nov 2026', sub: 'to 24/11/2026 *', kind: 'period', from: '2026-11-01', to: '2026-11-30', pct: true },
  { key: '2026-10', label: 'Oct 2026', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: true },
];

describe('the P&L forecast beside the months', () => {
  it('Total first; the later months newest first, forecast alone; then each month Actual | P&L forecast under its name', () => {
    const cols = forecastColumns(MONTHS, forecast());
    expect(cols.map((c) => [c.key, c.group?.label ?? '', c.label, c.mark ?? ''])).toEqual([
      ['total', '', 'Total', ''],
      ['fp:2027-01', 'Jan 2027', 'P&L forecast', 'gold'], ['fp:2026-12', 'Dec 2026', 'P&L forecast', 'gold'],
      ['2026-11', 'Nov 2026', 'Actual', 'petrol'], ['fp:2026-11', 'Nov 2026', 'P&L forecast', 'gold'],
      ['2026-10', 'Oct 2026', 'Actual', 'petrol'], ['fp:2026-10', 'Oct 2026', 'P&L forecast', 'gold'],
    ]);
    expect(cols[3]!.group).toEqual({ key: '2026-11', label: 'Nov 2026', sub: 'to 24/11/2026 *' });
    expect(cols[1]!).toMatchObject({ from: '2027-01-01', to: '2027-01-31', pct: false });
    expect(isForecastKey(fpKey('2026-10'))).toBe(true);
    expect(isForecastKey('2026-10')).toBe(false);
  });

  it("a month of the range starts from its own actual b/f; a later month from the forecast c/f before it; a month whose actual is not read runs on too", () => {
    const rolled = rollForecast(forecast(), { '2026-10': report(1_000, 0, 0), '2026-11': report(5_000, 0, 0) });
    expect(Object.entries(rolled).map(([k, r]) => [k, r.totals.openingTotalSen, r.totals.closingTotalSen, r.opening.FORECAST])).toEqual([
      ['fp:2026-10', 1_000, 1_060, 1_000],
      ['fp:2026-11', 5_000, 5_150, 5_000],
      ['fp:2026-12', 5_150, 4_860, 5_150],
      ['fp:2027-01', 4_860, 4_860, 4_860],
    ]);
    expect(rollForecast(forecast(), {})['fp:2026-11']!.totals.openingTotalSen).toBe(60);
  });

  it('the note says the receipts mix, the non-cash lines and at most twelve suppliers without a term', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, code: `400-${i}`, name: `Supplier ${String(i).padStart(2, '0')}` }));
    const note = forecastNote(forecast({
      receiptMix: [{ kind: 'DEP', months: 0, pct: 55.5 }, { kind: 'BAL', months: 2, pct: 44.5 }],
      nonCash: [{ code: '900-D001', name: 'DEPRECIATION' }],
      flagged: many,
    }));
    expect(note).toContain('as the customers paid from Aug 2026 to Oct 2026: 55.5% as deposits in the order month, 44.5% as settlements 2 months after.');
    expect(note).toContain('Left out as moving no cash: 900-D001 DEPRECIATION.');
    expect(note).toContain('(14): Supplier 00,');
    expect(note).toContain('Supplier 11 and 2 more.');
    expect(note).not.toContain('Supplier 12');
    expect(forecastNote(forecast())).not.toContain('No payment term');
    expect(forecastNote(forecast())).not.toContain('Orders & bills');
  });
});

describe('the Orders & bills column beside them', () => {
  it('from the current month on: each month Actual | Orders & bills | P&L forecast; a later month its forecasts alone, a month only one reaches with that one', () => {
    const cols = forecastColumns(MONTHS, forecast({ docs: docs() }));
    expect(cols.map((c) => [c.key, c.group?.label ?? '', c.label, c.mark ?? ''])).toEqual([
      ['total', '', 'Total', ''],
      ['fc:2027-02', 'Feb 2027', 'Orders & bills', 'brass'],
      ['fc:2027-01', 'Jan 2027', 'Orders & bills', 'brass'], ['fp:2027-01', 'Jan 2027', 'P&L forecast', 'gold'],
      ['fc:2026-12', 'Dec 2026', 'Orders & bills', 'brass'], ['fp:2026-12', 'Dec 2026', 'P&L forecast', 'gold'],
      ['2026-11', 'Nov 2026', 'Actual', 'petrol'], ['fc:2026-11', 'Nov 2026', 'Orders & bills', 'brass'], ['fp:2026-11', 'Nov 2026', 'P&L forecast', 'gold'],
      ['2026-10', 'Oct 2026', 'Actual', 'petrol'], ['fp:2026-10', 'Oct 2026', 'P&L forecast', 'gold'],
    ]);
    expect(cols[1]!).toMatchObject({ from: '2027-02-01', to: '2027-02-28', group: { key: '2027-02', label: 'Feb 2027', sub: 'Forecast only' } });
    expect(isForecastKey(fcKey('2026-11'))).toBe(true);
  });

  it('each forecast rolls on its own: Orders & bills from the current month’s actual b/f, then its own c/f', () => {
    const rolled = rollForecast(forecast({ docs: docs() }), { '2026-10': report(1_000, 0, 0), '2026-11': report(5_000, 0, 0) });
    expect(['fc:2026-11', 'fc:2026-12', 'fc:2027-01', 'fc:2027-02'].map((k) => [k, rolled[k]!.totals.openingTotalSen, rolled[k]!.totals.closingTotalSen])).toEqual([
      ['fc:2026-11', 5_000, 5_600], ['fc:2026-12', 5_600, 5_250], ['fc:2027-01', 5_250, 5_250], ['fc:2027-02', 5_250, 5_225],
    ]);
    expect(rolled['fp:2026-12']!.totals.openingTotalSen).toBe(5_150);
  });

  it('the note says what the column holds, the orders in no month by year, what falls after the last month, the bills timed without a term', () => {
    const note = forecastNote(forecast({ docs: docs({
      undated: [{ year: '2025', orders: 2, sen: 7_000_00 }, { year: '2026', orders: 1, sen: 1_000_00 }],
      beyond: { orders: 1, orderSen: 5_000_00, bills: 3, billSen: 12_34 },
      flagged: ['Beta Supplies'],
    }) }));
    expect(note.startsWith('Orders & bills: the money already in hand.')).toBe(true);
    expect(note).toContain('one whose delivery date had passed is in Nov 2026 on its own row.');
    expect(note).toContain('Open orders with no delivery date, in no month (3): 2 ordered in 2025, RM 7,000.00; 1 ordered in 2026, RM 1,000.00.');
    expect(note).toContain('Delivery after the last month shown: 1 open order, RM 5,000.00.');
    expect(note).toContain('Due after the last month shown: 3 bills, RM 12.34.');
    expect(note).toContain('Bills timed a month later for want of a payment term (1): Beta Supplies.');
    expect(forecastNote(forecast({ docs: docs() }))).not.toContain('in no month');
  });

  it('the trade-finance plan is said: what is owed, the tenor and rate, the suppliers it pays, the interest line left out', () => {
    const note = forecastNote(forecast({ tf: {
      facilities: [{ code: '460-0009', lender: 'SAMPLE BANK', tenorDays: 60, rateBp: 67, owedNowSen: 200_000, suppliers: ['Alpha Trading'] }],
      interestLeftOut: [{ code: '900-L004', name: 'LOAN INTEREST' }],
    } }));
    expect(note).toContain('Trade finance (SAMPLE BANK): RM 2,000.00 owed today, each draw repaid 2 months after it with 0.67% interest per draw; its planned draws pay Alpha Trading.');
    expect(note).toContain("The Forecast P&L's 900-L004 LOAN INTEREST is left out: the interest comes with each repayment.");
    expect(forecastNote(forecast({ tf: { facilities: [{ code: '460-0009', lender: 'B', tenorDays: 30, rateBp: 0, owedNowSen: 0, suppliers: [] }], interestLeftOut: [] } })))
      .toContain('Trade finance (B): RM 0.00 owed today, each draw repaid a month after it with 0.00% interest per draw.');
  });
});

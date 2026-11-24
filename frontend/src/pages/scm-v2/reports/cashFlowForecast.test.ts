/* The Cash Flow's P&L forecast helpers (step 2 of the forecast port): the
   columns, the balances run through, and the note — its non-cash lines and a
   long list of suppliers without a term cut short. The page's own test drives
   them through the screen (ReceiptsPayments.test.tsx). Made-up names. */
import { describe, expect, it } from 'vitest';
import { forecastColumns, forecastNote, fpKey, isForecastKey, rollForecast } from './cashFlowForecast';
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
  flagged: [], nonCash: [],
  ...o,
});

describe('the P&L forecast beside the months', () => {
  it('Total first; the later months newest first, forecast alone; then each month Actual | P&L forecast under its name', () => {
    const months: StatementColumn[] = [
      { key: 'total', label: 'Total', kind: 'total', from: '2026-10-01', to: '2026-11-30', pct: true },
      { key: '2026-11', label: 'Nov 2026', sub: 'to 24/11/2026 *', kind: 'period', from: '2026-11-01', to: '2026-11-30', pct: true },
      { key: '2026-10', label: 'Oct 2026', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: true },
    ];
    const cols = forecastColumns(months, forecast());
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
  });
});

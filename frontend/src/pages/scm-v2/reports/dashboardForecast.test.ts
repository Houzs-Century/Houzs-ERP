/* The Financial Dashboard's forecast helpers (step 7 of the forecast port):
   the span the card asks the forecast for, a period's two forecasts summed
   over its months (none when a month is missing), the tab's figure, actual
   less forecast. The page's own test drives them through the card
   (FinanceDashboard.test.tsx). Made-up figures. */
import { describe, expect, it } from 'vitest';
import { forecastSpan, gapOf, periodCashForecasts, pickCash } from './dashboardForecast';
import type { CashFlowForecast } from '../../../vendor/scm/lib/cash-flow-forecast-queries';

const m = (month: string, inSen: number, outSen: number) => ({ month, future: false, report: { totals: { receiptsTotalSen: inSen, paymentsTotalSen: outSen } } });
const F = {
  months: [m('2026-10', 100, 40), m('2026-11', 200, 50), m('2026-12', 300, 60)],
  docs: { months: [m('2026-11', 150, 70), m('2026-12', 120, 80)] },
} as unknown as CashFlowForecast;

describe('the forecasts per period', () => {
  it('the span: the periods\' first month to their last; none past 36 months', () => {
    expect(forecastSpan([{ months: ['2026-10', '2026-11', '2026-12'] }, { months: ['2026-07', '2026-08', '2026-09'] }])).toEqual({ from: '2026-07', to: '2026-12' });
    expect(forecastSpan([])).toEqual({ from: '', to: '' });
    expect(forecastSpan([{ months: ['2024-01'] }, { months: ['2027-01'] }])).toEqual({ from: '', to: '' });
  });

  it('a period sums its months; a month missing leaves that forecast out', () => {
    expect(periodCashForecasts(['2026-11'], F)).toEqual({ pnl: { inSen: 200, outSen: 50, netSen: 150 }, docs: { inSen: 150, outSen: 70, netSen: 80 } });
    /* A quarter: the P&L forecast covers it; Orders & bills starts in November. */
    expect(periodCashForecasts(['2026-10', '2026-11', '2026-12'], F)).toEqual({ pnl: { inSen: 600, outSen: 150, netSen: 450 }, docs: null });
    expect(periodCashForecasts(['2026-11'], undefined)).toEqual({ pnl: null, docs: null });
    expect(periodCashForecasts([], F)).toEqual({ pnl: null, docs: null });
  });

  it("the tab's figure; actual less forecast where both are there", () => {
    const f = { inSen: 10, outSen: 4, netSen: 6 };
    expect([pickCash(f, 'in'), pickCash(f, 'out'), pickCash(f, 'net'), pickCash(null, 'in')]).toEqual([10, 4, 6, null]);
    expect([gapOf(12, 10), gapOf(null, 10), gapOf(12, null)]).toEqual([2, null, null]);
  });
});

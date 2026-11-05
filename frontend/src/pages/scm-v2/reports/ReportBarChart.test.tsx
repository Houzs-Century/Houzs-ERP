// The reports' month chart (the owner's Claude Design, batch 6 §4.1): twelve
// months (up to twenty-four) that stay put while the period sits inside them,
// the period shaded with its labels petrol, net under each month (a loss
// red), the card beside a pointed column, and a click that opens the month.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { DashboardPeriod } from '../../../vendor/scm/lib/dashboard-queries';

const dash = vi.hoisted(() => ({ params: [] as unknown[] }));
vi.mock('../../../vendor/scm/lib/dashboard-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useFinanceDashboard: (p: { from: string | null; to: string | null }) => {
    dash.params.push(p);
    const months = ['2026-08', '2026-09', '2026-10'];
    const periods = months.map((m, i) => ({
      key: m, label: m, from: `${m}-01`, to: `${m}-28`, months: [m], partial: m === '2026-10',
      actual: { salesSen: 100_000 * (i + 1), costOfSalesSen: 60_000, grossProfitSen: 0, otherIncomeSen: 0, expensesSen: 30_000, staffCostSen: 0, otherExpensesSen: 0, profitBeforeTaxSen: 0, taxationSen: 0, netProfitSen: i === 0 ? -950_000 : 4_100_000 },
    })) as unknown as DashboardPeriod[];
    return { data: { periods, today: '2026-10-29' }, isLoading: false, isError: false };
  },
}));

import { nextChartWindow, windowMonths } from './chartWindow';
import { ReportBarChart, chartMonths, thousands, useChartMonths, useChartPeriods } from './ReportBarChart';
import { pnlChartMonth } from '../Reports';

describe('which months a chart shows', () => {
  test('twelve ending with the range’s last month; kept while the period sits inside; moved to the nearest edge', () => {
    const w = nextChartWindow(null, '2026-10-01', '2026-10-29');
    expect(w).toEqual({ from: '2025-11-01', to: '2026-10-01' });
    expect(windowMonths(w)).toHaveLength(12);
    /* A month inside: the window stays. */
    expect(nextChartWindow(w, '2026-03-01', '2026-03-31')).toBe(w);
    /* Past either edge: it moves to that edge. */
    expect(nextChartWindow(w, '2025-06-01', '2025-06-30')).toEqual({ from: '2025-06-01', to: '2026-05-01' });
    expect(nextChartWindow(w, '2026-12-01', '2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-01' });
    /* A longer range shows itself, up to twenty-four months. */
    expect(windowMonths(nextChartWindow(w, '2025-01-01', '2026-10-29'))).toHaveLength(22);
    expect(nextChartWindow(w, '2023-01-01', '2026-10-29')).toEqual({ from: '2024-11-01', to: '2026-10-01' });
  });

  test('RM thousand under the bars, a loss in brackets', () => {
    expect(thousands(4_100_000)).toBe('41');
    expect(thousands(-950_000)).toBe('(9.5)');
    expect(thousands(-1_250_000)).toBe('(13)');
    expect(thousands(40_000)).toBe('0.4');
  });
});

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>;
};
function PnlChartHarness() {
  const win = useChartMonths('2026-09-01', '2026-09-30', true);
  const p = useChartPeriods(win);
  return (
    <ReportBarChart
      title="Revenue, cost and expenses"
      series={[{ key: 'revenue', label: 'Revenue', color: '#16695f' }, { key: 'cost', label: 'Cost of sales', color: '#d8a85a' }, { key: 'opex', label: 'Operating expenses', color: '#a3a99b' }]}
      months={chartMonths(win, p.byMonth, pnlChartMonth)}
      win={win}
      loading={p.isLoading}
      failed={p.isError}
      note="A note."
    />
  );
}
const at = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<><PnlChartHarness /><Where /></>} /></Routes></MemoryRouter>,
);

describe('the P&L chart', () => {
  test('one read of the window; the period shaded, its label petrol; net profit under each month, a loss red', () => {
    const { container } = at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30');
    expect(dash.params.at(-1)).toEqual({ granularity: 'month', from: '2025-10', to: '2026-09' });
    expect(screen.getByLabelText('Revenue, cost and expenses · Oct 25 – Sep 26')).toBeTruthy();
    const shade = container.querySelectorAll('[data-shade]');
    expect(shade).toHaveLength(1);
    const notes = [...container.querySelectorAll('[data-note]')].map((n) => n.textContent);
    expect(notes).toEqual(['(9.5)', '41']);
    expect((container.querySelector('[data-note]') as SVGElement).style.fill).toContain('a83434');
    /* Three bars for each month with figures. */
    expect(container.querySelectorAll('rect[data-group="revenue"]')).toHaveLength(2);
  });

  test('pointing at a month shows its card beside it; a click opens that month', () => {
    const { container } = at('/scm/accounting?tab=pnl&from=2026-09-01&to=2026-09-30');
    const sep = container.querySelector('[data-pick="11"]')!;
    fireEvent.mouseEnter(sep);
    const card = screen.getByRole('tooltip');
    expect(card.textContent).toContain('September 2026');
    expect(card.textContent).toContain('In the period');
    expect(card.textContent).toContain('Revenue2,000.00');
    expect(card.textContent).toContain('Net profit41,000.00');
    expect(card.textContent).toContain('Net margin2050.0%');
    expect(card.textContent).toContain('Click to open this month');
    fireEvent.click(container.querySelector('[data-pick="10"]')!);
    expect(screen.getByLabelText('address').textContent).toBe('/scm/accounting?tab=pnl&from=2026-08-01&to=2026-08-31');
  });
});

import { describe, expect, it } from 'vitest';
import { bsForecastColumns, bsForecastNote, fbKey } from './bsForecast';
import type { BsForecast } from '../../../vendor/scm/lib/bs-forecast-queries';
import type { StatementColumn } from './statementColumns';

const f = (o: Partial<BsForecast<unknown>> = {}): BsForecast<unknown> => ({
  start: '2026-10-31', currentMonth: '2026-11', accrual: null, receipts: { orders: 0, sen: 0, capSen: 0, countedSen: 0 },
  months: [{ month: '2026-11', report: {} }, { month: '2026-12', report: {} }], ...o,
});
const cols: StatementColumn[] = [
  { key: '2026-11', label: 'Nov 2026', sub: 'to 24/11/2026 *', kind: 'period', from: '2026-11-01', to: '2026-11-24', pct: true },
  { key: '2026-10', label: 'Oct 2026', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: true },
];

describe('the forecast beside the month-ends', () => {
  it('a later month its forecast alone; the current month Actual | Forecast; an earlier one as it is; forecast figures do not open', () => {
    const out = bsForecastColumns(cols, f());
    expect(out.map((c) => [c.key, c.group?.label ?? '', c.label, c.mark ?? '', c.noDrill === true])).toEqual([
      ['fb:2026-12', 'Dec 2026', 'Forecast', 'gold', true],
      ['2026-11', 'Nov 2026', 'Actual', 'petrol', false],
      ['fb:2026-11', 'Nov 2026', 'Forecast', 'gold', true],
      ['2026-10', '', 'Oct 2026', '', false],
    ]);
    expect(out[2]).toMatchObject({ from: '2026-11-01', to: '2026-11-30' });
    expect(out[0]!.group).toEqual({ key: '2026-12', label: 'Dec 2026', sub: 'Forecast only' });
    expect(fbKey('2026-12')).toBe('fb:2026-12');
  });

  it('the note: where it starts, what moves it, the order balances counted or not', () => {
    expect(bsForecastNote(f())).toContain('Forecast: from the actual sheet at the end of Oct 2026, each month moved by the Forecast P&L — its sales owed by customers, its purchases owed to suppliers, its depreciation');
    expect(bsForecastNote(f({ accrual: { code: '410-0010', name: 'ACCRUAL - SALARIES' } }))).toContain('its salaries owed on 410-0010 ACCRUAL - SALARIES and paid the month after');
    expect(bsForecastNote(f({ receipts: { orders: 2, sen: 150_000, capSen: 100_000, countedSen: 100_000 } })))
      .toContain("Open orders' balances at the start: RM 1,500.00 on 2 orders; RM 1,000.00 counted as they are delivered — never beyond the debtors on the start sheet.");
    expect(bsForecastNote(f({ receipts: { orders: 2, sen: 150_000, capSen: 0, countedSen: 0 } }))).toContain('are not counted: the debtors on the start sheet were not above zero.');
    expect(bsForecastNote(f())).not.toContain('Open orders');
  });
});

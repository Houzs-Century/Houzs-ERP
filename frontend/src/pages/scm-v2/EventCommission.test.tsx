/* The Event Commission tab (owner 2026-10-20): the fairs starting in the range
   with the event page's estimate and what their orders earned, a fair opening
   to its orders and their upsales / drop sales, and what happened to earlier
   fairs' orders in the range. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { EventCommission } from '../../vendor/scm/lib/event-queries';

const REPORT: EventCommission = {
  from: '2026-10-01', to: '2026-10-31',
  fairs: [
    {
      id: 363, name: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', startDate: '2026-10-02', endDate: '2026-10-05',
      ratePct: 14, totalSalesRm: 484746, estimateRm: 67864.44, payableSen: 140_00,
      sos: [
        {
          docNo: 'HC-SO-2610-001', salesperson: 'Ethan', customer: 'Tan', goodsSen: 1_000_00, totalSen: 1_100_00, paidSen: 400_00, paidPct: 36.4,
          reachedOn: '2026-10-02', commissionSen: 140_00,
          changes: [
            { date: '2026-10-02', deltaGoodsSen: -50_00, kind: 'drop', notCounted: 'opening_day', source: 'edit', changedBy: 'Ethan' },
            { date: '2026-10-15', deltaGoodsSen: 150_00, kind: 'upsale', notCounted: null, source: 'amendment', changedBy: 'Siti' },
          ],
        },
        { docNo: 'HC-SO-2610-002', salesperson: 'Mayson', customer: 'Lee', goodsSen: 500_00, totalSen: 500_00, paidSen: 100_00, paidPct: 20, reachedOn: null, commissionSen: 0, changes: [] },
      ],
    },
    { id: 400, name: 'Johor [ZANOTTI] HOMELOVE @ IOI MALL KULAI', brand: 'NOCARD', startDate: '2026-10-20', endDate: '2026-10-23', ratePct: null, totalSalesRm: null, estimateRm: null, payableSen: 0, sos: [] },
  ],
  adjustments: [
    { date: '2026-10-10', kind: 'reached', docNo: 'HC-SO-2609-050', fairId: 2214, fairName: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', salesperson: 'Jason', goodsSen: 1_100_00, commissionSen: 143_00, beforeReach: false },
    { date: '2026-10-12', kind: 'cancelled', docNo: 'HC-SO-2609-051', fairId: 2214, fairName: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', salesperson: 'Jason', goodsSen: 1_000_00, commissionSen: -130_00, beforeReach: false },
    { date: '2026-10-03', kind: 'upsale', docNo: 'HC-SO-2609-052', fairId: 2214, fairName: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', salesperson: 'Jason', goodsSen: 100_00, commissionSen: 0, beforeReach: true },
  ],
  totals: { payableSen: 140_00, adjustmentsSen: 13_00, totalSen: 153_00 },
};

vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCommission: () => ({ data: REPORT, isLoading: false, isError: false, error: null }),
}));

import { EventCommissionTab, eventCommissionCsv } from './EventCommission';

describe('the Event Commission tab', () => {
  test('each fair shows its rate, the event page estimate and what its orders earned; a fair with no rate card says so', () => {
    render(<EventCommissionTab />);
    const fairs = screen.getAllByRole('table')[0]!;
    const akemi = within(fairs).getByText(/BIGHOME @ MID VALLEY/).closest('tr')!;
    expect(akemi.textContent).toContain('14%');
    expect(akemi.textContent).toContain('484,746.00');
    expect(akemi.textContent).toContain('67,864.44');
    expect(akemi.textContent).toContain('140.00');
    expect(within(fairs).getByText('no rate card')).toBeTruthy();
    expect(screen.getByText(/Total commission/).textContent).toContain('153.00');
  });

  test('a fair opens to its orders: paid share, the day 30% was reached, and the upsales / drops — an opening-day fix marked not counted', () => {
    render(<EventCommissionTab />);
    fireEvent.click(screen.getByText(/BIGHOME @ MID VALLEY/));
    const first = screen.getByText('HC-SO-2610-001').closest('tr')!;
    expect(first.textContent).toContain('(36.4%)');
    expect(first.textContent).toContain('+RM 150.00');
    expect(first.textContent).toContain('amendment');
    expect(first.textContent).toContain('opening-day fix, not counted');
    expect(screen.getByText('HC-SO-2610-002').closest('tr')!.textContent).toContain('not yet');
  });

  test('earlier fairs list what happened in the range; a change before 30% says it waits; a cancellation takes back', () => {
    render(<EventCommissionTab />);
    const earlier = screen.getAllByRole('table')[1]!;
    expect(within(earlier).getByText('Reached 30%')).toBeTruthy();
    expect(within(earlier).getByText('HC-SO-2609-051').closest('tr')!.textContent).toContain('(130.00)');
    expect(within(earlier).getByText(/before 30% — counted when reached/)).toBeTruthy();
  });

  test('the CSV carries both parts and the total', () => {
    const csv = eventCommissionCsv(REPORT);
    expect(csv).toContain('"HC-SO-2610-001","Ethan","1,000.00","36.4","2026-10-02","140.00"');
    expect(csv).toContain('"Cancelled","HC-SO-2609-051","Jason","1,000.00","(130.00)"');
    expect(csv.trim().endsWith('"153.00"')).toBe(true);
  });
});

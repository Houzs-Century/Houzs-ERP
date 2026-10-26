/* The Event Commission tab (owner 2026-10-20): the fairs starting in the range
   with the event page's estimate and what their orders earned, a fair opening
   to its orders and their upsales / drop sales, and what happened to earlier
   fairs' orders in the range. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { EventCommission } from '../../vendor/scm/lib/event-queries';

const REPORT: EventCommission = {
  basis: 'fair', from: '2026-10-01', to: '2026-10-31',
  fairs: [
    {
      id: 363, name: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', startDate: '2026-10-02', endDate: '2026-10-05',
      ratePct: 14, totalSalesRm: 484746, estimateRm: 67864.44, payableSen: 140_00,
      sos: [
        {
          docNo: 'HC-SO-2610-001', soDate: '2026-10-02', salesperson: 'Ethan', customer: 'Tan', goodsSen: 1_000_00, totalSen: 1_100_00, paidSen: 400_00, paidPct: 36.4,
          reachedOn: '2026-10-02', commissionSen: 140_00,
          changes: [
            { date: '2026-10-02', deltaGoodsSen: -50_00, kind: 'drop', notCounted: 'opening_day', source: 'edit', changedBy: 'Ethan' },
            { date: '2026-10-15', deltaGoodsSen: 150_00, kind: 'upsale', notCounted: null, source: 'amendment', changedBy: 'Siti' },
          ],
        },
        { docNo: 'HC-SO-2610-002', soDate: '2026-10-03', salesperson: 'Mayson', customer: 'Lee', goodsSen: 500_00, totalSen: 500_00, paidSen: 100_00, paidPct: 20, reachedOn: null, commissionSen: 0, changes: [] },
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

/* By SO date: the orders opened in the range under their fairs — one of them on
   a fair that started in September. */
const BY_SO_DATE: EventCommission = {
  ...REPORT, basis: 'so_date',
  fairs: [{
    id: 2214, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', startDate: '2026-09-28', endDate: '2026-10-02',
    ratePct: 13, totalSalesRm: 114240, estimateRm: 14851.2, payableSen: 130_00,
    sos: [{ docNo: 'HC-SO-2610-010', soDate: '2026-10-01', salesperson: 'Jason', customer: 'Wong', goodsSen: 1_000_00, totalSen: 1_100_00, paidSen: 400_00, paidPct: 36.4, reachedOn: '2026-10-01', commissionSen: 130_00, changes: [] }],
  }],
  adjustments: [],
  totals: { payableSen: 130_00, adjustmentsSen: 0, totalSen: 130_00 },
};
const asked: string[] = [];

vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCommission: (_from: string, _to: string, basis = 'fair') => {
    asked.push(basis);
    return { data: basis === 'so_date' ? BY_SO_DATE : REPORT, isLoading: false, isError: false, error: null };
  },
}));

import { EventCommissionTab, basisOf, brandsOf, eventCommissionCsv, fairLines, forBrand } from './EventCommission';

describe('the Event Commission tab', () => {
  test('each fair shows its rate, the event page estimate and what its orders earned; a fair with no rate card says so', () => {
    render(<EventCommissionTab />);
    const fairs = screen.getAllByRole('table')[0]!;
    const akemi = within(fairs).getByText('[AKEMI] BIGHOME').closest('tr')!;
    expect(akemi.textContent).toContain('MID VALLEY · Kuala Lumpur');
    expect(akemi.textContent).toContain('14%');
    expect(akemi.textContent).toContain('484,746.00');
    expect(akemi.textContent).toContain('67,864.44');
    expect(akemi.textContent).toContain('140.00');
    /* A fair with no orders yet is folded away under the table — open it to see it. */
    expect(within(fairs).queryByText('no rate card')).toBeNull();
    fireEvent.click(screen.getByText('1 fair with no orders yet'));
    expect(within(screen.getAllByRole('table')[0]!).getByText('no rate card')).toBeTruthy();
    expect(screen.getByText('Total commission').parentElement!.textContent).toContain('RM 153.00');
  });

  test('a fair opens to its orders: paid share, the day 30% was reached, and the upsales / drops — an opening-day fix marked not counted', () => {
    render(<EventCommissionTab />);
    fireEvent.click(screen.getByText('[AKEMI] BIGHOME'));
    const first = screen.getByText('HC-SO-2610-001').closest('tr')!;
    expect(first.textContent).toContain('36.4%');
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
    expect(csv).toContain('"HC-SO-2610-001","2026-10-02","Ethan","1,000.00","36.4","2026-10-02","140.00"');
    expect(csv).toContain('"Cancelled","HC-SO-2609-051","Jason","1,000.00","(130.00)"');
    expect(csv.trim().endsWith('"153.00"')).toBe(true);
  });

  test('By SO date asks for the orders opened in the range: the words change, the fair-wide Total Sales and estimate drop out', () => {
    render(<EventCommissionTab />);
    expect(screen.getByRole('button', { name: 'By fair' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    expect(asked.at(-1)).toBe('so_date');
    expect(screen.getByText('Orders opened in the range (SO date), by fair', { exact: false })).toBeTruthy();
    expect(screen.queryByText('Total sales')).toBeNull();
    const fairs = screen.getAllByRole('table')[0]!;
    fireEvent.click(within(fairs).getByText('[ZANOTTI] BIGHOME'));
    expect(screen.getByText('HC-SO-2610-010').closest('tr')!.textContent).toContain('2026/10/01');
    expect(screen.getByText(/Nothing on earlier orders in this range/)).toBeTruthy();
    expect(eventCommissionCsv(BY_SO_DATE)).toContain('"Earlier orders","Date"');
  });
  test('a report from a server older than the toggle (no basis) reads as by fair and its CSV still writes', () => {
    const { basis: _drop, ...old } = REPORT;
    void _drop;
    expect(basisOf(old)).toBe('fair');
    expect(eventCommissionCsv(old)).toContain('"Earlier fairs","Date"');
  });
});

/* Owner 2026-10-21: 这个页面优化，很乱 → 1 可以，2 不要，3 要，做，要有header.
   2026-10-25: 这个header，table 要和 pv 那边一样能调整，能换位 / 这个点开排版好看一点. */
describe('the Event Commission layout', () => {
  test('the tables are the system table: Columns to hide or move them, a Total row at the foot', () => {
    render(<EventCommissionTab />);
    /* The fairs table and the earlier one each have their Columns drawer. */
    expect(screen.getAllByRole('button', { name: /columns/i }).length).toBeGreaterThanOrEqual(2);
    const fairs = screen.getAllByRole('table')[0]!;
    const foot = fairs.querySelector('tfoot')!;
    expect(foot.textContent).toContain('484,746.00');
    expect(foot.textContent).toContain('140.00');
    const earlierFoot = screen.getAllByRole('table')[1]!.querySelector('tfoot')!;
    expect(earlierFoot.textContent).toContain('13.00');
  });

  test('a fair opens to a compact table of its orders: what they came to, Paid and Paid % apart, upsales green, drops red, a subtotal', () => {
    render(<EventCommissionTab />);
    fireEvent.click(screen.getByText('[AKEMI] BIGHOME'));
    expect(screen.getByText(/reached 30%/).parentElement!.textContent).toContain('2 orders · 1 reached 30% · commission RM 140.00');
    const first = screen.getByText('HC-SO-2610-001').closest('tr')!;
    const cells = [...first.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells).toContain('400.00');
    expect(cells).toContain('36.4%');
    expect(within(first).getByText('+RM 150.00').className).toContain('text-synced');
    const orders = screen.getByText('HC-SO-2610-001').closest('table')!;
    const foot = orders.querySelector('tfoot')!.textContent;
    expect(foot).toContain('1,500.00');
    expect(foot).toContain('500.00');
    expect(foot).toContain('140.00');
    expect(foot).toContain('31.3%');
  });

  test('a fair is named on two lines with the state capitals evened out; any other name is kept whole', () => {
    expect(fairLines('Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY')).toEqual({ title: '[AKEMI] BIGHOME', detail: 'MID VALLEY · Kuala Lumpur', brand: 'AKEMI' });
    expect(fairLines('PULAU PINANG [ZANOTTI] HOMEDEC @ SETIA SPICE CONVENTION CENTRE').detail).toBe('SETIA SPICE CONVENTION CENTRE · Pulau Pinang');
    expect(fairLines('Kuala Lumpur [AKEMI] KAI HAO (KL, CHEN) @ SUNWAY KLUANG MALL').title).toBe('[AKEMI] KAI HAO (KL, CHEN)');
    expect(fairLines('Warehouse clearance')).toEqual({ title: 'Warehouse clearance', detail: '', brand: null });
  });

  test('four cards, Total commission first; the column headings stay put while the list scrolls', () => {
    render(<EventCommissionTab />);
    const labels = ['Total commission', 'Fairs in the range', 'Earlier fairs', 'Fairs'];
    for (const l of labels) expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    expect(screen.getByText('Fairs').parentElement!.textContent).toContain('1 with no orders yet');
    const head = screen.getAllByRole('table')[0]!.querySelector('thead')!;
    expect(head.className.split(/\s+/)).toContain('sticky');
  });

  test('the brand filter narrows the cards, both tables and the export to one brand', () => {
    expect(brandsOf(REPORT)).toEqual(['AKEMI', 'NOCARD', 'ZANOTTI']);
    const z = forBrand(REPORT, 'ZANOTTI');
    expect(z.fairs).toHaveLength(0);
    expect(z.adjustments).toHaveLength(3);
    expect(z.totals).toEqual({ payableSen: 0, adjustmentsSen: 13_00, totalSen: 13_00 });
    expect(forBrand(REPORT, '')).toBe(REPORT);

    render(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'ZANOTTI' }));
    expect(screen.getByText('Total commission').parentElement!.textContent).toContain('RM 13.00');
    expect(screen.getByText('No fair starts in this range.')).toBeTruthy();
    expect(screen.queryByText('[AKEMI] BIGHOME')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All brands' }));
    expect(screen.getByText('[AKEMI] BIGHOME')).toBeTruthy();
  });
});

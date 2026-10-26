/* The Event Commission tab (owner 2026-10-20): the fairs starting in the range
   with the event page's estimate and what their orders earned, a fair opening
   to its orders and their upsales / drop sales, and what happened to earlier
   fairs' orders in the range. 2026-10-26: brand / organizer / venue / state a
   column each, the earlier orders once per order (Original → Latest, Amended),
   and every order the range changed in an Upsales / Drop sales table. 2026-10-27:
   closing a month (关月) — a closed month shown as closed, Close / Reopen behind
   a confirm, and the first open month carrying the closed months' adjustments. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EventCommission } from '../../vendor/scm/lib/event-queries';

const ZAN_PLACE = { fairId: 2214, fairName: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor', salesperson: 'Jason', customer: 'Wong', ratePct: 13 };

const REPORT: EventCommission = {
  basis: 'fair', from: '2026-10-01', to: '2026-10-31',
  fairs: [
    {
      id: 363, name: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur',
      startDate: '2026-10-02', endDate: '2026-10-05',
      ratePct: 14, totalSalesRm: 484746, estimateRm: 67864.44, payableSen: 140_00,
      sos: [
        {
          docNo: 'HC-SO-2610-001', soDate: '2026-10-02', salesperson: 'Ethan', customer: 'Tan', goodsSen: 1_000_00, totalSen: 1_100_00, paidSen: 400_00, paidPct: 36.4,
          reachedOn: '2026-10-02', commissionSen: 140_00,
          changes: [
            { date: '2026-10-02', deltaGoodsSen: -50_00, kind: 'drop', notCounted: 'opening_day', source: 'edit', changedBy: 'Ethan' },
            { date: '2026-10-15', deltaGoodsSen: 150_00, kind: 'upsale', notCounted: null, source: 'amendment', changedBy: 'Siti', fromHistory: true },
          ],
        },
        { docNo: 'HC-SO-2610-002', soDate: '2026-10-03', salesperson: 'Mayson', customer: 'Lee', goodsSen: 500_00, totalSen: 500_00, paidSen: 100_00, paidPct: 20, reachedOn: null, commissionSen: 0, changes: [] },
      ],
    },
    /* No organizer / venue / state from the server: read off the name. */
    { id: 400, name: 'Johor [ZANOTTI] HOMELOVE @ IOI MALL KULAI', brand: 'NOCARD', startDate: '2026-10-20', endDate: '2026-10-23', ratePct: null, totalSalesRm: null, estimateRm: null, payableSen: 0, sos: [] },
  ],
  adjustments: [
    { date: '2026-10-10', kind: 'reached', docNo: 'HC-SO-2609-050', fairId: 2214, fairName: ZAN_PLACE.fairName, salesperson: 'Jason', goodsSen: 1_100_00, commissionSen: 143_00, beforeReach: false },
    { date: '2026-10-12', kind: 'cancelled', docNo: 'HC-SO-2609-051', fairId: 2214, fairName: ZAN_PLACE.fairName, salesperson: 'Jason', goodsSen: 1_000_00, commissionSen: -130_00, beforeReach: false },
    { date: '2026-10-03', kind: 'upsale', docNo: 'HC-SO-2609-052', fairId: 2214, fairName: ZAN_PLACE.fairName, salesperson: 'Jason', goodsSen: 100_00, commissionSen: 0, beforeReach: true },
  ],
  earlierOrders: [
    { ...ZAN_PLACE, docNo: 'HC-SO-2609-052', events: [{ date: '2026-10-03', kind: 'upsale', beforeReach: true }], lastDate: '2026-10-03', originalSen: 900_00, latestSen: 1_000_00, amendedSen: 100_00, commissionSen: 0, fromHistory: true },
    { ...ZAN_PLACE, docNo: 'HC-SO-2609-050', events: [{ date: '2026-10-10', kind: 'reached', beforeReach: false }], lastDate: '2026-10-10', originalSen: 1_100_00, latestSen: 1_100_00, amendedSen: 0, commissionSen: 143_00, fromHistory: false },
    { ...ZAN_PLACE, docNo: 'HC-SO-2609-051', events: [{ date: '2026-10-12', kind: 'cancelled', beforeReach: false }], lastDate: '2026-10-12', originalSen: 1_000_00, latestSen: 1_000_00, amendedSen: 0, commissionSen: -130_00, fromHistory: false },
  ],
  changedOrders: [
    {
      docNo: 'HC-SO-2610-001', fairId: 363, fairName: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur',
      salesperson: 'Ethan', customer: 'Tan', ratePct: 14, part: 'range', lastChange: '2026-10-15',
      originalSen: 850_00, latestSen: 1_000_00, amendedSen: 150_00, reachedOn: '2026-10-02', effectSen: 21_00, fromHistory: true,
    },
    { ...ZAN_PLACE, docNo: 'HC-SO-2609-053', part: 'earlier', lastChange: '2026-10-21', originalSen: 1_000_00, latestSen: 600_00, amendedSen: -400_00, reachedOn: null, effectSen: 0, fromHistory: false },
  ],
  totals: { payableSen: 140_00, adjustmentsSen: 13_00, totalSen: 153_00 },
};

/* By SO date: the orders opened in the range under their fairs — one of them on
   a fair that started in September. */
const BY_SO_DATE: EventCommission = {
  ...REPORT, basis: 'so_date',
  fairs: [{
    id: 2214, name: 'SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', brand: 'ZANOTTI', organizer: 'BIGHOME', venue: 'SUNWAY PYRAMID', state: 'Selangor',
    startDate: '2026-09-28', endDate: '2026-10-02',
    ratePct: 13, totalSalesRm: 114240, estimateRm: 14851.2, payableSen: 130_00,
    sos: [{ docNo: 'HC-SO-2610-010', soDate: '2026-10-01', salesperson: 'Jason', customer: 'Wong', goodsSen: 1_000_00, totalSen: 1_100_00, paidSen: 400_00, paidPct: 36.4, reachedOn: '2026-10-01', commissionSen: 130_00, changes: [] }],
  }],
  adjustments: [], earlierOrders: [], changedOrders: [],
  totals: { payableSen: 130_00, adjustmentsSen: 0, totalSen: 130_00 },
};
const asked: string[] = [];
/* A test that needs another report (a closed month, the adjustments) sets it here. */
let current: EventCommission | null = null;
const closeMonth = vi.fn();
const reopenMonth = vi.fn();
const confirmAsk = vi.fn(async () => true);

vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCommission: (_from: string, _to: string, basis = 'fair') => {
    asked.push(basis);
    return { data: current ?? (basis === 'so_date' ? BY_SO_DATE : REPORT), isLoading: false, isError: false, error: null };
  },
  useCloseCommissionMonth: () => ({ mutate: closeMonth, isPending: false }),
  useReopenCommissionMonth: () => ({ mutate: reopenMonth, isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmAsk }));
afterEach(() => { current = null; vi.useRealTimers(); });

import { EventCommissionTab, basisOf, brandsOf, eventCommissionCsv, fairLines, fairPlace, forBrand } from './EventCommission';

const tables = () => screen.getAllByRole('table');
const rowOf = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr')!;
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => td.textContent);

describe('the Event Commission tab', () => {
  test('each fair: brand, organizer, venue and state a column each, its rate, the event page estimate and what its orders earned', () => {
    render(<EventCommissionTab />);
    const cells = cellsOf(rowOf(tables()[0]!, 'MID VALLEY'));
    for (const t of ['AKEMI', 'BIGHOME', 'MID VALLEY', 'Kuala Lumpur', '14%', '484,746.00', '67,864.44', '140.00']) expect(cells).toContain(t);
    /* A fair with no orders yet is folded away under the table — open it to see
       it, its place read off its name. */
    expect(within(tables()[0]!).queryByText('no rate card')).toBeNull();
    fireEvent.click(screen.getByText('1 fair with no orders yet'));
    const idle = rowOf(tables()[0]!, 'IOI MALL KULAI');
    expect(idle.textContent).toContain('no rate card');
    expect(cellsOf(idle)).toEqual(expect.arrayContaining(['NOCARD', 'HOMELOVE', 'Johor']));
    expect(screen.getByText('Total commission').parentElement!.textContent).toContain('RM 153.00');
  });

  test('a fair opens to its orders: paid share, the day 30% was reached, and the upsales / drops — an opening-day fix marked not counted', () => {
    render(<EventCommissionTab />);
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    const first = within(tables()[0]!).getByText('HC-SO-2610-001').closest('tr')!;
    expect(first.textContent).toContain('36.4%');
    expect(first.textContent).toContain('+RM 150.00');
    expect(first.textContent).toContain('amendment');
    expect(first.textContent).toContain('opening-day fix, not counted');
    expect(within(tables()[0]!).getByText('HC-SO-2610-002').closest('tr')!.textContent).toContain('not yet');
  });

  test('earlier orders read once each: what happened, Original → Latest, Amended, the commission it moved', () => {
    render(<EventCommissionTab />);
    const earlier = tables()[1]!;
    const reached = rowOf(earlier, 'HC-SO-2609-050');
    expect(reached.textContent).toContain('Reached 30%');
    expect(cellsOf(reached)).toContain('143.00');
    expect(cellsOf(rowOf(earlier, 'HC-SO-2609-051'))).toContain('(130.00)');
    const waiting = rowOf(earlier, 'HC-SO-2609-052');
    expect(waiting.textContent).toContain('Upsale (before 30%)');
    expect(waiting.textContent).toContain('from history');
    expect(cellsOf(waiting)).toEqual(expect.arrayContaining(['900.00', '1,000.00', '+100.00']));
    expect(earlier.querySelector('tfoot')!.textContent).toContain('13.00');
  });

  test('every order the range changed, once: its final amount, + green / − red, the effect at the brand rate, not yet 30% says so', () => {
    render(<EventCommissionTab />);
    const changes = tables()[2]!;
    const up = rowOf(changes, 'HC-SO-2610-001');
    expect(cellsOf(up)).toEqual(expect.arrayContaining(['850.00', '1,000.00', '+150.00', '14%', '21.00']));
    expect(within(up).getByText('+150.00').className).toContain('text-synced');
    expect(up.textContent).toContain('from history');
    const down = rowOf(changes, 'HC-SO-2609-053');
    expect(within(down).getByText('−400.00').className).toContain('text-err');
    expect(down.textContent).toContain('not yet 30%');
  });

  test('the CSV carries the fairs, the earlier orders once each, the upsales / drop sales and the total', () => {
    const csv = eventCommissionCsv(REPORT);
    expect(csv).toContain('"HC-SO-2610-001","2026-10-02","Ethan","1,000.00","36.4","2026-10-02","140.00"');
    expect(csv).toContain('"2026-10-12","Cancelled","HC-SO-2609-051","Jason","1,000.00","1,000.00","0.00","(130.00)"');
    expect(csv).toContain('"Upsales / drop sales","Last change"');
    expect(csv).toContain('"2026-10-15","HC-SO-2610-001","Ethan","850.00","1,000.00","150.00","14","21.00"');
    expect(csv.trim().endsWith('"153.00"')).toBe(true);
  });

  test('By SO date asks for the orders opened in the range: the words change, the fair-wide Total Sales and estimate drop out', () => {
    render(<EventCommissionTab />);
    expect(screen.getByRole('button', { name: 'By fair' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    expect(asked.at(-1)).toBe('so_date');
    expect(screen.getByText('Orders opened in the range (SO date), by fair', { exact: false })).toBeTruthy();
    expect(screen.queryByText('Total sales')).toBeNull();
    fireEvent.click(within(tables()[0]!).getByText('SUNWAY PYRAMID'));
    expect(screen.getByText('HC-SO-2610-010').closest('tr')!.textContent).toContain('2026/10/01');
    expect(screen.getByText(/Nothing on earlier orders in this range/)).toBeTruthy();
    expect(screen.getByText('No upsale or drop sale in this range.')).toBeTruthy();
    expect(eventCommissionCsv(BY_SO_DATE)).toContain('"Earlier orders","Date"');
  });

  test('a report from a server older than the toggle or the order lists reads as by fair, its lists empty', () => {
    const { basis: _drop, earlierOrders: _e, changedOrders: _c, ...old } = REPORT;
    void _drop; void _e; void _c;
    expect(basisOf(old)).toBe('fair');
    expect(eventCommissionCsv(old)).toContain('"Earlier fairs","Date"');
  });
});

/* Owner 2026-10-21: 这个页面优化，很乱 → 1 可以，2 不要，3 要，做，要有header.
   2026-10-25: 这个header，table 要和 pv 那边一样能调整，能换位 / 这个点开排版好看一点.
   2026-10-26: 做宽一点 / brand, organizer, venue 全部一个column. */
describe('the Event Commission layout', () => {
  test('the tables are the system table: Columns to hide or move them, a Total row at the foot, set widths that fit the page', () => {
    render(<EventCommissionTab />);
    expect(screen.getAllByRole('button', { name: /columns/i }).length).toBeGreaterThanOrEqual(3);
    const fairs = tables()[0]!;
    const foot = fairs.querySelector('tfoot')!;
    expect(foot.textContent).toContain('484,746.00');
    expect(foot.textContent).toContain('140.00');
    /* The fair columns carry their own widths; together they fit about 1,250px. */
    const widths = [...fairs.querySelectorAll('thead th')].map((th) => parseFloat((th as HTMLElement).style.width) || 0);
    const total = widths.reduce((s, w) => s + w, 0);
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThanOrEqual(1260);
  });

  test('a fair opens to a compact table of its orders: what they came to, Paid and Paid % apart, upsales green, drops red, a subtotal', () => {
    render(<EventCommissionTab />);
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    expect(screen.getByText(/reached 30%/).parentElement!.textContent).toContain('2 orders · 1 reached 30% · commission RM 140.00');
    const first = within(tables()[0]!).getByText('HC-SO-2610-001').closest('tr')!;
    expect(cellsOf(first)).toEqual(expect.arrayContaining(['400.00', '36.4%']));
    expect(within(first).getByText('+RM 150.00').className).toContain('text-synced');
    const orders = within(tables()[0]!).getByText('HC-SO-2610-001').closest('table')!;
    const foot = orders.querySelector('tfoot')!.textContent;
    expect(foot).toContain('1,500.00');
    expect(foot).toContain('500.00');
    expect(foot).toContain('140.00');
    expect(foot).toContain('31.3%');
  });

  test('a fair\'s name reads into brand, organizer, venue and state; the project\'s own values win; any other name is kept whole', () => {
    expect(fairLines('Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY')).toMatchObject({ title: '[AKEMI] BIGHOME', detail: 'MID VALLEY · Kuala Lumpur', brand: 'AKEMI', organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur' });
    expect(fairLines('PULAU PINANG [ZANOTTI] HOMEDEC @ SETIA SPICE CONVENTION CENTRE').detail).toBe('SETIA SPICE CONVENTION CENTRE · Pulau Pinang');
    expect(fairLines('Kuala Lumpur [AKEMI] KAI HAO (KL, CHEN) @ SUNWAY KLUANG MALL').title).toBe('[AKEMI] KAI HAO (KL, CHEN)');
    expect(fairLines('Warehouse clearance')).toMatchObject({ title: 'Warehouse clearance', detail: '', brand: null });
    expect(fairPlace({ name: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'akemi', organizer: 'BIG HOME', venue: null, state: '' }))
      .toEqual({ brand: 'AKEMI', organizer: 'BIG HOME', venue: 'MID VALLEY', state: 'Kuala Lumpur' });
  });

  test('the brand filter narrows the cards, every table and the export to one brand', () => {
    expect(brandsOf(REPORT)).toEqual(['AKEMI', 'NOCARD', 'ZANOTTI']);
    const z = forBrand(REPORT, 'ZANOTTI');
    expect(z.fairs).toHaveLength(0);
    expect(z.adjustments).toHaveLength(3);
    expect(z.earlierOrders).toHaveLength(3);
    expect(z.changedOrders!.map((o) => o.docNo)).toEqual(['HC-SO-2609-053']);
    expect(z.totals).toEqual({ payableSen: 0, adjustmentsSen: 13_00, monthAdjustmentsSen: 0, totalSen: 13_00 });
    expect(forBrand(REPORT, '')).toBe(REPORT);

    render(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'ZANOTTI' }));
    expect(screen.getByText('Total commission').parentElement!.textContent).toContain('RM 13.00');
    expect(screen.getByText('No fair starts in this range.')).toBeTruthy();
    expect(screen.queryByText('MID VALLEY')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All brands' }));
    expect(screen.getAllByText('MID VALLEY').length).toBeGreaterThan(0);
  });
});

describe('closing a month — 关月 (owner 2026-10-26)', () => {
  const MONTH_ADJ = [{
    month: '2026-09', docNo: 'HC-SO-2609-051', fairId: 2214, fairName: ZAN_PLACE.fairName, brand: 'ZANOTTI', salesperson: 'Wei Pin', customer: 'Lim',
    wasSen: 0, nowSen: 130_00, adjustmentSen: 130_00,
  }];

  test('a closed month reads as closed — when and by whom — and the latest offers Reopen behind a confirm', async () => {
    current = {
      ...REPORT, from: '2026-09-01', to: '2026-09-30',
      closed: { month: '2026-09', closedAt: '2026-10-26T09:00:00Z', closedBy: 'Finance Chew' }, closes: { months: ['2026-09'], openFrom: '2026-10' },
    };
    render(<EventCommissionTab />);
    expect(screen.getByText('September 2026 is closed')).toBeTruthy();
    expect(screen.getByText(/by Finance Chew/).textContent).toContain('paid in October 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Reopen September 2026' }));
    await waitFor(() => expect(reopenMonth).toHaveBeenCalledWith('2026-09'));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reopen September 2026?' }));
  });

  test('a whole month that has ended and is next in line can be closed; the month not ended yet cannot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T04:00:00Z'));
    current = { ...REPORT, closes: { months: [], openFrom: null } };
    render(<EventCommissionTab />);
    expect(screen.getByText('No month closed yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull(); // October has not ended
    fireEvent.click(screen.getByRole('button', { name: 'Last month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close September 2026' }));
    await waitFor(() => expect(closeMonth).toHaveBeenCalledWith('2026-09'));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close September 2026?', body: expect.stringContaining('RM 153.00') }));
  });

  test('the first open month pays the closed months\' adjustments: a card, its table, in the total and the export', () => {
    current = {
      ...REPORT, monthAdjustments: MONTH_ADJ, closes: { months: ['2026-09'], openFrom: '2026-10' },
      totals: { ...REPORT.totals, monthAdjustmentsSen: 130_00, totalSen: 283_00 },
    };
    render(<EventCommissionTab />);
    expect(screen.getByText('Closed up to September 2026.')).toBeTruthy();
    expect(screen.getByText('Total commission').parentElement!.textContent).toContain('RM 283.00');
    expect(screen.getByText('Closed months — adjustments', { selector: 'div' }).parentElement!.textContent).toContain('1 order · Sep 2026');
    const cells = cellsOf(rowOf(tables()[2]!, 'HC-SO-2609-051'));
    for (const t of ['Sep 2026', 'ZANOTTI', 'Wei Pin', '+130.00']) expect(cells).toContain(t);
    const csv = eventCommissionCsv(current);
    expect(csv).toContain('"Closed months — adjustments","Month","Order"');
    expect(csv).toContain('"2026-09","HC-SO-2609-051","Wei Pin","0.00","130.00","130.00"');
    expect(forBrand(current, 'AKEMI').totals).toEqual({ payableSen: 140_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, totalSen: 140_00 });
  });
});

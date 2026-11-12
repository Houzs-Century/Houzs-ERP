/* The Event Commission tab (owner 2026-10-20): the fairs starting in the range
   with the event page's estimate and what their orders earned, a fair opening
   to its orders and their upsales / drop sales, and what happened to earlier
   fairs' orders in the range. 2026-10-26: brand / organizer / venue / state a
   column each, the earlier orders once per order (Original → Latest, Amended),
   and every order the range changed in an Upsales / Drop sales table. 2026-10-27:
   closing a month (关月) — a closed month shown as closed, Close / Reopen behind
   a confirm, and the first open month carrying the closed months' adjustments.
   2026-11-12 (round 3): the tiles are the summary lines and add up to the total,
   a fair's Total Sales is its orders' goods, By SO date one row per order, the
   orders under 30% apart, order numbers are links, the view kept for Back, and
   Finance's two buttons — don't count / next month — each undoable. */

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
const markOrder = vi.fn();
const unmarkOrder = vi.fn();
const confirmAsk = vi.fn(async () => true);
const promptAsk = vi.fn(async (): Promise<string | null> => 'checking the price');

vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventCommission: (_from: string, _to: string, basis = 'fair') => {
    asked.push(basis);
    return { data: current ?? (basis === 'so_date' ? BY_SO_DATE : REPORT), isLoading: false, isError: false, error: null };
  },
  useCloseCommissionMonth: () => ({ mutate: closeMonth, isPending: false }),
  useReopenCommissionMonth: () => ({ mutate: reopenMonth, isPending: false }),
  useMarkCommissionOrder: () => ({ mutate: markOrder, isPending: false }),
  useUnmarkCommissionOrder: () => ({ mutate: unmarkOrder, isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmAsk, usePrompt: () => promptAsk }));
afterEach(() => { current = null; vi.useRealTimers(); sessionStorage.clear(); vi.clearAllMocks(); });

import { MemoryRouter } from 'react-router-dom';
import { EventCommissionTab } from './EventCommission';
import { basisOf, brandsOf, eventCommissionCsv, eventCommissionSheet, fairLines, fairPlace, forBrand, orderLines, summaryOf } from './eventCommissionModel';

/* The report reads the shared range (the report shell's): no dates in the address → This month. */
const renderTab = (ui: React.ReactElement) => render(<MemoryRouter initialEntries={['/scm/accounting?tab=commission']}>{ui}</MemoryRouter>);
/** A tile's label and the figure under it (the redesign's tiles: no RM on the figure). */
const tile = (label: string) => within(screen.getByRole('group', { name: 'Totals' })).getByText(label).parentElement!.textContent;

const tables = () => screen.getAllByRole('table');
const rowOf = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr')!;
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => td.textContent);

describe('the Event Commission tab', () => {
  test("each fair: brand, organizer, venue and state a column each, its rate, its orders' goods as Total sales, those × the rate, what its orders earned", () => {
    renderTab(<EventCommissionTab />);
    const cells = cellsOf(rowOf(tables()[0]!, 'MID VALLEY'));
    for (const t of ['AKEMI', 'BIGHOME', 'MID VALLEY', 'Kuala Lumpur', '14%', '1,500.00', '210.00', '140.00']) expect(cells).toContain(t);
    /* The event page's typed figure is a hidden column now, not the Total sales. */
    expect(cells).not.toContain('484,746.00');
    /* A fair with no orders yet is folded away under the table — open it to see
       it, its place read off its name. */
    expect(within(tables()[0]!).queryByText('no rate card')).toBeNull();
    fireEvent.click(screen.getByText('1 fair with no orders yet'));
    const idle = rowOf(tables()[0]!, 'IOI MALL KULAI');
    expect(idle.textContent).toContain('no rate card');
    expect(cellsOf(idle)).toEqual(expect.arrayContaining(['NOCARD', 'HOMELOVE', 'Johor']));
    expect(tile('Total commission')).toContain('153.00');
  });

  test('a fair opens to its orders: paid share, the day 30% was reached, and the upsales / drops — an opening-day fix marked not counted', () => {
    renderTab(<EventCommissionTab />);
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    const first = within(tables()[0]!).getByText('HC-SO-2610-001').closest('tr')!;
    expect(first.textContent).toContain('36.4%');
    expect(first.textContent).toContain('+RM 150.00');
    expect(first.textContent).toContain('amendment');
    expect(first.textContent).toContain('opening-day fix, not counted');
    expect(within(tables()[0]!).getByText('HC-SO-2610-002').closest('tr')!.textContent).toContain('not yet');
  });

  test('earlier orders read once each: what happened, Original → Latest, Amended, the commission it moved', () => {
    renderTab(<EventCommissionTab />);
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
    renderTab(<EventCommissionTab />);
    const changes = tables()[2]!;
    const up = rowOf(changes, 'HC-SO-2610-001');
    expect(cellsOf(up)).toEqual(expect.arrayContaining(['850.00', '1,000.00', '+150.00', '14%', '21.00']));
    expect(within(up).getByText('+150.00').className).toContain('text-synced');
    expect(up.textContent).toContain('from history');
    const down = rowOf(changes, 'HC-SO-2609-053');
    expect(within(down).getByText('−400.00').className).toContain('text-err');
    expect(down.textContent).toContain('not yet 30%');
  });

  test('the CSV: the summary lines, then every order once with its commission split over them; both add up to the total', () => {
    const csv = eventCommissionCsv(REPORT);
    expect(csv).toContain('"Fair commission","119.00"');
    expect(csv).toContain('"Upsales / drop sales","21.00"');
    expect(csv).toContain('"Late bills (补开单)","0.00"');
    expect(csv).toContain('"Earlier orders","13.00"');
    expect(csv).toContain('"Total","153.00"');
    expect(csv).toContain('"HC-SO-2610-001","","Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY","AKEMI","Ethan","2026-10-02","1,000.00","36.4%","2026-10-02","119.00","21.00","0.00","0.00","0.00","0.00","140.00","",""');
    expect(csv).toContain('"HC-SO-2609-051","","SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID","ZANOTTI","Jason"');
    expect(csv.trim().split('\n').at(-1)).toBe('"Total","","","","","","","","","119.00","21.00","0.00","13.00","0.00","0.00","153.00","",""');
  });

  test('the summary lines add up to the total; a late bill (补开单) is all on its own line', () => {
    expect(summaryOf(REPORT)).toEqual({ fair: 119_00, changes: 21_00, late: 0, earlier: 13_00, monthAdj: 0, deferredIn: 0, totalSen: 153_00 });
    const late = { ...REPORT, lateBills: ['HC-SO-2609-050'] };
    expect(summaryOf(late)).toEqual({ fair: 119_00, changes: 21_00, late: 143_00, earlier: -130_00, monthAdj: 0, deferredIn: 0, totalSen: 153_00 });
    expect(orderLines(late).find((l) => l.docNo === 'HC-SO-2609-050')!.split.late).toBe(143_00);
    renderTab(<EventCommissionTab />);
    expect(tile('Fair commission')).toContain('119.00');
    expect(tile('Upsales / drop sales')).toContain('21.00');
    expect(tile('Late bills (补开单)')).toContain('0 orders');
    expect(tile('Earlier fairs')).toContain('13.00');
  });

  test('By SO date is a list of the orders opened in the range, one row each, the fair as columns', () => {
    renderTab(<EventCommissionTab />);
    expect(screen.getByRole('button', { name: 'By fair' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    expect(asked.at(-1)).toBe('so_date');
    expect(screen.getByText('Orders opened in the range (SO date)')).toBeTruthy();
    expect(screen.queryByText('Total sales')).toBeNull();
    const row = cellsOf(rowOf(tables()[0]!, 'HC-SO-2610-010'));
    for (const t of ['2026/10/01', 'ZANOTTI', 'BIGHOME', 'SUNWAY PYRAMID', 'Jason', '36.4%', '130.00']) expect(row).toContain(t);
    expect(screen.getByText(/Nothing on earlier orders in this range/)).toBeTruthy();
    expect(screen.getByText('No upsale or drop sale in this range.')).toBeTruthy();
  });

  test('a report from a server older than the toggle or the order lists reads as by fair, its lists empty', () => {
    const { basis: _drop, earlierOrders: _e, changedOrders: _c, ...old } = REPORT;
    void _drop; void _e; void _c;
    expect(basisOf(old)).toBe('fair');
    expect(eventCommissionCsv(old)).toContain('"Total","153.00"');
  });
});

/* Owner 2026-10-21: 这个页面优化，很乱 → 1 可以，2 不要，3 要，做，要有header.
   2026-10-25: 这个header，table 要和 pv 那边一样能调整，能换位 / 这个点开排版好看一点.
   2026-10-26: 做宽一点 / brand, organizer, venue 全部一个column. */
describe('the redesign (batch 6 §5.11)', () => {
  test('Excel and PDF: the summary, the fairs, then every order once with its split; the CSV sits under the header’s ⋯; an order number is a link', () => {
    const sheet = eventCommissionSheet(REPORT, 'October 2026', '');
    expect(sheet.title).toBe('Event commission');
    expect(sheet.subtitle).toBe('October 2026 · by fair · all brands · total 153.00 · RM');
    expect(sheet.tables[0]!.rows.map((r) => [r.label, r.cells[0]])).toEqual([
      ['Fair commission', 119_00], ['Upsales / drop sales', 21_00], ['Late bills (补开单)', 0], ['Earlier orders', 13_00],
      ['Closed months — adjustments', 0], ['Moved from last month', 0], ['Total commission', 153_00],
    ]);
    expect(sheet.tables[1]!.columns.map((c) => c.label)).toEqual(['Dates', 'Rate', 'Total sales', 'Estimate', 'Orders', 'Commission']);
    expect(sheet.tables[1]!.rows.at(-1)).toMatchObject({ kind: 'total', cells: [null, null, 0, 0, null, 140_00] });
    expect(sheet.tables[2]!.rows.at(-1)).toMatchObject({ kind: 'total', label: 'Every order' });
    /* By SO date has no fair table: the summary, then every order. */
    expect(eventCommissionSheet(BY_SO_DATE, 'October 2026', '').tables).toHaveLength(2);

    renderTab(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'CSV' })).toBeTruthy();
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    const link = within(tables()[0]!).getByRole('link', { name: 'HC-SO-2610-001' });
    expect(link.getAttribute('title')).toBe('Open HC-SO-2610-001');
    expect(link.getAttribute('href')).toBe('/scm/sales-orders/HC-SO-2610-001');
    /* A plain click is the app's own tab; a Ctrl-click (or a right-click) is the browser's. */
    expect(fireEvent.click(link)).toBe(false);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    /* The % says what it is a % of (headers read in Title Case app-wide). */
    expect(within(tables()[0]!).getByText('Paid · % of Order')).toBeTruthy();
  });
});

describe('the Event Commission layout', () => {
  test('the tables are the system table: Columns to hide or move them, a Total row at the foot, set widths that fit the page', () => {
    renderTab(<EventCommissionTab />);
    expect(screen.getAllByRole('button', { name: /columns/i }).length).toBeGreaterThanOrEqual(3);
    const fairs = tables()[0]!;
    const foot = fairs.querySelector('tfoot')!;
    expect(foot.textContent).toContain('1,500.00');
    expect(foot.textContent).toContain('140.00');
    /* The fair columns carry their own widths; together they fit about 1,250px. */
    const widths = [...fairs.querySelectorAll('thead th')].map((th) => parseFloat((th as HTMLElement).style.width) || 0);
    const total = widths.reduce((s, w) => s + w, 0);
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThanOrEqual(1260);
  });

  test('a fair opens to a compact table of its orders: what they came to, Paid and Paid % apart, upsales green, drops red, a subtotal', () => {
    renderTab(<EventCommissionTab />);
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
    expect(z.totals).toEqual({ payableSen: 0, adjustmentsSen: 13_00, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 13_00 });
    expect(forBrand(REPORT, '')).toBe(REPORT);

    renderTab(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'ZANOTTI' }));
    expect(tile('Total commission')).toContain('13.00');
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
    renderTab(<EventCommissionTab />);
    expect(screen.getByText('2026/09 is closed')).toBeTruthy();
    expect(screen.getByText(/by Finance Chew/).textContent).toContain('paid in 2026/10');
    fireEvent.click(screen.getByRole('button', { name: 'Reopen 2026/09' }));
    await waitFor(() => expect(reopenMonth).toHaveBeenCalledWith('2026-09'));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reopen 2026/09?' }));
  });

  test('a whole month that has ended and is next in line can be closed; the month not ended yet cannot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T04:00:00Z'));
    current = { ...REPORT, closes: { months: [], openFrom: null } };
    renderTab(<EventCommissionTab />);
    expect(screen.getByText('No month closed yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Close / })).toBeNull(); // October has not ended
    /* Last month is one of the shared picker's presets now. */
    fireEvent.click(screen.getByRole('button', { name: /^Report dates/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Last month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close 2026/09' }));
    await waitFor(() => expect(closeMonth).toHaveBeenCalledWith('2026-09'));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Close 2026/09?', body: expect.stringContaining('RM 153.00') }));
  });

  test('the first open month pays the closed months\' adjustments: a card, its table, in the total and the export', () => {
    current = {
      ...REPORT, monthAdjustments: MONTH_ADJ, closes: { months: ['2026-09'], openFrom: '2026-10' },
      totals: { ...REPORT.totals, monthAdjustmentsSen: 130_00, totalSen: 283_00 },
    };
    renderTab(<EventCommissionTab />);
    expect(screen.getByText('Closed up to 2026/09.')).toBeTruthy();
    expect(tile('Total commission')).toContain('283.00');
    expect(tile('Closed months — adjustments')).toContain('1 order · 2026/09');
    const cells = cellsOf(rowOf(tables()[2]!, 'HC-SO-2609-051'));
    for (const t of ['2026/09', 'ZANOTTI', 'Wei Pin', '+130.00']) expect(cells).toContain(t);
    const csv = eventCommissionCsv(current);
    expect(csv).toContain('"Closed months — adjustments","130.00"');
    expect(csv).toContain('"Total","283.00"');
    expect(forBrand(current, 'AKEMI').totals).toEqual({ payableSen: 140_00, adjustmentsSen: 0, monthAdjustmentsSen: 0, deferredInSen: 0, totalSen: 140_00 });
  });
});

describe('round 3 (owner 2026-11-12)', () => {
  const october = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T04:00:00Z')); };

  test('the orders under 30% have a card of their own: what is still owed before they earn', () => {
    renderTab(<EventCommissionTab />);
    const card = screen.getByRole('region', { name: 'Below 30% paid' });
    const cells = cellsOf(within(card).getByText('HC-SO-2610-002').closest('tr')!);
    for (const t of ['Mayson', '500.00', '100.00', '20%', '50.00']) expect(cells).toContain(t);
  });

  test("「这张单不要算」 / 「这个算下个月」: on a whole open month each order has both, each asking for a reason", async () => {
    october();
    renderTab(<EventCommissionTab />);
    const earlier = within(tables()[1]!).getByText('HC-SO-2609-050').closest('tr')!;
    fireEvent.click(within(earlier).getByRole('button', { name: "Don't count" }));
    await waitFor(() => expect(markOrder).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-050', kind: 'exclude', reason: 'checking the price' }));
    expect(promptAsk).toHaveBeenCalledWith(expect.objectContaining({ title: "Don't count HC-SO-2609-050?" }));
    fireEvent.click(within(earlier).getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(markOrder).toHaveBeenCalledWith({ docNo: 'HC-SO-2609-050', kind: 'defer', month: '2026-10', reason: 'checking the price' }));
    expect(promptAsk).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Pay HC-SO-2609-050 in 2026/11?' }));
    /* Cancelled at the prompt: nothing is marked. */
    markOrder.mockClear();
    promptAsk.mockResolvedValueOnce(null);
    fireEvent.click(within(earlier).getByRole('button', { name: "Don't count" }));
    await waitFor(() => expect(promptAsk).toHaveBeenCalledTimes(3));
    expect(markOrder).not.toHaveBeenCalled();
  });

  test('a closed month shows no buttons', () => {
    october();
    current = { ...REPORT, from: '2026-09-01', to: '2026-09-30', closed: { month: '2026-09', closedAt: '2026-10-26T09:00:00Z', closedBy: 'Finance' }, closes: { months: ['2026-09'], openFrom: '2026-10' } };
    renderTab(<EventCommissionTab />);
    expect(screen.queryByRole('button', { name: "Don't count" })).toBeNull();
  });

  test('a marked order earns nothing here: its row says so with Undo, it is listed apart, and Undo asks first', async () => {
    october();
    const mark = { id: '3f0c1d7e-2b1a-4c5d-9e8f-0a1b2c3d4e5f', kind: 'exclude' as const, month: null, reason: 'price to check', markedBy: 'Finance Chew', markedAt: '2026-11-12T03:00:00Z' };
    current = {
      ...REPORT,
      earlierOrders: REPORT.earlierOrders!.map((o) => (o.docNo === 'HC-SO-2609-050' ? { ...o, commissionSen: 0, mark } : o)),
      adjustments: REPORT.adjustments.map((a) => (a.docNo === 'HC-SO-2609-050' ? { ...a, commissionSen: 0 } : a)),
      marked: [{ ...ZAN_PLACE, docNo: 'HC-SO-2609-050', mark, commissionSen: 143_00 }],
      totals: { payableSen: 140_00, adjustmentsSen: -130_00, totalSen: 10_00 },
    };
    renderTab(<EventCommissionTab />);
    expect(tile('Total commission')).toContain('10.00');
    const row = within(tables()[1]!).getByText('HC-SO-2609-050').closest('tr')!;
    expect(row.textContent).toContain('Not counted');
    const listed = screen.getByRole('region', { name: 'Marked — not paid here' });
    expect(listed.querySelector('tfoot')!.textContent).toContain('143.00');
    expect(cellsOf(within(listed).getByText('HC-SO-2609-050').closest('tr')!)).toEqual(expect.arrayContaining(['Not counted', 'price to check', 'Finance Chew', '143.00']));
    fireEvent.click(within(row).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(unmarkOrder).toHaveBeenCalledWith(mark.id));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Take away "Not counted"?' }));
  });

  test('what last month moved here has a card, a tile, and is in the total', () => {
    const mark = { id: 'm1', kind: 'defer' as const, month: '2026-09', reason: 'paid late', markedBy: 'Finance', markedAt: '2026-10-01T03:00:00Z' };
    current = {
      ...REPORT,
      deferredIn: [{ ...ZAN_PLACE, docNo: 'HC-SO-2609-060', fromMonth: '2026-09', mark, commissionSen: 50_00 }],
      totals: { ...REPORT.totals, deferredInSen: 50_00, totalSen: 203_00 },
    };
    renderTab(<EventCommissionTab />);
    expect(tile('Total commission')).toContain('203.00');
    expect(tile('Moved from last month')).toContain('50.00');
    const card = screen.getByRole('region', { name: 'Moved from last month' });
    expect(cellsOf(within(card).getByText('HC-SO-2609-060').closest('tr')!)).toEqual(expect.arrayContaining(['2026/09', 'paid late', '50.00']));
    expect(summaryOf(current).deferredIn).toBe(50_00);
  });

  test('coming back keeps the view and the open fairs', () => {
    const first = renderTab(<EventCommissionTab />);
    expect(within(tables()[0]!).queryByText('HC-SO-2610-001')).toBeNull();
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    expect(within(tables()[0]!).getByText('HC-SO-2610-001')).toBeTruthy();
    first.unmount();
    renderTab(<EventCommissionTab />);
    expect(within(tables()[0]!).getByText('HC-SO-2610-001')).toBeTruthy();
  });
});

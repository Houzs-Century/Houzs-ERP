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
   Finance's two buttons — don't count / next month — each undoable. Later that
   day: a price change left out on the Upsales / Drop sales table (「只是改价不算」),
   and the SO list with the fair's full name and the order's Sales. Then: the
   earlier orders only those that reached 30% or were cancelled, their price
   changes left to the Upsales / Drop sales table. */

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
const addLine = vi.fn();
const removeLine = vi.fn();
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
  useAddCommissionLine: () => ({ mutate: addLine, isPending: false }),
  useRemoveCommissionLine: () => ({ mutate: removeLine, isPending: false }),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmAsk, usePrompt: () => promptAsk }));
afterEach(() => { current = null; vi.useRealTimers(); sessionStorage.clear(); vi.clearAllMocks(); });

import { MemoryRouter } from 'react-router-dom';
import { EventCommissionTab } from './EventCommission';
import { basisOf, brandsOf, cardsOf, earlierShownOf, eventCommissionCsv, eventCommissionSheet, fairLines, fairPlace, fmtRm, forBrand, insideFirstOf, whatOf } from './eventCommissionModel';

/* The report reads the shared range (the report shell's): no dates in the address → This month. */
const renderTab = (ui: React.ReactElement) => render(<MemoryRouter initialEntries={['/scm/accounting?tab=commission']}>{ui}</MemoryRouter>);
/** A tile's label and the figure under it (the redesign's tiles: no RM on the figure). */
const tile = (label: string) => within(screen.getByRole('group', { name: 'Totals' })).getByText(label).parentElement!.textContent;
/** The tiles' labels, in their order. */
const tileLabels = () => [...screen.getByRole('group', { name: 'Totals' }).children].map((el) => el.firstElementChild!.textContent);
/** The cards' keys and figures. */
const cardSens = (r: EventCommission) => cardsOf(r).map((c) => [c.key, c.sen]);

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

  test('earlier orders: only those that reached 30% or were cancelled, on their original amount — a price change is the Upsales / Drop sales table\'s', () => {
    renderTab(<EventCommissionTab />);
    expect(screen.getByText('Earlier fairs — reached 30% or cancelled in the range')).toBeTruthy();
    const earlier = tables()[1]!;
    const reached = rowOf(earlier, 'HC-SO-2609-050');
    expect(reached.textContent).toContain('Reached 30%');
    expect(cellsOf(reached)).toEqual(expect.arrayContaining(['1,100.00', '13%', '143.00']));
    expect(cellsOf(rowOf(earlier, 'HC-SO-2609-051'))).toContain('(130.00)');
    /* Only priced up before 30%: not an earlier order to list here. */
    expect(within(earlier).queryByText('HC-SO-2609-052')).toBeNull();
    expect(within(earlier).queryByText('Latest')).toBeNull();
    expect(earlier.querySelector('tfoot')!.textContent).toContain('13.00');
    expect(tile('Earlier fairs')).toContain('2 orders');
  });

  test('an earlier order that reached 30% and was priced in the range shows the reach on its original amount; the change stays in Upsales / Drop sales', () => {
    /* HC-SO-2609-397's shape: 15,776 dropped to 7,888 before 30%, reached 30% in
       the range — 1,104.32 on the order; the drop's −1,104.32 is the Upsales /
       Drop sales table's, so the earlier table shows 2,208.64 on 15,776. And an
       order reached, then priced up after 30%: the reach alone here. */
    const SHAPED: EventCommission = {
      ...REPORT,
      earlierOrders: [
        {
          ...ZAN_PLACE, ratePct: 14, docNo: 'HC-SO-2609-397', lastDate: '2026-10-21', originalSen: 15_776_00, latestSen: 7_888_00, amendedSen: -7_888_00,
          events: [{ date: '2026-10-05', kind: 'drop', beforeReach: true }, { date: '2026-10-21', kind: 'reached', beforeReach: false }],
          commissionSen: 1_104_32, fromHistory: true,
        },
        {
          ...ZAN_PLACE, docNo: 'HC-SO-2609-060', lastDate: '2026-10-25', originalSen: 1_000_00, latestSen: 1_200_00, amendedSen: 200_00,
          events: [{ date: '2026-10-08', kind: 'reached', beforeReach: false }, { date: '2026-10-25', kind: 'upsale', beforeReach: false }],
          commissionSen: 156_00, fromHistory: false,
        },
      ],
      changedOrders: [
        { ...ZAN_PLACE, ratePct: 14, docNo: 'HC-SO-2609-397', part: 'earlier', lastChange: '2026-10-05', originalSen: 15_776_00, latestSen: 7_888_00, amendedSen: -7_888_00, reachedOn: '2026-10-21', effectSen: -1_104_32, fromHistory: true },
        { ...ZAN_PLACE, docNo: 'HC-SO-2609-060', part: 'earlier', lastChange: '2026-10-25', originalSen: 1_000_00, latestSen: 1_200_00, amendedSen: 200_00, reachedOn: '2026-10-08', effectSen: 26_00, fromHistory: false },
      ],
    };
    expect(earlierShownOf(SHAPED).map((o) => [o.docNo, whatOf(o), o.lastDate, o.commissionSen])).toEqual([
      ['HC-SO-2609-397', 'Reached 30%', '2026-10-21', 2_208_64],
      ['HC-SO-2609-060', 'Reached 30%', '2026-10-08', 130_00],
    ]);
    /* Marked not counted: nothing either side. */
    const mark = { id: 'm1', kind: 'exclude' as const, month: null, reason: null, markedBy: 'Finance', markedAt: '2026-11-12T10:00:00Z' };
    const marked: EventCommission = {
      ...SHAPED,
      earlierOrders: SHAPED.earlierOrders!.map((o) => ({ ...o, commissionSen: 0, mark })),
      changedOrders: SHAPED.changedOrders!.map((o) => ({ ...o, effectSen: 0, mark })),
    };
    expect(earlierShownOf(marked).map((o) => o.commissionSen)).toEqual([0, 0]);
  });

  test('every order the range changed, once — the earlier fairs\' apart from the range\'s own: its final amount, + green / − red, the effect at the brand rate, not yet 30% says so', () => {
    renderTab(<EventCommissionTab />);
    const inRange = screen.getByRole('region', { name: 'Upsales / Drop sales — fairs starting in the range' });
    const up = within(inRange).getByText('HC-SO-2610-001').closest('tr')!;
    expect(cellsOf(up)).toEqual(expect.arrayContaining(['850.00', '1,000.00', '+150.00', '14%', '21.00']));
    expect(within(up).getByText('+150.00').className).toContain('text-synced');
    expect(up.textContent).toContain('from history');
    const earlier = screen.getByRole('region', { name: 'Upsales / Drop sales — earlier fairs' });
    const down = within(earlier).getByText('HC-SO-2609-053').closest('tr')!;
    expect(within(down).getByText('−400.00').className).toContain('text-err');
    expect(down.textContent).toContain('not yet 30%');
    expect(within(earlier).queryByText('HC-SO-2610-001')).toBeNull();
  });

  /* Owner 2026-11-13: 「旧的单upsale？ 应该要算吧」 — an old order with no fair counts
     its upsales / drop sales, paid or not. */
  test('an old order with no fair: its upsale shows its effect, not "not yet 30%", on the Upsales / drop sales line', () => {
    const place = { fairId: -1, fairName: 'No fair', brand: 'AKEMI', organizer: null, venue: 'MID VALLEY', state: null, salesperson: 'Shawn', customer: 'Lim', ratePct: 14 };
    current = {
      ...BY_SO_DATE,
      adjustments: [{ date: '2026-10-10', kind: 'upsale', docNo: 'HC-SO-013238', fairId: -1, fairName: 'No fair', salesperson: 'Shawn', goodsSen: 2_000_00, commissionSen: 280_00, beforeReach: false }],
      earlierOrders: [{ ...place, docNo: 'HC-SO-013238', events: [{ date: '2026-10-10', kind: 'upsale', beforeReach: false }], lastDate: '2026-10-10', originalSen: 10_000_00, latestSen: 12_000_00, amendedSen: 2_000_00, commissionSen: 280_00, fromHistory: false }],
      changedOrders: [{ ...place, docNo: 'HC-SO-013238', part: 'earlier', lastChange: '2026-10-10', originalSen: 10_000_00, latestSen: 12_000_00, amendedSen: 2_000_00, reachedOn: null, effectSen: 280_00, fromHistory: false, oldOrder: true }],
      totals: { payableSen: 130_00, adjustmentsSen: 280_00, totalSen: 410_00 },
    };
    renderTab(<EventCommissionTab />);
    const row = screen.getAllByText('HC-SO-013238').map((el) => el.closest('tr')!).find((tr) => tr.textContent.includes('+2,000.00'))!;
    expect(cellsOf(row)).toEqual(expect.arrayContaining(['10,000.00', '12,000.00', '+2,000.00', '14%', '280.00']));
    expect(row.textContent).not.toContain('not yet 30%');
    expect(tile('Upsales / Drop sales — earlier orders')).toContain('280.00');
    expect(cardSens(current)).toEqual([['inRange', 130_00], ['earlier', 0], ['earlierChanges', 280_00]]);
    /* One brand: the line with no fair stays under its order's brand, and the cards still add up. */
    const akemi = forBrand(current, 'AKEMI');
    expect(akemi.totals.totalSen).toBe(280_00);
    expect(cardSens(akemi)).toEqual([['inRange', 0], ['earlier', 0], ['earlierChanges', 280_00]]);
  });

  test('the CSV is the export: the cards with what the first holds inside it, then each table under its title', () => {
    const csv = eventCommissionCsv(REPORT, 'October 2026', '');
    expect(csv).toContain('"Summary"');
    expect(csv).toContain('"Fairs starting in the range","2 fairs · 2 orders","140.00"');
    expect(csv).toContain('"of which upsales / drop sales","1 order","21.00"');
    expect(csv).toContain('"of which late bills","0 orders","0.00"');
    expect(csv).toContain('"Earlier fairs","2 orders","13.00"');
    expect(csv).toContain('"Upsales / Drop sales — earlier fairs","1 order","0.00"');
    expect(csv).toContain('"Total commission","","153.00"');
    expect(csv).toContain('"Order","Ref No.","SO date","Brand","Fair","Salesperson","Goods","Rate","Paid %","30% reached","Commission","Marked"');
    expect(csv).toContain('"HC-SO-2610-001","","2026/10/02","AKEMI","Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY","Ethan","1,000.00","14%","36.4%","2026/10/02","140.00",""');
    expect(csv).toContain('"Total · 2 orders","","","","","","1,500.00","","","","140.00",""');
    expect(csv).toContain('"HC-SO-2609-051","2026/10/12","Cancelled","","ZANOTTI","Jason","1,000.00","13%","(130.00)",""');
  });

  test('a card per table, in the tables\' order, each its table\'s total — together the total; what the first holds inside it', () => {
    expect(cardsOf(REPORT).map((c) => [c.key, c.label, c.sen, c.count])).toEqual([
      ['inRange', 'Fairs starting in the range', 140_00, '2 fairs · 2 orders'],
      ['earlier', 'Earlier fairs', 13_00, '2 orders'],
      ['earlierChanges', 'Upsales / Drop sales — earlier fairs', 0, '1 order'],
    ]);
    expect(cardsOf(REPORT).reduce((t, c) => t + c.sen, 0)).toBe(REPORT.totals.totalSen);
    expect(insideFirstOf({ ...REPORT, lateBills: ['HC-SO-2610-001'] })).toEqual([
      { label: 'of which upsales / drop sales', sen: 21_00, count: '1 order' },
      { label: 'of which late bills', sen: 140_00, count: '1 order' },
    ]);
    renderTab(<EventCommissionTab />);
    expect(tileLabels()).toEqual(['Total commission', 'Fairs starting in the range', 'Earlier fairs', 'Upsales / Drop sales — earlier fairs']);
    /* The tables in the same order, each total the card's figure. */
    const regions = ['Fairs starting in the range', 'Earlier fairs — reached 30% or cancelled in the range', 'Upsales / Drop sales — earlier fairs'];
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label')).filter((n) => regions.includes(n ?? ''))).toEqual(regions);
    expect(tile('Fairs starting in the range')).toContain('140.00');
    expect(tables()[0]!.querySelector('tfoot')!.textContent).toContain('140.00');
    expect(tile('Earlier fairs')).toContain('13.00');
    expect(tables()[1]!.querySelector('tfoot')!.textContent).toContain('13.00');
  });

  test('By SO date lists an order with no fair too: "No fair", the venue typed on it, its brand’s rate — its own summary line and tile', () => {
    const NO_FAIR = {
      id: -1, name: 'No fair', brand: 'ERGOTEX', organizer: null, venue: null, state: null, startDate: '', endDate: null,
      ratePct: 14, totalSalesRm: null, estimateRm: null, payableSen: 140_00,
      sos: [{
        docNo: 'HC-SO-2610-058', soDate: '2026-10-05', venue: 'THE STARLING MALL', salesperson: 'Shawn', customer: 'Lee',
        goodsSen: 1_000_00, totalSen: 1_000_00, paidSen: 1_000_00, paidPct: 100, reachedOn: '2026-10-05', commissionSen: 140_00, changes: [],
      }],
    };
    current = { ...BY_SO_DATE, fairs: [...BY_SO_DATE.fairs, NO_FAIR], totals: { ...BY_SO_DATE.totals, payableSen: 270_00, totalSen: 270_00 } };
    renderTab(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    const row = cellsOf(rowOf(tables()[0]!, 'HC-SO-2610-058'));
    for (const t of ['ERGOTEX', 'No fair', 'THE STARLING MALL', 'Shawn', '140.00']) expect(row).toContain(t);
    expect(tile('Orders opened in the range')).toContain('270.00');
    expect(tile('Orders opened in the range')).toContain('2 orders');
    expect(insideFirstOf(current)[0]).toEqual({ label: 'of which No fair', sen: 140_00, count: '1 order' });
    expect(eventCommissionCsv(current)).toContain('"of which No fair","1 order","140.00"');
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
    expect(screen.getByText(/No earlier order reached 30% or was cancelled in this range/)).toBeTruthy();
    expect(screen.getByText('No upsale or drop sale on an earlier order in this range.')).toBeTruthy();
  });

  test('a report from a server older than the toggle or the order lists reads as by fair, its lists empty', () => {
    const { basis: _drop, earlierOrders: _e, changedOrders: _c, ...old } = REPORT;
    void _drop; void _e; void _c;
    expect(basisOf(old)).toBe('fair');
    expect(eventCommissionCsv(old)).toContain('"Total commission","","153.00"');
  });
});

/* Owner 2026-10-21: 这个页面优化，很乱 → 1 可以，2 不要，3 要，做，要有header.
   2026-10-25: 这个header，table 要和 pv 那边一样能调整，能换位 / 这个点开排版好看一点.
   2026-10-26: 做宽一点 / brand, organizer, venue 全部一个column. */
describe('the redesign (batch 6 §5.11)', () => {
  test('Excel and PDF: the cards as the summary, then each table under its title in the page\'s order; the CSV sits under the header’s ⋯; an order number is a link', () => {
    const sheet = eventCommissionSheet(REPORT, 'October 2026', '');
    expect(sheet.title).toBe('Event commission');
    expect(sheet.subtitle).toBe('October 2026 · by fair · all brands · total 153.00 · RM');
    expect(sheet.tables[0]!.rows.map((r) => [r.label, r.cells])).toEqual([
      ['Fairs starting in the range', ['2 fairs · 2 orders', 140_00]],
      ['of which upsales / drop sales', ['1 order', 21_00]],
      ['of which late bills', ['0 orders', 0]],
      ['Earlier fairs', ['2 orders', 13_00]],
      ['Upsales / Drop sales — earlier fairs', ['1 order', 0]],
      ['Total commission', ['', 153_00]],
    ]);
    expect(sheet.tables.map((t) => t.title)).toEqual([
      'Summary', 'Fairs starting in the range', 'Fairs starting in the range — their orders', 'Earlier fairs — reached 30% or cancelled in the range',
      'Upsales / Drop sales — earlier fairs', 'Upsales / Drop sales — fairs starting in the range (inside Fairs starting in the range, not added again)',
      'Below 30% paid (not in the total)',
    ]);
    expect(sheet.tables[1]!.columns.map((c) => c.label)).toEqual(['Dates', 'Rate', 'Goods', 'Goods × rate', 'Orders', 'Commission']);
    const orders = sheet.tables[2]!;
    expect(orders.labelHeader).toBe('Order');
    expect(orders.columns.find((c) => c.label === 'Fair')).toEqual({ label: 'Fair', kind: 'text', align: 'left', width: 44 });
    expect(orders.rows.at(-1)).toEqual({ kind: 'total', depth: 0, label: 'Total · 2 orders', cells: ['', '', '', '', '', 1_500_00, '', '', '', 140_00, ''] });
    /* Its own words in English: the PDF's Chinese face has no 补开单, and refused the whole export over it. */
    expect(JSON.stringify(eventCommissionSheet({ ...REPORT, lateBills: ['HC-SO-2610-001'] }, 'October 2026', ''))).not.toMatch(/[\u3000-\u9fff]/);
    /* By SO date has no fair table: the summary, the orders, the earlier orders, the earlier orders' changes. */
    expect(eventCommissionSheet(BY_SO_DATE, 'October 2026', '').tables.map((t) => t.title))
      .toEqual(['Summary', 'Orders opened in the range (SO date)', 'Earlier orders — reached 30% or cancelled in the range', 'Upsales / Drop sales — earlier orders']);

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
    expect(screen.getByText(/\d+ reached 30%/).parentElement!.textContent).toContain('2 orders · 1 reached 30% · commission RM 140.00');
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
    ref: 'ZNT0480', soDate: '2026-09-05', status: 'CONFIRMED',
    wasSen: 0, nowSen: 130_00, adjustmentSen: 130_00, goodsSen: 1_000_00, ratePct: 13,
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
    /* Its Ref No. too, as on every order table (「这个没有reference no. 吗？」). */
    /* The goods its Now is worked on and the rate (「我看不到goods amount和rate」). */
    for (const t of ['2026/09', 'ZNT0480', 'ZANOTTI', 'Wei Pin', '1,000.00', '13%', '+130.00']) expect(cells).toContain(t);
    const csv = eventCommissionCsv(current);
    expect(csv).toContain('"Closed months — adjustments","1 order · 2026/09","130.00"');
    expect(csv).toContain('"HC-SO-2609-051","2026/09","ZNT0480","ZANOTTI","Wei Pin","1,000.00","13%","0.00","130.00","130.00"');
    expect(csv).toContain('"Total commission","","283.00"');
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
    expect(cardSens(current)).toContainEqual(['deferredIn', 50_00]);
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

/* Owner 2026-11-12, later: on the Upsales / Drop sales table 「这边不能按不count
   吗？」 → 「做 B：只是改价不算」; on the SO list 「要有 fair full name」 and 「我也要
   看到 sales, 然后 goods」. */
describe('a price change left out, and the SO list\'s columns (owner 2026-11-12)', () => {
  const october = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T04:00:00Z')); };
  const changeMark = { id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', kind: 'exclude_change' as const, month: '2026-10', reason: 'typing fix', markedBy: 'Finance Chew', markedAt: '2026-11-12T03:00:00Z' };
  /* HC-SO-2610-001's upsale of 150.00 left out: it earns on 850.00 (119.00), not on 1,000.00 (140.00). */
  const LEFT_OUT: EventCommission = {
    ...REPORT,
    fairs: REPORT.fairs.map((f) => (f.id !== 363 ? f : {
      ...f, payableSen: 119_00,
      sos: f.sos.map((s) => (s.docNo !== 'HC-SO-2610-001' ? s : {
        ...s, commissionSen: 119_00, uncountedSen: 21_00, changes: s.changes.map((ch) => (ch.notCounted ? ch : { ...ch, uncounted: true })),
      })),
    })),
    changedOrders: REPORT.changedOrders!.map((o) => (o.docNo === 'HC-SO-2610-001' ? { ...o, effectSen: 0, uncountedGoodsSen: 150_00, changeMark } : o)),
    marked: [{
      docNo: 'HC-SO-2610-001', fairId: 363, fairName: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur',
      salesperson: 'Ethan', customer: 'Tan', ratePct: 14, mark: changeMark, commissionSen: 21_00,
    }],
    totals: { payableSen: 119_00, adjustmentsSen: 13_00, totalSen: 132_00 },
  };

  test('each changed order has "Don\'t count change" on an open month: it asks for a reason and names the month', async () => {
    october();
    renderTab(<EventCommissionTab />);
    const card = screen.getByRole('region', { name: 'Upsales / Drop sales — fairs starting in the range' });
    const up = within(card).getByText('HC-SO-2610-001').closest('tr')!;
    fireEvent.click(within(up).getByRole('button', { name: "Don't count change" }));
    await waitFor(() => expect(markOrder).toHaveBeenCalledWith({ docNo: 'HC-SO-2610-001', kind: 'exclude_change', month: '2026-10', reason: 'checking the price' }));
    expect(promptAsk).toHaveBeenCalledWith(expect.objectContaining({
      title: "Don't count the price change of HC-SO-2610-001?", body: expect.stringContaining('original amount still counts'),
    }));
  });

  test('a closed month shows no such button', () => {
    october();
    current = { ...REPORT, from: '2026-09-01', to: '2026-09-30', closed: { month: '2026-09', closedAt: '2026-10-26T09:00:00Z', closedBy: 'Finance' }, closes: { months: ['2026-09'], openFrom: '2026-10' } };
    renderTab(<EventCommissionTab />);
    expect(screen.queryByRole('button', { name: "Don't count change" })).toBeNull();
  });

  test('a price change left out: its row says so with Undo, the order still earns on the rest, and the mark is listed apart', async () => {
    october();
    current = LEFT_OUT;
    renderTab(<EventCommissionTab />);
    expect(tile('Total commission')).toContain('132.00');
    expect(tile('Fairs starting in the range')).toContain('119.00');
    expect(tile('Upsales / Drop sales — earlier fairs')).toContain('0.00');
    const card = screen.getByRole('region', { name: 'Upsales / Drop sales — fairs starting in the range' });
    const row = within(card).getByText('HC-SO-2610-001').closest('tr')!;
    /* Its amounts stay; the effect reads "not counted", and the button is now Undo. */
    expect(cellsOf(row)).toEqual(expect.arrayContaining(['850.00', '1,000.00', '+150.00', 'not counted']));
    expect(within(row).queryByRole('button', { name: "Don't count change" })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Undo' }).getAttribute('title')).toBe('Price change not counted · typing fix · by Finance Chew');
    const listed = screen.getByRole('region', { name: 'Marked — not paid here' });
    expect(cellsOf(within(listed).getByText('HC-SO-2610-001').closest('tr')!))
      .toEqual(expect.arrayContaining(['Price change not counted', 'typing fix', 'Finance Chew', '21.00']));
    fireEvent.click(within(row).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(unmarkOrder).toHaveBeenCalledWith(changeMark.id));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Take away "Price change not counted"?', body: expect.stringContaining('price change counts again'),
    }));
    /* The order itself still counts: its own two buttons stay, and its upsale reads as left out. */
    fireEvent.click(within(tables()[0]!).getByText('MID VALLEY'));
    const order = within(tables()[0]!).getByText('HC-SO-2610-001').closest('tr')!;
    expect(within(order).getByRole('button', { name: "Don't count" })).toBeTruthy();
    expect(order.textContent).toContain('left out by Finance');
    expect(within(order).getByText('119.00').getAttribute('title')).toBe('A price change is left out: RM 21.00 not counted');
  });

  test('the export says which mark: a price change left out reads apart from an order not counted, and both when both', () => {
    expect(cardSens(LEFT_OUT)).toEqual([['inRange', 119_00], ['earlier', 13_00], ['earlierChanges', 0]]);
    expect(eventCommissionCsv(LEFT_OUT)).toContain('"HC-SO-2610-001","Price change not counted","","AKEMI","typing fix","Ethan","21.00"');
    const exclude = { ...changeMark, id: 'x1', kind: 'exclude' as const, month: null, reason: null };
    const both = { ...LEFT_OUT, marked: [{ ...LEFT_OUT.marked![0]!, mark: exclude, commissionSen: 119_00 }, ...LEFT_OUT.marked!] };
    const csv = eventCommissionCsv(both);
    expect(csv).toContain('"HC-SO-2610-001","Not counted","","AKEMI","","Ethan","119.00"');
    expect(csv).toContain('"Total · 2 marks","","","","","","140.00"');
    expect(whatOf({ ...REPORT.earlierOrders![0]!, events: [{ date: '2026-10-03', kind: 'upsale', beforeReach: false, uncounted: true }] })).toBe('Upsale (left out)');
  });

  test("By SO date: the fair's full name beside its brand, and the order's Sales before its Goods", () => {
    renderTab(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    const list = tables()[0]!;
    const heads = within(list).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads.indexOf('Fair (Full Name)')).toBe(heads.indexOf('Brand') + 1);
    expect(heads.indexOf('Sales')).toBeGreaterThan(-1);
    expect(heads.indexOf('Sales')).toBe(heads.indexOf('Goods') - 1);
    const row = cellsOf(rowOf(list, 'HC-SO-2610-010'));
    expect(row).toEqual(expect.arrayContaining(['SELANGOR [ZANOTTI] BIGHOME @ SUNWAY PYRAMID', '1,100.00', '1,000.00']));
    expect(list.querySelector('tfoot')!.textContent).toContain('1,100.00');
  });
});

/* Owner 2026-11-13 (「做」): an amount Finance types on an order for a month, for
   what the system holds no record of. */
describe("Finance's own lines (owner 2026-11-13)", () => {
  const october = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-26T04:00:00Z')); };
  const LINE = {
    docNo: 'HC-SO-009001', fairId: -1, fairName: 'No fair', brand: 'ZANOTTI', organizer: null, venue: 'MID VALLEY', state: null,
    salesperson: 'Sales A', customer: 'Lim', ratePct: 13, ref: 'REF1001', soDate: '2026-04-13', status: 'IN_PRODUCTION',
    line: { id: '9d2e4f60-1a2b-4c3d-8e9f-0a1b2c3d4e5f', month: '2026-10', reason: 'Raised before the order came into the ERP', addedBy: 'Finance Chew', addedAt: '2026-11-13T07:00:00Z' },
    goodsSen: 800_00, commissionSen: 104_00,
  };
  const withLine: EventCommission = { ...BY_SO_DATE, manualLines: [LINE], totals: { ...BY_SO_DATE.totals, manualSen: 104_00, totalSen: BY_SO_DATE.totals.totalSen + 104_00 } };

  test('a report with none shows no card, no tile, and exports as before', () => {
    renderTab(<EventCommissionTab />);
    expect(screen.queryByRole('region', { name: 'Added by Finance' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Totals' })).queryByText('Added by Finance')).toBeNull();
    expect(eventCommissionCsv(REPORT)).not.toContain('Added by Finance');
    expect(cardsOf(REPORT).some((c) => c.key === 'manual')).toBe(false);
  });

  test('a line has a card of its own — order, goods, rate, commission, why and who — a tile, and is in the total and the export', () => {
    october();
    current = withLine;
    renderTab(<EventCommissionTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By SO date' }));
    expect(tile('Total commission')).toContain(fmtRm(withLine.totals.totalSen));
    expect(tile('Added by Finance')).toContain('104.00');
    const card = screen.getByRole('region', { name: 'Added by Finance' });
    expect(cellsOf(within(card).getByText('HC-SO-009001').closest('tr')!)).toEqual(expect.arrayContaining([
      'REF1001', 'ZANOTTI', 'MID VALLEY', 'Sales A', '800.00', '13%', '104.00', 'Raised before the order came into the ERP', 'Finance Chew',
    ]));
    expect(cardSens(withLine)).toContainEqual(['manual', 104_00]);
    expect(cardsOf(withLine).reduce((t, c) => t + c.sen, 0)).toBe(withLine.totals.totalSen);
    const csv = eventCommissionCsv(withLine);
    expect(csv).toContain('"Added by Finance","1 line","104.00"');
    expect(csv).toContain('"HC-SO-009001","REF1001","ZANOTTI","Sales A","Raised before the order came into the ERP","Finance Chew","800.00","13%","104.00"');
    /* One brand: its own lines only, and the total with them. */
    expect(forBrand(withLine, 'AKEMI').manualLines).toEqual([]);
    expect(forBrand(withLine, 'ZANOTTI').totals).toMatchObject({ manualSen: 104_00 });
    expect(brandsOf({ ...withLine, fairs: [], adjustments: [], earlierOrders: [], changedOrders: [] })).toEqual(['ZANOTTI']);
  });

  test('on an open month Finance types a line — order, goods, reason — and it is sent with the month; less than 0 takes back', async () => {
    october();
    current = withLine;
    renderTab(<EventCommissionTab />);
    const card = screen.getByRole('region', { name: 'Added by Finance' });
    fireEvent.click(within(card).getByRole('button', { name: '+ Add a line for 2026/10' }));
    const form = within(card).getByRole('form', { name: 'Add a line for 2026/10' });
    const add = within(form).getByRole('button', { name: 'Add to 2026/10' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Order'), { target: { value: ' hc-so-009002 ' } });
    fireEvent.change(within(form).getByLabelText('Goods (RM)'), { target: { value: '-1,250.50' } });
    expect((add as HTMLButtonElement).disabled).toBe(true); // no reason yet
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: ' Taken back by hand ' } });
    fireEvent.click(add);
    expect(addLine).toHaveBeenCalledWith({ docNo: 'HC-SO-009002', goodsSen: -1_250_50, reason: 'Taken back by hand', month: '2026-10' }, expect.anything());
    /* Not an amount, or 0: nothing to send. */
    addLine.mockClear();
    fireEvent.change(within(form).getByLabelText('Goods (RM)'), { target: { value: 'abc' } });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Goods (RM)'), { target: { value: '0' } });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('form')).toBeNull();
    expect(addLine).not.toHaveBeenCalled();
  });

  test('with no line yet, the form opens from the header’s ⋯ on an open month', () => {
    october();
    renderTab(<EventCommissionTab />);
    expect(screen.queryByRole('region', { name: 'Added by Finance' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a line (Finance)' }));
    expect(within(screen.getByRole('region', { name: 'Added by Finance' })).getByRole('form', { name: 'Add a line for 2026/10' })).toBeTruthy();
  });

  test('the form opened from the menu comes into view, with the cursor in its first box', () => {
    october();
    const scrolled = vi.fn();
    const was = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element, opts: unknown) { scrolled(this, opts); } });
    try {
      renderTab(<EventCommissionTab />);
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Add a line (Finance)' }));
      const form = screen.getByRole('form', { name: 'Add a line for 2026/10' });
      expect(scrolled).toHaveBeenCalledWith(form, { block: 'center' });
      expect(document.activeElement).toBe(within(form).getByLabelText('Order'));
    } finally {
      if (was) Object.defineProperty(Element.prototype, 'scrollIntoView', was);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  test('Remove asks first, then takes the line away; a closed month offers neither', async () => {
    october();
    current = withLine;
    const first = renderTab(<EventCommissionTab />);
    const card = screen.getByRole('region', { name: 'Added by Finance' });
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeLine).toHaveBeenCalledWith(LINE.line.id));
    expect(confirmAsk).toHaveBeenCalledWith(expect.objectContaining({ title: 'Take the line on HC-SO-009001 away?' }));
    first.unmount();
    current = { ...withLine, from: '2026-10-01', to: '2026-10-31', closed: { month: '2026-10', closedAt: '2026-11-20T09:00:00Z', closedBy: 'Finance' }, closes: { months: ['2026-09', '2026-10'], openFrom: '2026-11' } };
    renderTab(<EventCommissionTab />);
    const closedCard = screen.getByRole('region', { name: 'Added by Finance' });
    expect(within(closedCard).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(closedCard).queryByRole('button', { name: /Add a line/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Add a line (Finance)' })).toBeNull();
  });
});

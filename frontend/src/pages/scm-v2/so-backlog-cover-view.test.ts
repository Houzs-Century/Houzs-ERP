/* The SO conversion & backlog report's rules (so-backlog-cover-view.ts): where
   an order sits, the part the tiles filter to, the average start the URL may
   carry, and the sheet Excel and PDF are made from — the parts, the backlog
   cover by month by amount and by orders with their averages, then the
   orders. Made-up figures. */
import { describe, expect, test } from 'vitest';
import type { CoverRow, SoBacklogCoverData } from '../../vendor/scm/lib/so-backlog-cover-queries';
import { averagePeriod, avgFromOf, coverSheet, firstOfText, ordersText, partText, partViewOf, rowsOfPart } from './so-backlog-cover-view';

const r = (docNo: string, part: CoverRow['part'], soDate: string, amountSen: number, extra: Partial<CoverRow> = {}): CoverRow => ({
  docNo, soDate, processedOn: '2026-11-05', dateFrom: 'processing_date', customer: null, imported: false, part, amountSen, ...extra,
});
const DATA: SoBacklogCoverData = {
  month: '2026-11', from: '2026-11-01', to: '2026-11-30',
  total: { orders: 3, amountSen: 400_000 },
  parts: { this_month: { orders: 1, amountSen: 100_000, pct: 25 }, backlog: { orders: 2, amountSen: 300_000, pct: 75 } },
  backlog: { orders: 6, amountSen: 1_200_000 },
  cover: { amount: { onBacklog: 25, onMonth: 75 }, orders: { onBacklog: 33.3, onMonth: 66.7 } },
  average: { from: '2026-10', to: '2026-11', amount: { onBacklog: 20, onMonth: 70 }, orders: { onBacklog: 26.7, onMonth: 58.4 } },
  defaultFrom: '2026-10',
  months: [
    {
      month: '2026-10', backlog: { orders: 5, amountSen: 1_000_000 }, backlogProcessed: { orders: 1, amountSen: 150_000 }, processed: { orders: 2, amountSen: 230_000 },
      amount: { onBacklog: 15, onMonth: 65 }, orders: { onBacklog: 20, onMonth: 50 },
    },
    {
      month: '2026-11', backlog: { orders: 1_206, amountSen: 1_200_000 }, backlogProcessed: { orders: 2, amountSen: 300_000 }, processed: { orders: 3, amountSen: 400_000 },
      amount: { onBacklog: 25, onMonth: 75 }, orders: { onBacklog: 33.3, onMonth: 66.7 },
    },
  ],
  rows: [
    r('A', 'this_month', '2026-11-02', 100_000),
    r('B', 'backlog', '2026-10-30', 200_000),
    r('C', 'backlog', '2026-02-11', 100_000, { imported: true, dateFrom: 'first_do' }),
  ],
};

describe('the SO conversion & backlog rules', () => {
  test('an order says which part it is in, the backlog with the month it was raised', () => {
    expect(partText(r('A', 'this_month', '2026-11-02', 1))).toBe('This month');
    expect(partText(r('B', 'backlog', '2026-10-30', 1))).toBe('Backlog · Oct 2026');
  });

  test('the tiles filter to a part; anything else in the URL shows every order', () => {
    expect(partViewOf('backlog')).toBe('backlog');
    expect(partViewOf('this_month')).toBe('this_month');
    expect(partViewOf('earlier')).toBe('all');
    expect(partViewOf(null)).toBe('all');
    expect(rowsOfPart(DATA.rows, 'backlog').map((x) => x.docNo)).toEqual(['B', 'C']);
    expect(rowsOfPart(DATA.rows, 'all')).toHaveLength(3);
  });

  test("the average's start in the URL is used only when it is a month no later than the report's", () => {
    expect(avgFromOf('2026-09', '2026-11')).toBe('2026-09');
    expect(avgFromOf('2026-11', '2026-11')).toBe('2026-11');
    expect(avgFromOf('2026-12', '2026-11')).toBeNull();
    expect(avgFromOf('2026-13', '2026-11')).toBeNull();
    expect(avgFromOf(null, '2026-11')).toBeNull();
  });

  test('an order count reads with a thousands separator', () => {
    expect(ordersText(1)).toBe('1 order');
    expect(ordersText(2_217)).toBe('2,217 orders');
  });

  test('the backlog is counted on the 1st; the average names its months', () => {
    expect(firstOfText('2026-11')).toBe('1 Nov 2026');
    expect(averagePeriod(DATA)).toBe('Oct 2026 – Nov 2026');
    expect(averagePeriod({ ...DATA, average: { ...DATA.average, from: '2026-11' } })).toBe('Nov 2026');
  });

  test('the sheet: the parts, the backlog cover by month by amount and by orders with their averages, then the orders', () => {
    const sheet = coverSheet(DATA, 'all');
    expect(sheet.title).toBe('SO conversion & backlog');
    expect(sheet.subtitle).toBe('Nov 2026 · by Processing Date · RM');
    expect(sheet.tables.map((t) => t.title)).toEqual(['Summary', 'Backlog cover by month · by amount', 'Backlog cover by month · by orders', 'Orders processed']);
    expect(sheet.tables[0]!.rows.map((x) => [x.label, ...x.cells])).toEqual([
      ["This month's orders", '1 order', 100_000, 25],
      ['Backlog orders', '2 orders', 300_000, 75],
      ['Processed in the month', '3 orders', 400_000, 100],
    ]);
    expect(sheet.tables[1]!.rows.map((x) => [x.label, ...x.cells])).toEqual([
      ['Oct 2026', 1_000_000, 150_000, 230_000, 15, 65],
      ['Nov 2026', 1_200_000, 300_000, 400_000, 25, 75],
      ['Average', null, null, null, 20, 70],
    ]);
    expect(sheet.tables[2]!.columns.map((c) => [c.label, c.kind])).toEqual([
      ['Backlog orders at the 1st', 'text'], ['Backlog orders processed', 'text'], ['Orders processed', 'text'], ['On backlog', 'pct'], ['On month', 'pct'],
    ]);
    expect(sheet.tables[2]!.rows.map((x) => [x.label, ...x.cells])).toEqual([
      ['Oct 2026', '5', '1', '2', 20, 50],
      ['Nov 2026', '1,206', '2', '3', 33.3, 66.7],
      ['Average', null, null, null, 26.7, 58.4],
    ]);
    expect(sheet.tables[3]!.rows.map((x) => [x.label, ...x.cells])).toEqual([
      ['A', '2026-11-02', '2026-11-05', 'Processing Date', '', 'This month', 100_000],
      ['B', '2026-10-30', '2026-11-05', 'Processing Date', '', 'Backlog · Oct 2026', 200_000],
      ['C', '2026-02-11', '2026-11-05', 'First DO', '', 'Backlog · Feb 2026 (imported)', 100_000],
      ['Total', null, null, null, null, '3 orders', 400_000],
    ]);
  });

  test("a filtered sheet lists that part's orders and says so", () => {
    const sheet = coverSheet(DATA, 'this_month');
    expect(sheet.subtitle).toBe("Nov 2026 · by Processing Date · this month's orders · RM");
    expect(sheet.tables[3]!.title).toBe("Orders processed · This month's orders");
    expect(sheet.tables[3]!.rows.map((x) => x.label)).toEqual(['A', 'Total']);
  });
});

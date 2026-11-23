// Finance's product change reports (owner 2026-11-23): the detail by month and
// the P&L-style summary by month and by salesperson. These pin the adding up,
// the bucket filter, the months a range spans and the sheets the exports draw.
// Amounts are made up.
import { describe, expect, it } from 'vitest';
import type { ProductChangeRow } from '../../vendor/scm/lib/product-change-queries';
import { sheetMatrix } from '../../vendor/scm/lib/report-sheet-xlsx';
import {
  bySalesperson, detailSheet, filterRows, fmtDelta, lineText, monthsBetween, pickableMonths, routeText, summaryColumns,
  summarySheet, SUMMARY_LINES, totalsOf, whoText,
} from './product-changes-view';

let seq = 0;
const row = (day: string, bucket: ProductChangeRow['bucket'], selling: number, cost: number, salesperson = 'Mei Ling', extra: Partial<ProductChangeRow> = {}): ProductChangeRow => {
  const margin = selling - cost;
  return {
    id: `e${++seq}`, docNo: `HC-SO-${seq}`, soDate: '2026-09-01', customer: 'A customer', salesperson, changeDay: day, changedAt: null,
    route: 'DIRECT', amendmentNos: [], changedBy: ['Ali'], approvedBy: [], types: ['sku'], bucket,
    sellingBeforeSen: 100_000, sellingAfterSen: 100_000 + selling, costBeforeSen: 50_000, costAfterSen: 50_000 + cost,
    sellingDeltaSen: selling, costDeltaSen: cost, marginDeltaSen: margin, covered: margin >= 0, shortfallSen: Math.max(0, -margin), lines: [],
    ...extra,
  };
};

const ROWS = [
  row('2026-10-03', 'SELLING', 50_000, 30_000),
  row('2026-10-09', 'SELLING', -40_000, -10_000, 'Kumar'),
  row('2026-10-20', 'COST_ONLY', 0, 8_000, 'Kumar'),
  row('2026-11-02', 'COST_ONLY', 0, -5_000),
];

describe('adding the changes up', () => {
  it('totals selling, cost and margin change, and the ones not covered with their shortfall', () => {
    expect(totalsOf(ROWS)).toEqual({ events: 4, sellingDeltaSen: 10_000, costDeltaSen: 23_000, marginDeltaSen: -13_000, notCovered: 2, shortfallSen: 38_000 });
  });

  it('filters by bucket, and to the ones not covered', () => {
    expect(filterRows(ROWS, 'SELLING', false)).toHaveLength(2);
    expect(filterRows(ROWS, 'COST_ONLY', true).map((r) => r.changeDay)).toEqual(['2026-10-20']);
    expect(filterRows(ROWS, 'all', true)).toHaveLength(2);
  });

  it('a range has a column per month and a total; one month has no total', () => {
    const cols = summaryColumns(ROWS, '2026-10-01', '2026-11-30');
    expect(cols.map((c) => c.key)).toEqual(['2026-10', '2026-11', 'total']);
    expect(cols[0]!.a).toMatchObject({ events: 2, sellingDeltaSen: 10_000, costDeltaSen: 20_000, notCovered: 1, shortfallSen: 30_000 });
    expect(cols[0]!.b).toMatchObject({ events: 1, costDeltaSen: 8_000, notCovered: 1, shortfallSen: 8_000 });
    expect(cols[2]!.all.events).toBe(4);
    expect(summaryColumns(ROWS, '2026-10-01', '2026-10-31').map((c) => c.key)).toEqual(['2026-10']);
  });

  it('by salesperson, the largest shortfall first', () => {
    expect(bySalesperson(ROWS).map((p) => [p.salesperson, p.events, p.shortfallSen])).toEqual([['Kumar', 2, 38_000], ['Mei Ling', 2, 0]]);
  });
});

describe('the months', () => {
  it('spans whole months across a year end', () => {
    expect(monthsBetween('2026-11-15', '2027-02-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
  it('offers September 2026 to this month, newest first', () => {
    expect(pickableMonths('2026-11-23')).toEqual(['2026-11', '2026-10', '2026-09']);
  });
});

describe('the words', () => {
  it('names a line, a route and who changed it', () => {
    expect(lineText({ id: '1', types: ['sku'], before: { code: 'JAGER-(Q)', qty: 1, sellingSen: 1, costSen: 1 }, after: { code: 'NTYR-(Q)', qty: 1, sellingSen: 1, costSen: 1 } })).toBe('JAGER-(Q) x1 → NTYR-(Q) x1');
    expect(lineText({ id: '2', types: ['new_line'], before: null, after: { code: 'CODY-(Q)', qty: 1, sellingSen: 0, costSen: 1 } })).toBe('+ CODY-(Q) x1');
    expect(routeText({ route: 'AMENDMENT', amendmentNos: ['HC-SO-1/A1', 'HC-SO-1/A2'] })).toBe('Amendment HC-SO-1/A1 + HC-SO-1/A2');
    expect(whoText({ route: 'AMENDMENT', changedBy: ['Ali'], approvedBy: ['Kris'] })).toBe('Ali · approved by Kris');
    expect(fmtDelta(50_000)).toBe('+500.00');
    expect(fmtDelta(-50_000)).toBe('(500.00)');
  });
});

describe('the exports draw what the screen shows', () => {
  it('the detail sheet has a cell for every column, and a total', () => {
    const sh = detailSheet(ROWS, '2026-10-01', '2026-10-31', 'all', false);
    const t = sh.tables[0]!;
    expect(t.rows.every((r) => r.cells.length === t.columns.length)).toBe(true);
    expect(t.rows.at(-1)!.kind).toBe('total');
  });
  it('both sheets lay out as an Excel workbook', () => {
    expect(sheetMatrix(detailSheet(ROWS, '2026-10-01', '2026-10-31', 'COST_ONLY', true)).length).toBeGreaterThan(ROWS.length);
    expect(sheetMatrix(summarySheet(ROWS, '2026-10-01', '2026-11-30')).length).toBeGreaterThan(SUMMARY_LINES.length);
  });
  it('the P&L sheet has the P&L lines by month and the salespeople', () => {
    const sh = summarySheet(ROWS, '2026-10-01', '2026-11-30');
    expect(sh.tables[0]!.rows).toHaveLength(SUMMARY_LINES.length);
    expect(sh.tables[0]!.rows.every((r) => r.cells.length === 3)).toBe(true);
    expect(sh.tables[1]!.rows.map((r) => r.label)).toEqual(['Kumar', 'Mei Ling', 'Total']);
  });
});

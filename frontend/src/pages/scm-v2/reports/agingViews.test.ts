/* What the aging screen works out from its report (batch 6 step 6): days
   overdue and the design's buckets, the By invoice lines, the tiles' counts
   and what a tile picks. */

import { describe, expect, test } from 'vitest';
import type { AgingRow } from '../../../vendor/scm/lib/aging-queries';
import { agingInvoiceLines, agingPartyCounts, bucketLabel, daysBetween, linesIn, overdueBucket, partiesIn } from './agingViews';

const ROWS: AgingRow[] = [
  {
    key: 'C-1', code: 'C-1', name: 'ALI', balanceSen: -80_000, cells: [0, 40_000, 0, 0, 0], unappliedSen: -120_000,
    items: [{ group: 'SO:SO-A', docNo: 'SI-A1', kind: 'Invoice', date: '2026-08-10', dueDate: null, amountSen: 120_000, openSen: 40_000, column: 1 }],
    unapplied: [{ docNo: 'SO-B', kind: 'Payment', date: '2026-09-15', amountSen: -120_000 }],
  },
  {
    key: 'S-9', code: 'S-9', name: 'BEE', balanceSen: 75_000, cells: [15_000, 0, 0, 60_000, 0], unappliedSen: 0,
    items: [
      { group: 'PI:PI-1', docNo: 'PI-1', kind: 'Purchase invoice', date: '2026-06-20', dueDate: '2026-07-20', amountSen: 90_000, openSen: 60_000, column: 3 },
      { group: 'PI:PI-2', docNo: 'PI-2', kind: 'AP invoice', date: '2026-09-20', dueDate: '2026-10-20', amountSen: 15_000, openSen: 15_000, column: 0 },
    ],
    unapplied: [],
  },
];

describe('days overdue and the design’s buckets', () => {
  test('whole days between two days, across a month and a year end', () => {
    expect(daysBetween('2026-07-20', '2026-09-30')).toBe(72);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-10-20', '2026-09-30')).toBe(-20);
  });

  test('not yet due is Current; then 1-30, 31-60, 61-90 and 90+, each edge where it belongs', () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map((d) => bucketLabel(overdueBucket(d)))).toEqual([
      'Current', 'Current', '1-30', '1-30', '31-60', '31-60', '61-90', '61-90', '90+', '90+',
    ]);
    expect(bucketLabel('unapplied')).toBe('Unapplied');
  });
});

describe('the By invoice lines', () => {
  test('each open bill with its days overdue — no due date, due on its date — most overdue first, the unapplied money last', () => {
    const lines = agingInvoiceLines(ROWS, '2026-09-30');
    expect(lines.map((l) => [l.docNo, l.daysOverdue, l.bucket])).toEqual([
      ['PI-1', 72, 'd61'],
      ['SI-A1', 51, 'd31'],
      ['PI-2', -20, 'current'],
      ['SO-B', null, 'unapplied'],
    ]);
    expect(lines[1]).toMatchObject({ partyName: 'ALI', partyCode: 'C-1', so: 'SO-A', outstandingSen: 40_000, column: 1 });
    expect(lines[0]!.so).toBeNull();
    expect(lines[3]).toMatchObject({ outstandingSen: -120_000, column: null, dueDate: null });
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });

  test('a tile picks the lines in its column, or the unapplied money', () => {
    const lines = agingInvoiceLines(ROWS, '2026-09-30');
    expect(linesIn(lines, 3).map((l) => l.docNo)).toEqual(['PI-1']);
    expect(linesIn(lines, 'unapplied').map((l) => l.docNo)).toEqual(['SO-B']);
    expect(linesIn(lines, null)).toHaveLength(4);
  });
});

describe('the tiles', () => {
  test('how many parties hold money in each column, in Unapplied and at all', () => {
    expect(agingPartyCounts(ROWS, 5)).toEqual({ cells: [1, 1, 0, 1, 0], unapplied: 1, all: 2 });
  });

  test('a tile picks the parties with money where it points', () => {
    expect(partiesIn(ROWS, 0).map((r) => r.name)).toEqual(['BEE']);
    expect(partiesIn(ROWS, 'unapplied').map((r) => r.name)).toEqual(['ALI']);
    expect(partiesIn(ROWS, null).map((r) => r.name)).toEqual(['ALI', 'BEE']);
  });
});

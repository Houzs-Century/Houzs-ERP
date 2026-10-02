/* The formal aging's rules (owner 2026-10-02): columns by the invoice's month
   as at a date, or by days; money not tied to a bill stays 未冲 (B3a); inside a
   group the money knocks off the bills oldest first; every row's balance is the
   sum of what it holds. */
import { describe, expect, test } from 'vitest';
import { ageEntries, agingColumn, agingTotals, splitLine, type AgingEntry } from './aging';

const P = { key: 'C-1', code: 'C-1', name: 'ALI' };
const e = (over: Partial<AgingEntry>): AgingEntry => ({ group: 'SO:1', party: P, docNo: 'X', kind: 'Invoice', date: '2026-09-01', dueDate: null, amountSen: 100, ...over });

describe('agingColumn', () => {
  test('by month: the calendar month, whatever the day — 本月, 1, 2, 3, 4 个月以上', () => {
    expect(agingColumn('2026-09-30', '2026-09-01', 'month')).toBe(0);
    expect(agingColumn('2026-09-01', '2026-08-31', 'month')).toBe(1);
    expect(agingColumn('2026-09-30', '2026-06-20', 'month')).toBe(3);
    expect(agingColumn('2026-09-30', '2025-01-01', 'month')).toBe(4);
    expect(agingColumn('2026-01-15', '2025-12-31', 'month')).toBe(1);
  });
  test('by day: 0–30, 31–60, 61–90, 91–120, more; a date after the as-at day is the first', () => {
    expect(agingColumn('2026-09-30', '2026-08-31', 'day')).toBe(0);
    expect(agingColumn('2026-09-30', '2026-08-30', 'day')).toBe(1);
    expect(agingColumn('2026-09-30', '2026-07-02', 'day')).toBe(2);
    expect(agingColumn('2026-09-30', '2026-06-02', 'day')).toBe(3);
    expect(agingColumn('2026-09-30', '2026-06-01', 'day')).toBe(4);
    expect(agingColumn('2026-09-30', '2026-10-20', 'day')).toBe(0);
    expect(agingColumn('2026-09-30', '2026-10-20', 'month')).toBe(0);
  });
});

describe('ageEntries', () => {
  const asOf = { asOf: '2026-09-30', basis: 'invoice' as const, buckets: 'month' as const };

  test('a group\'s money knocks off its bills oldest first; what is owed sits in its month', () => {
    const rows = ageEntries([
      e({ docNo: 'DI-1', kind: 'Deposit invoice', date: '2026-06-01', amountSen: 300 }),
      e({ docNo: 'PAY-1', kind: 'Payment', date: '2026-06-01', amountSen: -300 }),
      e({ docNo: 'SI-1', date: '2026-06-20', dueDate: '2026-07-20', amountSen: 900 }),
      e({ docNo: 'CN-1', kind: 'Credit note', date: '2026-06-20', amountSen: -300 }),
    ], asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ balanceSen: 600, unappliedSen: 0, cells: [0, 0, 0, 600, 0] });
    expect(rows[0]!.items).toEqual([{ group: 'SO:1', docNo: 'SI-1', kind: 'Invoice', date: '2026-06-20', dueDate: '2026-07-20', amountSen: 900, openSen: 600, column: 3 }]);

    const byDue = ageEntries([
      e({ docNo: 'SI-1', date: '2026-06-20', dueDate: '2026-07-20', amountSen: 900 }),
    ], { ...asOf, basis: 'due' });
    expect(byDue[0]!.cells).toEqual([0, 0, 900, 0, 0]);
  });

  test('money a group has no bill for is 未冲 — never spent on another group\'s bill (B3a)', () => {
    const rows = ageEntries([
      e({ group: 'SO:A', docNo: 'SI-A', date: '2026-08-10', amountSen: 1_200 }),
      e({ group: 'SO:A', docNo: 'SO-A', kind: 'Payment', date: '2026-07-05', amountSen: -800 }),
      e({ group: 'SO:B', docNo: 'SO-B', kind: 'Payment', date: '2026-09-15', amountSen: -1_000 }),
    ], asOf);
    expect(rows[0]).toMatchObject({ balanceSen: -600, unappliedSen: -1_000, cells: [0, 400, 0, 0, 0] });
    expect(rows[0]!.unapplied).toEqual([{ docNo: 'SO-B', kind: 'Payment', date: '2026-09-15', amountSen: -1_000 }]);
  });

  test('what is left of the money is its newest pieces', () => {
    const rows = ageEntries([
      e({ docNo: 'SI', date: '2026-09-10', amountSen: 500 }),
      e({ docNo: 'P-old', kind: 'Payment', date: '2026-08-01', amountSen: -400 }),
      e({ docNo: 'P-new', kind: 'Payment', date: '2026-09-01', amountSen: -400 }),
    ], asOf);
    expect(rows[0]!.unapplied).toEqual([{ docNo: 'P-new', kind: 'Payment', date: '2026-09-01', amountSen: -300 }]);
    expect(rows[0]!.balanceSen).toBe(-300);
  });

  test('a party settled to nothing is left out; totals add the rows', () => {
    const rows = ageEntries([
      e({ party: { key: 'Z', code: null, name: 'ZED' }, group: 'SO:Z', amountSen: 200 }),
      e({ party: { key: 'Z', code: null, name: 'ZED' }, group: 'SO:Z', kind: 'Payment', amountSen: -200 }),
      e({ party: { key: 'Y', code: null, name: 'YAN' }, group: 'SO:Y', amountSen: 50 }),
    ], asOf);
    expect(rows.map((r) => r.name)).toEqual(['YAN']);
    expect(agingTotals(rows)).toEqual({ balanceSen: 50, cells: [50, 0, 0, 0, 0], unappliedSen: 0 });
  });
});

describe('splitLine', () => {
  test('the parts go to their groups, the rest stays, and the pieces add back to the line', () => {
    const pieces = splitLine(e({ group: 'PV:1', docNo: 'PV-1', kind: 'Payment', amountSen: -6_000 }), [
      { group: 'PI:1', amountSen: 4_000, date: '2026-08-01' },
      { group: 'PI:2', amountSen: 1_500, date: '2026-09-20', kind: 'Advance applied' },
    ]);
    expect(pieces.map((p) => [p.group, p.amountSen, p.date, p.kind])).toEqual([
      ['PI:1', -4_000, '2026-08-01', 'Payment'],
      ['PI:2', -1_500, '2026-09-20', 'Advance applied'],
      ['PV:1', -500, '2026-09-01', 'Payment'],
    ]);
  });
  test('a part bigger than what is left is cut to it', () => {
    const pieces = splitLine(e({ group: 'PV:1', amountSen: -1_000 }), [{ group: 'PI:1', amountSen: 1_200, date: '2026-08-01' }]);
    expect(pieces.map((p) => [p.group, p.amountSen])).toEqual([['PI:1', -1_000]]);
  });
});

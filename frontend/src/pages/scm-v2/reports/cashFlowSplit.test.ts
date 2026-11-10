/* The Cash Flow's Settlement / Deposit view (owner 2026-11-09, his Receipt & Payment
   workbook: 「就是一行settlement一行deposit」). Pinned: Total stays whole with its %, each
   month becomes Settlement | Deposit under the month's name, each with its mark (owner
   2026-11-10: 做好看一点 — Settlement petrol, Deposit gold); a split line fills both, a line not
   split prints one figure across the month (a month without it, one empty cell across); a
   split running subtotal gets its two figures added up on a line under it. */

import { describe, expect, test } from 'vitest';
import { SPLIT_SUM_LABEL, splitColumns, splitKey, splitLines } from './cashFlowSplit';
import type { StatementColumn, StatementLine } from './statementColumns';

const total: StatementColumn = { key: 'total', label: 'Total', sub: '2 months', kind: 'total', from: '2026-09-01', to: '2026-10-31', pct: true };
const oct: StatementColumn = { key: '2026-10', label: 'Oct 2026', sub: 'to 09/11/2026 *', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: true };
const sep: StatementColumn = { key: '2026-09', label: 'Sep 2026', kind: 'period', from: '2026-09-01', to: '2026-09-30', pct: true };
const sd = (settlementSen: number, depositSen: number) => ({ settlementSen, depositSen });

describe('the columns', () => {
  test('Total as it is; each month as Settlement then Deposit under the month, newest first, no % of their own, each with its mark', () => {
    const cols = splitColumns([total, oct, sep]);
    expect(cols.map((c) => c.key)).toEqual(['total', '2026-10:S', '2026-10:D', '2026-09:S', '2026-09:D']);
    expect(cols[0]).toBe(total);
    expect(cols[1]).toEqual({
      key: '2026-10:S', label: 'Settlement', kind: 'period', from: '2026-10-01', to: '2026-10-31', pct: false,
      group: { key: '2026-10', label: 'Oct 2026', sub: 'to 09/11/2026 *' }, mark: 'petrol',
    });
    expect(cols[4]).toMatchObject({ label: 'Deposit', group: { key: '2026-09', label: 'Sep 2026' }, mark: 'gold' });
    expect(cols[0]).not.toHaveProperty('mark');
    expect(cols[4]!.group).not.toHaveProperty('sub');
    expect(splitKey('2026-10', 'D')).toBe('2026-10:D');
  });
});

describe('the lines', () => {
  const months = [total, oct, sep];
  const line = (id: string, kind: StatementLine['kind'], cells: StatementLine['cells'], depth = 1): StatementLine => ({ id, label: id, kind, depth, cells });

  test('a split line fills Settlement and Deposit in each month it has, a nil share no figure; Total stays whole with its %', () => {
    const [l] = splitLines([line('in:acc:300-0000', 'row', {
      total: { amountSen: 140_000, pct: 100 },
      '2026-10': { amountSen: 90_000, pct: 100, sd: sd(50_000, 40_000) },
      '2026-09': { amountSen: 50_000, pct: 100, sd: sd(0, 50_000) },
    })], months);
    expect(l!.cells).toEqual({
      total: { amountSen: 140_000, pct: 100 },
      '2026-10:S': { amountSen: 50_000, pct: null }, '2026-10:D': { amountSen: 40_000, pct: null },
      '2026-09:D': { amountSen: 50_000, pct: null },
    });
    expect(l!.spans).toBeUndefined();
  });

  test('a line not split prints one figure across each month; a month without it, one empty cell across', () => {
    const [l] = splitLines([line('out:acc:910-0000', 'row', { total: { amountSen: 5_000, pct: 2.5 }, '2026-10': { amountSen: 5_000, pct: 2.5 } })], months);
    expect(l!.cells).toEqual({ total: { amountSen: 5_000, pct: 2.5 }, '2026-10:S': { amountSen: 5_000, pct: null } });
    expect(l!.spans).toEqual({ '2026-10:S': 2, '2026-09:S': 2 });
  });

  test('a split line missing a month leaves that month\'s two columns empty each; a block title stays bare', () => {
    const out = splitLines([
      line('blk:cf:in', 'block', {}, 0),
      line('in:acc:300-0000', 'row', { total: { amountSen: 9, pct: null }, '2026-10': { amountSen: 9, pct: null, sd: sd(9, 0) } }),
    ], months);
    expect(out[0]).toEqual({ id: 'blk:cf:in', label: 'blk:cf:in', kind: 'block', depth: 0, cells: {} });
    expect(out[1]!.cells['2026-09:S']).toBeUndefined();
    expect(out[1]!.spans).toBeUndefined();
  });

  test('a split running subtotal gets Settlement + Deposit on a quiet line under it; a side\'s total does not', () => {
    const out = splitLines([
      line('tot:cf:in', 'total', { total: { amountSen: 90_000, pct: 100 }, '2026-10': { amountSen: 90_000, pct: 100, sd: sd(50_000, 40_000) } }, 0),
      line('cf:sub:ops', 'net', { total: { amountSen: 60_000, pct: null }, '2026-10': { amountSen: 60_000, pct: null, sd: sd(40_000, 20_000) } }, 0),
      line('net:surplus', 'net', { total: { amountSen: 55_000, pct: 61.1 }, '2026-10': { amountSen: 55_000, pct: 61.1 } }, 0),
    ], months);
    expect(out.map((l) => l.id)).toEqual(['tot:cf:in', 'cf:sub:ops', 'cf:sub:ops:sum', 'net:surplus']);
    expect(out[2]).toEqual({
      id: 'cf:sub:ops:sum', label: SPLIT_SUM_LABEL, kind: 'memo', depth: 1,
      cells: { total: { amountSen: 60_000, pct: null }, '2026-10:S': { amountSen: 60_000, pct: null } },
      spans: { '2026-10:S': 2, '2026-09:S': 2 },
    });
    /* The surplus is not split: one figure across the month. */
    expect(out[3]!.spans).toEqual({ '2026-10:S': 2, '2026-09:S': 2 });
  });
});

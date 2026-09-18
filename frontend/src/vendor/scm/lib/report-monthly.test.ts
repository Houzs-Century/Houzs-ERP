/* A Finance report month by month (owner 2026-09-14, docs/bugs/0916: 能看每个月的;
   his sample: 累计 leftmost, newest month on the left, older to the right, a %
   toggle). Pinned: the months and their columns; the merge of columns whose
   trees differ; each report as lines in the order its screen prints; the CSV. */

import { describe, expect, test } from 'vitest';
import type { LaidNode } from './report-layout';
import {
  balanceSheetLines, mergeColumns, monthBefore, monthColumns, monthEnd, monthLabel, monthlyCsv, monthlyDepth, monthlyLinesAtLevel,
  monthsBack, performanceLines, pnlLines, rpLines, treeLines, type FlatLine,
} from './report-monthly';

const acc = (code: string, amountSen: number, pct: number | null = null, cells?: Record<string, number>): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label: `${code} — ${code}`, code, key: code, amountSen, pct, cells, children: [] });
const cat = (id: string, label: string, children: LaidNode[], pct: number | null = null): LaidNode =>
  ({ kind: 'category', id, label, amountSen: children.reduce((s, n) => s + n.amountSen, 0), pct, children });

describe('months', () => {
  test('monthEnd knows February and the leap year; monthBefore crosses the year', () => {
    expect(monthEnd('2026-09')).toBe('2026-09-30');
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
    expect(monthBefore('2026-01', 1)).toBe('2025-12');
    expect(monthBefore('2026-03', 14)).toBe('2025-01');
    expect(monthBefore('2026-03', 0)).toBe('2026-03');
  });

  test('monthsBack is newest first; monthColumns puts 累计 leftmost, or not at all', () => {
    expect(monthsBack('2026-09', 3)).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(monthsBack('2026-09', 0)).toEqual(['2026-09']);
    const cols = monthColumns('2026-09', 3, true);
    expect(cols.map((c) => c.key)).toEqual(['cumulative', '2026-09', '2026-08', '2026-07']);
    expect(cols[0]).toMatchObject({ label: '累计 07/2026 – 09/2026', from: '2026-07-01', to: '2026-09-30', cumulative: true });
    expect(cols[1]).toMatchObject({ label: '09/2026', from: '2026-09-01', to: '2026-09-30', cumulative: false });
    expect(cols[3]).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    expect(monthColumns('2026-09', 2, false).map((c) => c.key)).toEqual(['2026-09', '2026-08']);
    expect(monthLabel('2026-01')).toBe('01/2026');
  });
});

describe('mergeColumns', () => {
  const line = (id: string, amountSen: number, depth = 1, kind: FlatLine['kind'] = 'row'): FlatLine => ({ id, label: id, kind, depth, amountSen, pct: null });

  test('the union by id, each column\'s figure in its cell, a line one column lacks left empty there', () => {
    const merged = mergeColumns([
      { key: 'cumulative', lines: [line('a', 30), line('b', 20), line('tot', 50, 0, 'total')] },
      { key: '2026-09', lines: [line('a', 10), line('tot', 10, 0, 'total')] },
      { key: '2026-08', lines: [line('a', 20), line('b', 20), line('tot', 40, 0, 'total')] },
    ]);
    expect(merged.map((l) => l.id)).toEqual(['a', 'b', 'tot']);
    expect(merged[1]!.cells).toEqual({ cumulative: { amountSen: 20, pct: null }, '2026-08': { amountSen: 20, pct: null } });
    expect(merged[1]!.cells['2026-09']).toBeUndefined();
    expect(merged[2]!.kind).toBe('total');
  });

  test('a line only a later column has lands right after the line before it in that column', () => {
    /* 900-A014 booked in August only, reversed in September: the cumulative
       range nets it to nothing, so the spine lacks it. */
    const merged = mergeColumns([
      { key: 'cumulative', lines: [line('blk', 0, 0, 'block'), line('a', 30), line('c', 5), line('tot', 35, 0, 'total')] },
      { key: '2026-09', lines: [line('blk', 0, 0, 'block'), line('a', 10), line('x', -15), line('c', 5), line('tot', 0, 0, 'total')] },
      { key: '2026-08', lines: [line('blk', 0, 0, 'block'), line('a', 20), line('x', 15), line('tot', 35, 0, 'total')] },
    ]);
    expect(merged.map((l) => l.id)).toEqual(['blk', 'a', 'x', 'c', 'tot']);
    expect(merged[2]!.cells).toEqual({ '2026-09': { amountSen: -15, pct: null }, '2026-08': { amountSen: 15, pct: null } });
  });

  test('a first line a later column adds goes to the top; no columns is no lines', () => {
    const merged = mergeColumns([{ key: 'a', lines: [line('x', 1)] }, { key: 'b', lines: [line('y', 2), line('x', 1)] }]);
    expect(merged.map((l) => l.id)).toEqual(['y', 'x']);
    expect(mergeColumns([])).toEqual([]);
  });

  test('levels fold by depth, the fixed lines always stay', () => {
    const merged = mergeColumns([{ key: 'k', lines: [line('blk', 0, 0, 'block'), line('c1', 1, 1, 'category'), line('r', 1, 2), line('tot', 1, 0, 'total')] }]);
    expect(monthlyDepth(merged)).toBe(2);
    expect(monthlyLinesAtLevel(merged, 1).map((l) => l.id)).toEqual(['blk', 'c1', 'tot']);
    expect(monthlyLinesAtLevel(merged, 'all').map((l) => l.id)).toEqual(['blk', 'c1', 'r', 'tot']);
  });
});

describe('each report as lines', () => {
  test('treeLines keeps the tree\'s ids, an account is a row, depth from 1', () => {
    const lines = treeLines([cat('c', 'C', [acc('900-A001', 5, 1.5)])]);
    expect(lines).toEqual([
      { id: 'c', label: 'C', kind: 'category', depth: 1, amountSen: 5, pct: null },
      { id: 'acc:900-A001', label: '900-A001 — 900-A001', kind: 'row', depth: 2, amountSen: 5, pct: 1.5, code: '900-A001' },
    ]);
  });

  test('the P&L: block, tree, total, per block; gross; the tax lines only when tax posted; net', () => {
    const r = {
      layout: { baseSen: 100_000, tradingIncome: [acc('501-0000', 100_000, 100)], costOfSales: [acc('601-0003', 60_000, 60)], otherIncome: [], expenses: [cat('acc:900-0000', 'Operating Expense', [acc('900-A001', 12_000, 12)], 12)], taxation: [] },
      taxation: [],
      totals: { tradingIncomeSen: 100_000, costOfSalesSen: 60_000, grossProfitSen: 40_000, otherIncomeSen: 0, expensesSen: 12_000, netProfitSen: 28_000 },
    };
    const ids = pnlLines(r).map((l) => `${l.id}@${l.depth}`);
    expect(ids).toEqual([
      'blk:tradingIncome@0', 'acc:501-0000@1', 'tot:tradingIncome@0',
      'blk:costOfSales@0', 'acc:601-0003@1', 'tot:costOfSales@0',
      'net:gross@0',
      'blk:otherIncome@0', 'tot:otherIncome@0',
      'blk:expenses@0', 'acc:900-0000@1', 'acc:900-A001@2', 'tot:expenses@0',
      'net:net@0',
    ]);
    const net = pnlLines(r).find((l) => l.id === 'net:net')!;
    expect(net).toMatchObject({ kind: 'net', amountSen: 28_000, pct: 28 });
    const withTax = pnlLines({ ...r, taxation: [{}], layout: { ...r.layout, taxation: [acc('950-0000', 3_000, 3)] }, totals: { ...r.totals, profitBeforeTaxSen: 28_000, taxationSen: 3_000, netProfitSen: 25_000 } });
    expect(withTax.map((l) => l.id)).toContain('net:pbt');
    expect(withTax.map((l) => l.id)).toContain('tot:taxation');
  });

  test('the balance sheet: three blocks, earnings, the balanced line — every % of that column\'s total assets', () => {
    const r = {
      layout: { baseSen: 101_000, assets: [cat('sec:CURRENT ASSETS', 'CURRENT ASSETS', [acc('310-0010', 91_000, 90.1), acc('330-0000', 10_000, 9.9)], 100)], liabilities: [acc('400-0000', 60_000, 59.4)], equity: [] },
      totals: { assetsSen: 101_000, liabilitiesSen: 60_000, equitySen: 0, earningsSen: 41_000, checkSen: 0 },
    };
    const lines = balanceSheetLines(r);
    expect(lines.map((l) => l.id)).toEqual(['blk:assets', 'sec:CURRENT ASSETS', 'acc:310-0010', 'acc:330-0000', 'tot:assets', 'blk:liabilities', 'acc:400-0000', 'tot:liabilities', 'blk:equity', 'tot:equity', 'row:earnings', 'net:check']);
    expect(lines.find((l) => l.id === 'tot:liabilities')).toMatchObject({ amountSen: 60_000, pct: 59.4 });
    expect(lines.find((l) => l.id === 'row:earnings')).toMatchObject({ amountSen: 41_000, pct: 40.6 });
    expect(lines.find((l) => l.id === 'net:check')).toMatchObject({ label: 'BALANCED', amountSen: 101_000, pct: 100 });
    const out = balanceSheetLines({ ...r, totals: { ...r.totals, checkSen: 500 } }).find((l) => l.id === 'net:check')!;
    expect(out).toMatchObject({ label: 'OUT OF BALANCE', amountSen: 500, pct: null });
  });

  test('the Performance P&L: sales, cost and gross profit per group with their totals, then the summary lines by their ids', () => {
    const r = {
      groups: [{ key: 'sofa', label: 'Sofa', salesSen: 300_000, cogsSen: 180_000, gpSen: 120_000, gpPct: 40 }, { key: 'service', label: 'Service', salesSen: 20_000, cogsSen: 0, gpSen: 20_000, gpPct: 100 }],
      totals: { salesSen: 320_000, cogsSen: 180_000, gpSen: 140_000, gpPct: 43.8 },
    };
    const summary = [
      { id: 'sum:gross', kind: 'total' as const, label: 'Gross profit', amountSen: 140_000, pct: 43.8, depth: 0 },
      { id: 'acc:900-O001', kind: 'row' as const, label: 'Operating expense — 16.00%…', amountSen: 48_000, pct: 15, depth: 1 },
      { id: 'sum:net', kind: 'net' as const, label: 'NET PERFORMANCE', amountSen: 92_000, pct: 28.8, depth: 0 },
    ];
    const lines = performanceLines(r, summary);
    expect(lines.map((l) => l.id)).toEqual(['blk:sales', 'sales:sofa', 'sales:service', 'tot:sales', 'blk:cogs', 'cogs:sofa', 'cogs:service', 'tot:cogs', 'blk:gp', 'gp:sofa', 'gp:service', 'tot:gp', 'sum:gross', 'acc:900-O001', 'sum:net']);
    expect(lines.find((l) => l.id === 'sales:sofa')).toMatchObject({ label: 'Sofa', amountSen: 300_000, pct: 93.8, depth: 1 });
    expect(lines.find((l) => l.id === 'gp:sofa')).toMatchObject({ amountSen: 120_000, pct: 40 });
    expect(lines.find((l) => l.id === 'tot:gp')).toMatchObject({ amountSen: 140_000, pct: 43.8, kind: 'total' });
    expect(lines.find((l) => l.id === 'sum:net')).toMatchObject({ kind: 'net', depth: 0 });
  });

  test('the Cash Flow: each top category as a block, its tree, its own subtotal name; a running subtotal; then Cash Surplus, Balance b/f, Balance c/f', () => {
    const top = (id: string, label: string, flow: 'in' | 'out', totalLabel: string, children: LaidNode[], pct: number | null, kind: LaidNode['kind'] = 'category'): LaidNode =>
      ({ ...cat(id, label, children, pct), kind, flow, totalLabel });
    const r = {
      layout: {
        inSen: 50_000, outSen: 70_000,
        tree: [
          top('side:in', 'RECEIPTS', 'in', 'Total receipts', [{ ...acc('300-0000', 50_000, 100, { '310-0010': 50_000 }), id: 'in:acc:300-0000', flow: 'in' as const }], 100),
          top('side:out', 'PAYMENTS', 'out', 'Total payments', [cat('out:cat:p', 'Purchases', [{ ...acc('601-0003', 40_000, 57.1), id: 'out:acc:601-0003', flow: 'out' as const }], 57.1)], 57.1),
          { kind: 'subtotal' as const, id: 'sub:ops', label: 'Net operation surplus / (deficit)', amountSen: 10_000, pct: null, children: [] },
          top('unassigned:out', 'Unassigned payments', 'out', 'Total unassigned payments', [{ ...acc('ADV', 30_000, 42.9), id: 'out:acc:ADV', flow: 'out' as const }], 42.9, 'unassigned'),
        ],
      },
      totals: { openingTotalSen: -10_000, receiptsTotalSen: 50_000, paymentsTotalSen: 70_000, closingTotalSen: -30_000 },
    };
    const lines = rpLines(r);
    expect(lines.map((l) => l.id)).toEqual([
      'blk:side:in', 'in:acc:300-0000', 'tot:side:in', 'blk:side:out', 'out:cat:p', 'out:acc:601-0003', 'tot:side:out', 'sub:ops',
      'blk:unassigned:out', 'out:acc:ADV', 'tot:unassigned:out', 'net:surplus', 'bal:opening', 'bal:closing',
    ]);
    expect(lines.find((l) => l.id === 'tot:side:in')).toMatchObject({ label: 'Total receipts', kind: 'total', amountSen: 50_000, pct: 100 });
    expect(lines.find((l) => l.id === 'sub:ops')).toMatchObject({ label: 'Net operation surplus / (deficit)', kind: 'net', amountSen: 10_000, pct: null });
    expect(lines.find((l) => l.id === 'tot:unassigned:out')).toMatchObject({ label: 'Total unassigned payments', kind: 'total', amountSen: 30_000, pct: 42.9 });
    expect(lines.find((l) => l.id === 'net:surplus')).toMatchObject({ label: 'Cash Surplus / (Deficit)', kind: 'net', amountSen: -20_000, pct: null });
    expect(lines.find((l) => l.id === 'bal:opening')).toMatchObject({ label: 'Balance b/f', kind: 'total', amountSen: -10_000 });
    expect(lines.find((l) => l.id === 'bal:closing')).toMatchObject({ label: 'Balance c/f', kind: 'net', amountSen: -30_000, pct: null });
  });
});

describe('the CSV', () => {
  test('the columns as headings, the lines indented by depth, amounts or %, a block line blank', () => {
    const cols = monthColumns('2026-09', 2, true);
    const lines = mergeColumns([
      { key: 'cumulative', lines: [{ id: 'blk', label: 'Expenses', kind: 'block', depth: 0, amountSen: 0, pct: null }, { id: 'c', label: 'Ops', kind: 'category', depth: 1, amountSen: 3_000, pct: 30 }, { id: 'r', label: 'Rent, "big"', kind: 'row', depth: 2, amountSen: 3_000, pct: 30 }] },
      { key: '2026-09', lines: [{ id: 'blk', label: 'Expenses', kind: 'block', depth: 0, amountSen: 0, pct: null }, { id: 'c', label: 'Ops', kind: 'category', depth: 1, amountSen: 1_000, pct: 10 }, { id: 'r', label: 'Rent, "big"', kind: 'row', depth: 2, amountSen: 1_000, pct: 10 }] },
    ]);
    const fmt = (sen: number) => (sen / 100).toFixed(2);
    const pct = (p: number | null) => (p === null ? '—' : `${p.toFixed(1)}%`);
    const csv = monthlyCsv('P&L', cols, lines, false, fmt, pct);
    expect(csv.split('\r\n')[0]).toBe('P&L,累计 08/2026 – 09/2026,09/2026,08/2026');
    expect(csv).toContain('Expenses,,,');
    expect(csv).toContain('Ops,30.00,10.00,');
    expect(csv).toContain('"  Rent, ""big""",30.00,10.00,');
    expect(monthlyCsv('P&L', cols, lines, true, fmt, pct)).toContain('Ops,30.0%,10.0%,');
  });
});

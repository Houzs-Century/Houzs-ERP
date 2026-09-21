/* The owner's P&L expense tree as scripts/seed-pnl-layout.mjs writes it
   (2026-09-19: pnl 那边的 account 显示要和 cash flow 一样). Pinned: an expense
   lands where the Cash Flow's rule sends it and nowhere else; the groups a
   company never uses are unticked for it; a group nothing fills (Purchases,
   Accounts payable — other blocks' money) is pruned; the whole layout
   validates for the P&L and the Performance P&L with every other block the
   chart's own; laid out, the tree prints the Cash Flow's groups — Transport &
   logistics and Commission under Administrative expense, the P&L's own home for
   them since 2026-09-21, no Cost of funds group (the lines
   carry their own labels here — the default spelling is pinned in
   src/acc/report-layout.test.ts), and a
   company's hidden group sends its lines to Unassigned. The lay-out itself
   is src/acc/report-layout.test.ts; the Cash Flow tree tests/cashFlowSeedTree.test.ts. */
import { describe, expect, it } from 'vitest';
import { buildPnlExpenseTree, expenseHomeOf, topIdsOf, withExpenseTree } from '../scripts/lib/pnl-tree.mjs';
import { countLeaves, outline } from '../scripts/lib/cash-flow-tree.mjs';
import { defaultLayout, layOutBlock, validateLayout, type ChartAccount, type LaidNode, type LayoutCategory, type LayoutItem } from '../src/acc/report-layout';

const acc = (code: string, name: string, section: string, type = 'EXPENSE'): ChartAccount => ({ code, name, type, parentCode: null, section });
const chart: ChartAccount[] = [
  acc('501-0000', 'SALES', 'SALES', 'INCOME'),
  acc('601-0003', 'PURCHASES - SOFA', 'COST OF GOODS SOLD'),
  acc('590-0000', 'RENT RECEIVED', 'OTHER INCOMES', 'INCOME'),
  acc('900-T006', 'TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', 'EXPENSES'),
  acc('900-C003', 'COMMISSION', 'EXPENSES'),
  acc('900-R031', 'RENTAL - ROADSHOW', 'EXPENSES'),
  acc('900-W005', 'WATER & ELECTRICITY - SHOWROOM', 'EXPENSES'),
  acc('900-R002', 'RENTAL - WAREHOUSE', 'EXPENSES'),
  acc('900-S100', 'STAFF SALARIES & OVERTIME', 'EXPENSES'),
  acc('900-R044', 'RENTAL - OFFICE E-28-02', 'EXPENSES'),
  acc('900-A002', 'ADVERTISEMENT - ONLINE', 'EXPENSES'),
  acc('900-A001', 'ACCOUNTING FEE', 'EXPENSES'),
  acc('900-O001', 'OPERATING EXPENSE', 'EXPENSES'),
  acc('900-T009', 'TERMINAL INTEREST CHARGES', 'EXPENSES'),
  acc('999-9999', 'SOMETHING NEW ON THE CHART', 'EXPENSES'),
  acc('950-0000', 'TAXATION', 'TAXATION'),
];
const expenses = chart.filter((a) => a.section === 'EXPENSES');

const find = (items: LayoutItem[], id: string): LayoutCategory | null => {
  for (const it of items) {
    if (it.kind !== 'category') continue;
    if (it.id === id) return it;
    const hit = find(it.children, id);
    if (hit) return hit;
  }
  return null;
};
const codesOf = (cat: LayoutCategory | null): string[] => (cat?.children ?? []).flatMap((c) => (c.kind === 'account' ? [c.code] : []));
const allCodes = (items: LayoutItem[]): string[] => items.flatMap((it) => (it.kind === 'account' ? [it.code] : it.kind === 'category' ? allCodes(it.children) : []));

describe('the seeded P&L expense tree', () => {
  it('files every expense by the Cash Flow rule, prunes the groups other blocks own, and unticks the Houzs-only groups for 2990', () => {
    expect(expenseHomeOf('900-T006')).toEqual({ id: 'pl:general:transport', unmatched: false });
    expect(expenseHomeOf('900-S100')).toEqual({ id: 'pl:general:salary', unmatched: false });
    expect(expenseHomeOf('900-T009')).toEqual({ id: 'pl:finance', unmatched: false });
    expect(expenseHomeOf('999-9999')).toEqual({ id: 'pl:general:office', unmatched: true });

    const { items, mapping, unmatched } = buildPnlExpenseTree(expenses);
    expect(topIdsOf(items)).toEqual(['pl:exh', 'pl:showroom', 'pl:warehouse', 'pl:general', 'pl:finance']);
    /* No Cost of funds group on the P&L (owner 2026-09-21): Transport & logistics and Commission sit under Administrative expense, after the office lines. */
    expect(find(items, 'pl:cost')).toBeNull();
    expect(find(items, 'pl:general')!.label).toBe('Administrative expense');
    expect(find(items, 'pl:general')!.children.map((c) => (c.kind === 'category' ? c.id : c.kind))).toEqual([
      'pl:general:salary', 'pl:general:rental', 'pl:general:marketing', 'pl:general:professional', 'pl:general:office', 'pl:general:transport', 'pl:general:commission',
    ]);
    expect(codesOf(find(items, 'pl:general:transport'))).toEqual(['900-T006']);
    expect(codesOf(find(items, 'pl:general:commission'))).toEqual(['900-C003']);
    expect(codesOf(find(items, 'pl:exh'))).toEqual(['900-R031']);
    expect(codesOf(find(items, 'pl:showroom'))).toEqual(['900-W005']);
    expect(codesOf(find(items, 'pl:warehouse'))).toEqual(['900-R002']);
    expect(codesOf(find(items, 'pl:general:salary'))).toEqual(['900-S100']);
    expect(codesOf(find(items, 'pl:general:rental'))).toEqual(['900-R044']);
    expect(codesOf(find(items, 'pl:general:marketing'))).toEqual(['900-A002']);
    expect(codesOf(find(items, 'pl:general:professional'))).toEqual(['900-A001']);
    expect(codesOf(find(items, 'pl:general:office'))).toEqual(['900-O001', '999-9999']);
    expect(codesOf(find(items, 'pl:finance'))).toEqual(['900-T009']);
    expect(find(items, 'pl:general:homestay')).toBeNull();
    expect(find(items, 'pl:exh')!.hiddenFor).toEqual([2]);
    expect(find(items, 'pl:warehouse')!.hiddenFor).toEqual([2]);
    expect(find(items, 'pl:showroom')!.hiddenFor).toBeUndefined();
    /* Every expense once, no other section's account at all. */
    expect(countLeaves(items)).toBe(expenses.length);
    expect(allCodes(items).sort()).toEqual(expenses.map((a) => a.code).sort());
    expect(allCodes(items)).not.toContain('601-0003');
    expect(unmatched).toEqual(['999-9999']);
    expect(mapping.find((m) => m.code === '999-9999')).toEqual({ code: '999-9999', name: 'SOMETHING NEW ON THE CHART', group: 'pl:general:office', unmatched: true });
    expect(outline(items)).toEqual([
      'Exhibition & roadshow expense (hidden for 2) · 1 line',
      'Showrooms expense · 1 line',
      'Warehouse expense (hidden for 2) · 1 line',
      'Administrative expense · 8 lines',
      '  Salary & related · 1 line',
      '  Rental - office & others · 1 line',
      '  Advertising & marketing · 1 line',
      '  Professional & statutory · 1 line',
      '  Office & admin · 2 lines',
      '  Transport & logistics · 1 line',
      '  Commission · 1 line',
      'Finance cost · 1 line',
    ]);
  });

  it('makes a layout the P&L and the Performance P&L each accept, every other block the chart\'s own', () => {
    const { items } = buildPnlExpenseTree(expenses);
    for (const report of ['pnl', 'performance'] as const) {
      const layout = withExpenseTree(defaultLayout(report, chart), items);
      const checked = validateLayout(report, layout);
      expect(checked.ok, report).toBe(true);
      if (!checked.ok) return;
      expect(topIdsOf(checked.layout.blocks.expenses)).toEqual(['pl:exh', 'pl:showroom', 'pl:warehouse', 'pl:general', 'pl:finance']);
      expect(allCodes(checked.layout.blocks.otherIncome ?? [])).toEqual(['590-0000']);
    }
    const pnl = withExpenseTree(defaultLayout('pnl', chart), items);
    expect(allCodes(pnl.blocks.tradingIncome ?? [])).toEqual(['501-0000']);
    expect(allCodes(pnl.blocks.costOfSales ?? [])).toEqual(['601-0003']);
    expect(allCodes(pnl.blocks.taxation ?? [])).toEqual(['950-0000']);
    expect(Object.keys(withExpenseTree(defaultLayout('performance', chart), items).blocks).sort()).toEqual(['expenses', 'otherIncome']);
  });

  it('laid out, prints the Cash Flow\'s groups and labels; a hidden group sends its lines to Unassigned for that company', () => {
    const { items } = buildPnlExpenseTree(expenses);
    const lines = [
      { code: '900-T006', name: 'TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', label: '900-T006 · TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', amountSen: 178_630 },
      { code: '900-S100', name: 'STAFF SALARIES & OVERTIME', label: '900-S100 · STAFF SALARIES & OVERTIME', amountSen: 1_067_642 },
      { code: '900-R031', name: 'RENTAL - ROADSHOW', label: '900-R031 · RENTAL - ROADSHOW', amountSen: 50_000 },
      { code: '999-9999', name: 'SOMETHING NEW ON THE CHART', label: '999-9999 · SOMETHING NEW ON THE CHART', amountSen: 100 },
    ];
    const flat = (nodes: LaidNode[]): unknown[] => nodes.map((n) => (n.children.length > 0 ? [n.kind, n.label, n.amountSen, flat(n.children)] : [n.kind, n.label, n.amountSen]));
    expect(flat(layOutBlock(items as LayoutItem[], lines, 1, null))).toEqual([
      ['category', 'Exhibition & roadshow expense', 50_000, [['account', '900-R031 · RENTAL - ROADSHOW', 50_000]]],
      ['category', 'Administrative expense', 1_246_372, [
        ['category', 'Salary & related', 1_067_642, [['account', '900-S100 · STAFF SALARIES & OVERTIME', 1_067_642]]],
        ['category', 'Office & admin', 100, [['account', '999-9999 · SOMETHING NEW ON THE CHART', 100]]],
        ['category', 'Transport & logistics', 178_630, [['account', '900-T006 · TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', 178_630]]],
      ]],
    ]);
    /* 2990 (company 2) never ticks Exhibition: its roadshow rent is not lost, it prints under Unassigned. */
    const forTwo = layOutBlock(items as LayoutItem[], lines, 2, null);
    expect(forTwo.map((n) => n.label)).toEqual(['Administrative expense', 'Unassigned']);
    expect(forTwo[1]!.children.map((n) => n.label)).toEqual(['900-R031 · RENTAL - ROADSHOW']);
  });
});

/* The owner's Cash Flow tree as scripts/seed-cash-flow-layout.mjs writes it
   (2026-09-18: 你先做，然后我才自己调). Pinned: the tree the builder makes
   validates as a Cash Flow layout; every chart account lands exactly where a
   rule sends it, a customer's money in and out apart; the groups a company
   never uses are unticked for it; the account nobody named still has a home
   and is listed. The lay-out itself is src/acc/report-layout.test.ts. */
import { describe, expect, it } from 'vitest';
import { buildCashFlowTree, countLeaves, groupOf, outline, topIds } from '../scripts/lib/cash-flow-tree.mjs';
import { layOutCashFlow, validateLayout, type LayoutCategory, type LayoutItem } from '../src/acc/report-layout';

const chart = [
  { code: '300-0000', name: 'ACCOUNT RECEIVEABLE' },
  { code: '326-0010', name: 'CARD MACHINE CLEARING — PBB' },
  { code: '350-0050', name: 'LOAN TO RELATED PARTY - HOUZS VENTURES' },
  { code: '900-R048', name: 'RENTAL OF SHOWROOM - 2990S' },
  { code: '900-R031', name: 'RENTAL - ROADSHOW' },
  { code: '200-8000', name: 'COMPUTER EQUIPMENT & SOFTWARE' },
  { code: '599-0005', name: 'INTEREST INCOME' },
  { code: '310-0010', name: 'CASH AT BANK - MAYBANK' },
  { code: '999-9999', name: 'SOMETHING NEW ON THE CHART' },
];

const find = (items: LayoutItem[], id: string): LayoutCategory | null => {
  for (const it of items) {
    if (it.kind !== 'category') continue;
    if (it.id === id) return it;
    const hit = find(it.children, id);
    if (hit) return hit;
  }
  return null;
};
const codesOf = (cat: LayoutCategory | null): string[] => (cat?.children ?? []).flatMap((c) => (c.kind === 'account' ? [`${c.code}:${c.flow ?? '-'}`] : []));

describe('the seeded Cash Flow tree', () => {
  it('validates, keeps a customer\'s money in and out apart, and hides the Houzs-only groups for 2990', () => {
    const { layout, mapping, unmatched } = buildCashFlowTree(chart);
    const checked = validateLayout('rp', layout);
    expect(checked.ok).toBe(true);
    const items = layout.blocks.accounts as LayoutItem[];
    expect(topIds(layout)).toEqual(['cf:in', 'cf:ops', 'cf:sub:ops', 'cf:other-income', 'cf:tax', 'cf:finance', 'cf:sub:after-others', 'cf:funding', 'cf:transfers']);
    expect(codesOf(find(items, 'cf:in:deposit'))).toEqual(['300-0000:in', '326-0010:in']);
    expect(codesOf(find(items, 'cf:in:refund'))).toEqual(['300-0000:out', '326-0010:out']);
    expect(codesOf(find(items, 'cf:funding:related'))).toEqual(['350-0050:in']);
    expect(codesOf(find(items, 'cf:funding:related-out'))).toEqual(['350-0050:out']);
    expect(codesOf(find(items, 'cf:ops:showroom'))).toEqual(['900-R048:net']);
    expect(codesOf(find(items, 'cf:ops:exh'))).toEqual(['900-R031:net']);
    expect(find(items, 'cf:ops:exh')?.hiddenFor).toEqual([2]);
    expect(find(items, 'cf:ops:warehouse')?.hiddenFor).toEqual([2]);
    expect(find(items, 'cf:ops:showroom')?.hiddenFor).toBeUndefined();
    expect(codesOf(find(items, 'cf:funding:capex'))).toEqual(['200-8000:net']);
    expect(codesOf(find(items, 'cf:other-income'))).toEqual(['599-0005:net']);
    expect(codesOf(find(items, 'cf:transfers'))).toEqual(['310-0010:net']);
    /* The stranger lands in Office & admin and is named. */
    expect(codesOf(find(items, 'cf:ops:general:office'))).toEqual(['999-9999:net']);
    expect(unmatched).toEqual(['999-9999']);
    expect(mapping.find((m) => m.code === '999-9999')).toMatchObject({ group: 'cf:ops:general:office', unmatched: true });
    /* Nine accounts, two of them twice. */
    expect(countLeaves(items)).toBe(chart.length + 3);
    expect(groupOf('900-A014')).toEqual({ id: 'cf:ops:showroom', flow: 'net' });
    expect(outline(items)[0]).toBe('CASH IN [IN] → Total Cash In · 4 lines');
  });

  it('lays out the way the workbook reads: a refund negative under CASH IN, CAPEX negative under funding, the running subtotals', () => {
    const { layout } = buildCashFlowTree(chart);
    const checked = validateLayout('rp', layout);
    if (!checked.ok) throw new Error(checked.reason);
    const line = (code: string, sen: number) => ({ code, key: code, name: code, label: code, amountSen: sen, cells: { '310-0010': sen } });
    const cf = layOutCashFlow(checked.layout.blocks.accounts!, [line('300-0000', 7_421_455), line('350-0050', 6_000_000)], [line('300-0000', 100_000), line('900-R048', 4_500_000), line('200-8000', 624_600), line('350-0050', 2_000_000)], 2);
    const tops = cf.nodes.map((n) => [n.label, n.amountSen]);
    expect(tops).toEqual([
      ['CASH IN', 7_321_455], ['OPERATIONS OUTFLOWS', 4_500_000], ['Net operation surplus / (deficit)', 2_821_455],
      ['OTHER INCOME', 0], ['TAXATION', 0], ['FINANCE COST', 0], ['Cash Surplus / (Deficit) after others', 2_821_455],
      ['FUNDING IN / (OUT)', 3_375_400], ['TRANSFERS BETWEEN OWN ACCOUNTS', 0],
    ]);
    const cashIn = cf.nodes[0]!;
    expect(cashIn.children.map((c) => [c.label, c.amountSen])).toEqual([['Deposit received', 7_421_455], ['(-) Refund to customer', -100_000]]);
    expect(cf.inSen - cf.outSen).toBe(7_421_455 + 6_000_000 - (100_000 + 4_500_000 + 624_600 + 2_000_000));
  });
});

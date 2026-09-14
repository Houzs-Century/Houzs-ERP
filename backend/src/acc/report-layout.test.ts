/* The report layout (owner 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account
   分层 … 我要能自己调动排版，然后能自己加大 categories … 做公用然后选要不要). Pinned:
     · the default tree is the chart's own — a header with children becomes a
       category named after it, leaves are lines, a block spanning two sections
       gets one category per section, a child whose parent sits in another
       section files as a root of its OWN section's block, an unsectioned row
       takes its type's default shelf;
     · a tree somebody sends is checked — version, blocks, ids, names, a code
       placed twice, depth — and normalised;
     · laying figures on the tree: subtotals, % of the base on every line, an
       empty category never prints, a category a company unticked is skipped
       with its subtree, and whatever the tree did not place goes under
       Unassigned so the block's total is the sum of what is printed. */

import { describe, expect, test } from 'vitest';
import {
  defaultLayout, laidDepth, layOutBlock, pctOf, validateLayout,
  type ChartAccount, type LaidNode, type Layout, type LayoutItem,
} from './report-layout';

const acc = (code: string, name: string, type: string, parentCode: string | null, section: string | null): ChartAccount =>
  ({ code, name, type, parentCode, section });

const CHART: ChartAccount[] = [
  acc('500-0000', 'SALES', 'INCOME', null, 'SALES'),
  acc('500-0001', 'SALES - BEDFRAME', 'INCOME', '500-0000', 'SALES'),
  acc('510-0000', 'SALES RETURN', 'INCOME', null, 'SALES ADJUSTMENTS'),
  acc('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', null, 'COST OF GOODS SOLD'),
  /* Older than the section migration: no section — the default shelf for a 6xx EXPENSE. */
  acc('615-0000', 'CARRIAGE INWARDS', 'EXPENSE', null, null),
  acc('700-0000', 'Other Income', 'INCOME', null, 'OTHER INCOMES'),
  acc('590-0000', 'RENT RECEIVED', 'INCOME', '700-0000', 'OTHER INCOMES'),
  /* Hangs under 500-0000 on the chart, but its SECTION is other income. */
  acc('530-0000', 'COMMISSION RECEIVED', 'INCOME', '500-0000', 'OTHER INCOMES'),
  acc('900-0000', 'Operating Expense', 'EXPENSE', null, 'EXPENSES'),
  acc('900-A001', 'ACCOUNTING FEE', 'EXPENSE', '900-0000', 'EXPENSES'),
  acc('900-A002', 'ADVERTISEMENT', 'EXPENSE', '900-0000', 'EXPENSES'),
  acc('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSE', '900-A002', 'EXPENSES'),
  acc('900-O001', 'OPERATIING EXPENSE', 'EXPENSE', null, 'EXPENSES'),
  acc('950-0000', 'TAXATION', 'EXPENSE', null, 'TAXATION'),
];

const shape = (items: LayoutItem[]): unknown[] =>
  items.map((it) => (it.kind === 'account' ? it.code : { [it.id]: shape(it.children) }));

describe('defaultLayout — the chart as a tree', () => {
  const layout = defaultLayout('pnl', CHART);

  test('a header becomes a category named after it, leaves are lines, roots in code order', () => {
    expect(shape(layout.blocks.expenses!)).toEqual([
      { 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }] },
      '900-O001',
    ]);
    const op = layout.blocks.expenses![0] as { label: string; code?: string };
    expect(op.label).toBe('Operating Expense');
    expect(op.code).toBe('900-0000');
  });

  test('a block spanning two sections gets one category per section; an empty section is left out', () => {
    expect(shape(layout.blocks.tradingIncome!)).toEqual([
      { 'sec:SALES': [{ 'acc:500-0000': ['500-0001'] }] },
      { 'sec:SALES ADJUSTMENTS': ['510-0000'] },
    ]);
    /* OTHER INCOMES + EXTRA-ORDINARY INCOME — nothing extra-ordinary on this chart. */
    expect(shape(layout.blocks.otherIncome!)).toEqual([
      { 'sec:OTHER INCOMES': ['530-0000', { 'acc:700-0000': ['590-0000'] }] },
    ]);
  });

  test('the section files an account: a child whose parent sits elsewhere is a root of its own block', () => {
    /* 530-0000 hangs under 500-0000 on the chart, yet it is other income. */
    expect(JSON.stringify(layout.blocks.tradingIncome)).not.toContain('530-0000');
    expect(JSON.stringify(layout.blocks.otherIncome)).toContain('530-0000');
  });

  test('a single-section block has no section layer, and an unsectioned row takes its default shelf', () => {
    expect(shape(layout.blocks.costOfSales!)).toEqual(['601-0003', '615-0000']);
    expect(shape(layout.blocks.taxation!)).toEqual(['950-0000']);
  });

  test('an empty chart is an empty tree per block', () => {
    const empty = defaultLayout('pnl', []);
    expect(Object.keys(empty.blocks).sort()).toEqual(['costOfSales', 'expenses', 'otherIncome', 'taxation', 'tradingIncome']);
    expect(Object.values(empty.blocks).every((b) => b.length === 0)).toBe(true);
  });
});

describe('validateLayout — what a saved tree must be', () => {
  const good = (): Layout => ({
    version: 1,
    blocks: {
      tradingIncome: [], costOfSales: [], otherIncome: [], taxation: [],
      expenses: [
        { kind: 'category', id: 'cat:mkt', label: ' Marketing ', hiddenFor: [2, 1, 2], children: [{ kind: 'account', code: '900-A014' }] },
        { kind: 'account', code: '900-A001' },
      ],
    },
  });

  test('a good tree comes back normalised — names trimmed, ticks deduped and sorted', () => {
    const r = validateLayout('pnl', good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cat = r.layout.blocks.expenses![0] as { label: string; hiddenFor?: number[] };
    expect(cat.label).toBe('Marketing');
    expect(cat.hiddenFor).toEqual([1, 2]);
  });

  test('a missing block is an empty one; an unknown block is refused', () => {
    const r = validateLayout('pnl', { version: 1, blocks: { expenses: [] } });
    expect(r.ok && r.layout.blocks.taxation).toEqual([]);
    const bad = validateLayout('pnl', { version: 1, blocks: { expenses: [], ebitda: [] } });
    expect(bad).toEqual({ ok: false, reason: 'Unknown block: ebitda.' });
  });

  test.each([
    ['not an object', 'x', 'The layout must be an object.'],
    ['a wrong version', { version: 2, blocks: {} }, 'The layout version must be 1.'],
    ['no blocks', { version: 1 }, 'The layout needs its blocks.'],
  ])('refuses %s', (_what, raw, reason) => {
    expect(validateLayout('pnl', raw)).toEqual({ ok: false, reason });
  });

  test('a code placed twice, a category id used twice, a category with no name — each named in the refusal', () => {
    const twice = good();
    twice.blocks.costOfSales!.push({ kind: 'account', code: '900-A001' });
    expect(validateLayout('pnl', twice)).toEqual({ ok: false, reason: '900-A001 is placed twice.' });

    const sameId = good();
    sameId.blocks.taxation!.push({ kind: 'category', id: 'cat:mkt', label: 'Again', children: [] });
    expect(validateLayout('pnl', sameId)).toEqual({ ok: false, reason: 'Category id cat:mkt is used twice.' });

    const nameless = good();
    (nameless.blocks.expenses![0] as { label: string }).label = '   ';
    expect(validateLayout('pnl', nameless)).toEqual({ ok: false, reason: 'Category cat:mkt has no name.' });

    const oddId = good();
    (oddId.blocks.expenses![0] as { id: string }).id = 'has space';
    expect(validateLayout('pnl', oddId)).toMatchObject({ ok: false, reason: expect.stringContaining('needs an id') });
  });

  test('a tree deeper than eight levels is refused', () => {
    let items: LayoutItem[] = [{ kind: 'account', code: '900-A001' }];
    for (let d = 0; d < 9; d += 1) items = [{ kind: 'category', id: `c${d}`, label: `L${d}`, children: items }];
    const r = validateLayout('pnl', { version: 1, blocks: { expenses: items } });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('deeper than 8 levels') });
  });
});

describe('layOutBlock — the period on the tree', () => {
  const tree: LayoutItem[] = [
    {
      kind: 'category', id: 'acc:900-0000', label: 'Operating Expense', code: '900-0000',
      children: [
        { kind: 'account', code: '900-A001' },
        { kind: 'category', id: 'acc:900-A002', label: 'ADVERTISEMENT', code: '900-A002', children: [{ kind: 'account', code: '900-A014' }] },
      ],
    },
    { kind: 'account', code: '900-O001' },
    { kind: 'category', id: 'cat:empty', label: 'Nothing here', children: [{ kind: 'account', code: '900-Z001' }] },
  ];
  const lines = [
    { code: '900-A001', name: 'ACCOUNTING FEE', amountSen: 120_000 },
    { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', amountSen: -15_000 },   // reversed this period
    { code: '900-O001', name: 'OPERATIING EXPENSE', amountSen: 50_000 },
    { code: '900-N001', name: 'NEW SINCE THE SAVE', amountSen: 7_700 },
  ];
  const flat = (nodes: LaidNode[]): unknown[] =>
    nodes.map((n) => [n.kind, n.label, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);

  test('subtotals, % of the base on every line, an empty category gone, the unplaced under Unassigned', () => {
    const laid = layOutBlock(tree, lines, 2, 1_000_000);
    expect(flat(laid)).toEqual([
      ['category', 'Operating Expense', 105_000, 10.5, [
        ['account', '900-A001 — ACCOUNTING FEE', 120_000, 12],
        ['category', 'ADVERTISEMENT', -15_000, -1.5, [
          ['account', '900-A014 — ADVERTISEMENT - SHOWROOM', -15_000, -1.5],
        ]],
      ]],
      ['account', '900-O001 — OPERATIING EXPENSE', 50_000, 5],
      ['unassigned', 'Unassigned', 7_700, 0.8, [
        ['account', '900-N001 — NEW SINCE THE SAVE', 7_700, 0.8],
      ]],
    ]);
    /* The block's total is exactly the sum of what is printed. */
    expect(laid.reduce((s, n) => s + n.amountSen, 0)).toBe(lines.reduce((s, l) => s + l.amountSen, 0));
    expect(laidDepth(laid)).toBe(3);
  });

  test('a category this company unticked is skipped with its subtree; its figures go to Unassigned, not nowhere', () => {
    const ticked: LayoutItem[] = JSON.parse(JSON.stringify(tree));
    (ticked[0] as { hiddenFor?: number[] }).hiddenFor = [2];
    const forTwo = layOutBlock(ticked, lines, 2, null);
    expect(forTwo.map((n) => n.label)).toEqual(['900-O001 — OPERATIING EXPENSE', 'Unassigned']);
    expect(forTwo[1]!.children.map((n) => n.code)).toEqual(['900-A001', '900-A014', '900-N001']);
    expect(forTwo.reduce((s, n) => s + n.amountSen, 0)).toBe(162_700);
    /* The other company still sees it. */
    expect(layOutBlock(ticked, lines, 1, null)[0]!.label).toBe('Operating Expense');
  });

  test('a header that booked something itself prints first inside its own category', () => {
    const laid = layOutBlock(tree, [{ code: '900-0000', name: 'Operating Expense', amountSen: 1_000 }, ...lines], 1, null);
    expect(laid[0]!.children[0]).toMatchObject({ kind: 'account', code: '900-0000', amountSen: 1_000 });
    expect(laid[0]!.amountSen).toBe(106_000);
  });

  test('no base means no % — null, never a division by nothing', () => {
    expect(pctOf(5_000, null)).toBeNull();
    expect(pctOf(5_000, 0)).toBeNull();
    expect(pctOf(5_000, 30_000)).toBe(16.7);
    expect(pctOf(-1_500, 100_000)).toBe(-1.5);
    const laid = layOutBlock(tree, lines, 1, 0);
    expect(laid.every((n) => n.pct === null)).toBe(true);
  });

  test('nothing booked is nothing printed — and no Unassigned either', () => {
    expect(layOutBlock(tree, [], 1, 100)).toEqual([]);
    expect(laidDepth([])).toBe(0);
  });
});

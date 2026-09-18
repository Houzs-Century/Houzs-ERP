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
  REPORT_BLOCKS, defaultLayout, isCashFlowTyped, laidDepth, laidLineNode, layOutBlock, layOutCashFlow, pctOf, upgradeCashFlowLayout, validateLayout,
  type ChartAccount, type LaidLine, type LaidNode, type Layout, type LayoutCategory, type LayoutItem,
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
  items.map((it) => (it.kind === 'account' ? it.code : it.kind === 'subtotal' ? { subtotal: it.label } : { [it.id]: shape(it.children) }));

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

  /* The other three reports (docs/bugs/0912). */
  const BS_CHART: ChartAccount[] = [
    acc('200-0000', 'MOTOR VEHICLES', 'ASSET', null, 'FIXED ASSETS'),
    acc('310-0000', 'CASH AT BANK', 'ASSET', null, 'CURRENT ASSETS'),
    acc('310-0010', 'CASH AT BANK - MAYBANK', 'ASSET', '310-0000', 'CURRENT ASSETS'),
    acc('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', null, 'CURRENT LIABILITIES'),
    acc('460-0001', 'LOAN - MAYBANK', 'LIABILITY', null, 'LONG TERM LIABILITIES'),
    acc('100-0000', 'SHARE CAPITAL', 'EQUITY', null, 'CAPITAL'),
    acc('150-0000', 'RETAINED EARNINGS', 'EQUITY', null, 'RETAINED EARNING'),
    ...CHART,
  ];

  test('the balance sheet blocks by the section\'s TYPE, a section layer inside each', () => {
    const bs = defaultLayout('balance_sheet', BS_CHART);
    expect(Object.keys(bs.blocks)).toEqual(['assets', 'liabilities', 'equity']);
    expect(shape(bs.blocks.assets!)).toEqual([
      { 'sec:FIXED ASSETS': ['200-0000'] },
      { 'sec:CURRENT ASSETS': [{ 'acc:310-0000': ['310-0010'] }] },
    ]);
    expect(shape(bs.blocks.liabilities!)).toEqual([{ 'sec:CURRENT LIABILITIES': ['400-0000'] }, { 'sec:LONG TERM LIABILITIES': ['460-0001'] }]);
    expect(shape(bs.blocks.equity!)).toEqual([{ 'sec:CAPITAL': ['100-0000'] }, { 'sec:RETAINED EARNING': ['150-0000'] }]);
    /* No income or expense account anywhere on it. */
    expect(JSON.stringify(bs)).not.toMatch(/500-0000|900-A001/);
  });

  test('the performance layout has the P&L\'s other income and expenses blocks and nothing else', () => {
    const perf = defaultLayout('performance', CHART);
    expect(Object.keys(perf.blocks)).toEqual(['otherIncome', 'expenses']);
    expect(shape(perf.blocks.expenses!)).toEqual(shape(defaultLayout('pnl', CHART).blocks.expenses!));
  });

  test('cash flow: ONE block — RECEIPTS (In) over PAYMENTS (Out), each the whole chart with a section layer in the chart\'s order, every line directed', () => {
    const rp = defaultLayout('rp', BS_CHART);
    expect(Object.keys(rp.blocks)).toEqual(['accounts']);
    expect(REPORT_BLOCKS.rp[0]!.sections.length).toBe(16);
    const tops = rp.blocks.accounts! as LayoutCategory[];
    expect(tops.map((t) => [t.id, t.label, t.flow, t.totalLabel])).toEqual([['side:in', 'RECEIPTS', 'in', 'Total receipts'], ['side:out', 'PAYMENTS', 'out', 'Total payments']]);
    const sections = (side: 'in' | 'out') => (tops[side === 'in' ? 0 : 1]!.children).map((it) => (it.kind === 'category' ? it.id : it.kind));
    expect(sections('in')).toEqual([
      'in:sec:CAPITAL', 'in:sec:RETAINED EARNING', 'in:sec:FIXED ASSETS', 'in:sec:CURRENT ASSETS', 'in:sec:CURRENT LIABILITIES', 'in:sec:LONG TERM LIABILITIES',
      'in:sec:SALES', 'in:sec:SALES ADJUSTMENTS', 'in:sec:COST OF GOODS SOLD', 'in:sec:OTHER INCOMES', 'in:sec:EXPENSES', 'in:sec:TAXATION',
    ]);
    expect(sections('out').map((id) => String(id).replace(/^out:/, 'in:'))).toEqual(sections('in'));
    const flows = new Set<string>();
    const walk = (items: LayoutItem[]): void => { for (const it of items) { if (it.kind === 'account') flows.add(String(it.flow)); else if (it.kind === 'category') walk(it.children); } };
    walk(tops[0]!.children); expect([...flows]).toEqual(['in']);
    flows.clear(); walk(tops[1]!.children); expect([...flows]).toEqual(['out']);
  });

  test('a tree the chart built always validates — section names carry spaces and a slash', () => {
    const chart = [...BS_CHART, acc('180-0000', 'DIVIDEND', 'EQUITY', null, 'APPROPRIATION A/C')];
    for (const report of ['pnl', 'balance_sheet', 'performance', 'rp'] as const) {
      const r = validateLayout(report, defaultLayout(report, chart));
      expect(r.ok, report).toBe(true);
    }
    expect(JSON.stringify(defaultLayout('rp', chart))).toContain('sec:APPROPRIATION A/C');
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
    (oddId.blocks.expenses![0] as { id: string }).id = 'has|pipe';
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

  /* Rows that share a code, a label of the row's own, a figure per column
     (docs/bugs/0912 — Receipts & Payments by party, transfers, the
     Performance P&L's computed operating expense). */
  test('several rows under one code print where the code sits, each by its own key and label; cells sum up the tree', () => {
    const byParty: LaidLine[] = [
      { code: '900-A001', key: '900-A001:Ah Meng', name: 'ACCOUNTING FEE', label: 'Ah Meng · ACCOUNTING FEE', amountSen: 7_000, cells: { '310-0010': 7_000 } },
      { code: '900-A001', key: '900-A001:Bee', name: 'ACCOUNTING FEE', label: 'Bee · ACCOUNTING FEE', amountSen: 3_000, cells: { '320-0000': 3_000 } },
      { code: '900-O001', name: 'OPERATIING EXPENSE', label: 'Operating expense — 16.00% of sales', amountSen: 50_000, cells: { '310-0010': 50_000 } },
    ];
    const laid = layOutBlock(tree, byParty, 1, 100_000);
    const op = laid[0]!;
    expect(op.children.map((n) => [n.id, n.key, n.label, n.amountSen])).toEqual([
      ['acc:900-A001:Ah Meng', '900-A001:Ah Meng', 'Ah Meng · ACCOUNTING FEE', 7_000],
      ['acc:900-A001:Bee', '900-A001:Bee', 'Bee · ACCOUNTING FEE', 3_000],
    ]);
    expect(op.amountSen).toBe(10_000);
    expect(op.cells).toEqual({ '310-0010': 7_000, '320-0000': 3_000 });
    expect(laid[1]).toMatchObject({ kind: 'account', key: '900-O001', label: 'Operating expense — 16.00% of sales', amountSen: 50_000, pct: 50, cells: { '310-0010': 50_000 } });
    /* A tree with no cells on its lines carries none. */
    expect(layOutBlock(tree, lines, 1, null)[0]!.cells).toBeUndefined();
  });

  test('laidLineNode — a line as a leaf, keyed by its own key', () => {
    const n = laidLineNode({ code: 'ADV', key: 'ADV', name: 'Supplier advances (预付)', label: 'Supplier advances (预付)', amountSen: 30_000, cells: { '310-0010': 30_000 } }, 120_000);
    expect(n).toEqual({ kind: 'account', id: 'acc:ADV', label: 'Supplier advances (预付)', code: 'ADV', key: 'ADV', amountSen: 30_000, pct: 25, cells: { '310-0010': 30_000 }, children: [] });
    expect(laidLineNode({ code: '900-A001', name: 'ACCOUNTING FEE', amountSen: 1 }, null)).toMatchObject({ id: 'acc:900-A001', key: '900-A001', label: '900-A001 — ACCOUNTING FEE', pct: null });
  });
});

describe('the Cash Flow tree (owner 2026-09-18)', () => {
  const legacy = (): Layout => ({ version: 1, blocks: { accounts: [
    { kind: 'category', id: 'sec:CURRENT ASSETS', label: 'CURRENT ASSETS', hiddenFor: [1], children: [{ kind: 'account', code: '300-0000' }] },
    { kind: 'account', code: '900-A001' },
  ] } });

  test('a tree from before directions is read as RECEIPTS (In) over PAYMENTS (Out), ids prefixed, ticks kept; a typed tree is left alone', () => {
    expect(isCashFlowTyped(legacy().blocks.accounts)).toBe(false);
    const up = upgradeCashFlowLayout(legacy()) as Layout;
    expect(isCashFlowTyped(up.blocks.accounts)).toBe(true);
    const r = validateLayout('rp', legacy());
    expect(r.ok).toBe(true);
    const tops = (r as { layout: Layout }).layout.blocks.accounts as LayoutCategory[];
    expect(tops.map((t) => [t.id, t.label, t.flow, t.totalLabel])).toEqual([['side:in', 'RECEIPTS', 'in', 'Total receipts'], ['side:out', 'PAYMENTS', 'out', 'Total payments']]);
    expect(shape(tops[0]!.children)).toEqual([{ 'in:sec:CURRENT ASSETS': ['300-0000'] }, '900-A001']);
    expect(shape(tops[1]!.children)).toEqual([{ 'out:sec:CURRENT ASSETS': ['300-0000'] }, '900-A001']);
    expect((tops[0]!.children[0] as LayoutCategory).hiddenFor).toEqual([1]);
    expect((tops[1]!.children[1] as { flow?: string }).flow).toBe('out');
    expect(upgradeCashFlowLayout(up)).toBe(up);
  });

  test('the rules: every account inside an In or Out category, a top category with a side, a subtotal only at the top, each side of an account placed once', () => {
    const cf = (accounts: unknown[]): unknown => ({ version: 1, blocks: { accounts } });
    const typed = (...items: unknown[]) => cf([{ kind: 'category', id: 'side:in', label: 'Source of funds', flow: 'in', totalLabel: 'Total Cash In', children: items }]);
    const bad = (raw: unknown) => (validateLayout('rp', raw) as { ok: false; reason: string }).reason;
    /* Half-marked is not legacy: a typed side beside a bare account is refused, not wrapped. */
    expect(bad(cf([{ kind: 'category', id: 'side:in', label: 'In', flow: 'in', children: [] }, { kind: 'account', code: '300-0000' }]))).toBe('Cash Flow: 300-0000 must sit inside an In or Out category.');
    expect(bad(cf([{ kind: 'category', id: 'side:in', label: 'In', flow: 'in', children: [] }, { kind: 'category', id: 'c', label: 'No side', children: [] }]))).toBe('Cash Flow: No side must be In or Out.');
    expect(bad(typed({ kind: 'category', id: 'c', label: 'Deep', children: [{ kind: 'subtotal', id: 's', label: 'Net' }] }))).toBe('Category Deep: a subtotal line belongs to the Cash Flow layout, at the top level.');
    expect(bad(typed({ kind: 'account', code: '300-0000' }, { kind: 'account', code: '300-0000', flow: 'net' }))).toBe("300-0000's money in is placed twice.");
    expect(bad(typed({ kind: 'account', code: '300-0000', flow: 'out' }, { kind: 'account', code: '300-0000', flow: 'net' }))).toBe("300-0000's money out is placed twice.");
    expect(bad(cf([{ kind: 'subtotal', id: 's', label: '' }]))).toBe('Subtotal s has no name.');
    /* Good: the same account In and Out, a subtotal at the top, the category's own subtotal name; a sub-category's stray side is dropped. */
    const ok = validateLayout('rp', cf([
      { kind: 'category', id: 'side:in', label: 'Source of funds', flow: 'in', totalLabel: ' Total Cash In ', children: [
        { kind: 'account', code: '300-0000' }, { kind: 'account', code: '300-0000', flow: 'out' },
        { kind: 'category', id: 'sub', label: 'Sub', flow: 'out', children: [{ kind: 'account', code: '350-0010', flow: 'net' }] },
      ] },
      { kind: 'subtotal', id: 'sub:ops', label: 'Net operation surplus' },
      { kind: 'category', id: 'side:out', label: 'Expenses', flow: 'out', children: [{ kind: 'account', code: '900-A001' }] },
    ]));
    expect(ok.ok).toBe(true);
    const items = (ok as { layout: Layout }).layout.blocks.accounts!;
    expect(items.map((it) => it.kind)).toEqual(['category', 'subtotal', 'category']);
    const src = items[0] as LayoutCategory;
    expect(src.totalLabel).toBe('Total Cash In');
    expect(src.children.map((it) => (it.kind === 'account' ? it.flow : it.kind))).toEqual(['in', 'out', 'category']);
    expect((src.children[2] as LayoutCategory).flow).toBeUndefined();
    expect(((src.children[2] as LayoutCategory).children[0] as { flow?: string }).flow).toBe('net');
    expect(((items[2] as LayoutCategory).children[0] as { flow?: string }).flow).toBe('out');
    /* Directions belong to the Cash Flow alone. */
    expect((validateLayout('pnl', { version: 1, blocks: { expenses: [{ kind: 'subtotal', id: 's', label: 'x' }] } }) as { reason: string }).reason).toBe('Block expenses: a subtotal line belongs to the Cash Flow layout, at the top level.');
  });

  test('laid out: signs by side, a Net line, a running subtotal, an unticked category to Unassigned, % of the side; in − out = receipts − payments', () => {
    const tree: LayoutItem[] = [
      { kind: 'category', id: 'src', label: 'Source of funds', flow: 'in', totalLabel: 'Total Cash In', children: [
        { kind: 'category', id: 'dep', label: 'Deposit received', children: [
          { kind: 'account', code: '300-0000', flow: 'in' }, { kind: 'account', code: '300-0000', flow: 'out' },
        ] },
      ] },
      { kind: 'category', id: 'exp', label: 'Expenses', flow: 'out', totalLabel: 'Total Cash Out', children: [{ kind: 'account', code: '900-A001', flow: 'out' }] },
      { kind: 'subtotal', id: 'ops', label: 'Net operation surplus / (deficit)' },
      { kind: 'category', id: 'fund', label: 'Loan From / (Repayment)', flow: 'in', totalLabel: 'Net Loan', children: [{ kind: 'account', code: '350-0010', flow: 'net' }] },
      { kind: 'category', id: 'hid', label: 'Hidden here', flow: 'out', hiddenFor: [2], children: [{ kind: 'account', code: '905-0000', flow: 'out' }] },
    ];
    const receipts: LaidLine[] = [
      { code: '300-0000', name: 'TRADE DEBTORS', amountSen: 90_000, cells: { '310-0010': 90_000 } },
      { code: '350-0010', name: 'HOUZS VENTURE', amountSen: 60_000, cells: { '310-0010': 60_000 } },
      { code: '530-0000', name: 'INTEREST INCOME', amountSen: 5_000, cells: { '310-0010': 5_000 } },
    ];
    const payments: LaidLine[] = [
      { code: '300-0000', name: 'TRADE DEBTORS', amountSen: 1_000, cells: { '310-0010': 1_000 } },
      { code: '900-A001', name: 'ACCOUNTING FEE', amountSen: 45_000, cells: { '310-0010': 45_000 } },
      { code: '350-0010', name: 'HOUZS VENTURE', amountSen: 20_000, cells: { '320-0000': 20_000 } },
      { code: '905-0000', name: 'TRAVELLING', amountSen: 700, cells: { '320-0000': 700 } },
      { code: 'ADV', key: 'ADV', name: 'Supplier advances (预付)', label: 'Supplier advances (预付)', amountSen: 3_000, cells: { '310-0010': 3_000 } },
    ];
    const laid = layOutCashFlow(tree, receipts, payments, 2);
    const flat = (nodes: LaidNode[]): unknown[] => nodes.map((n) => [n.kind, n.label, n.flow ?? null, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);
    /* Money in 155,000, money out 69,700; the tree reads in 134,000 − out 48,700 — the same 85,300. */
    expect(laid.inSen).toBe(134_000);
    expect(laid.outSen).toBe(48_700);
    expect(laid.inSen - laid.outSen).toBe(155_000 - 69_700);
    expect(flat(laid.nodes)).toEqual([
      ['category', 'Source of funds', 'in', 89_000, 66.4, [
        ['category', 'Deposit received', null, 89_000, 66.4, [
          ['account', '300-0000 — TRADE DEBTORS', 'in', 90_000, 67.2],
          ['account', '300-0000 — TRADE DEBTORS', 'out', -1_000, -0.7],
        ]],
      ]],
      ['category', 'Expenses', 'out', 45_000, 92.4, [['account', '900-A001 — ACCOUNTING FEE', 'out', 45_000, 92.4]]],
      ['subtotal', 'Net operation surplus / (deficit)', null, 44_000, null],
      ['category', 'Loan From / (Repayment)', 'in', 40_000, 29.9, [['account', '350-0010 — HOUZS VENTURE', 'net', 40_000, 29.9]]],
      ['unassigned', 'Unassigned receipts', 'in', 5_000, 3.7, [['account', '530-0000 — INTEREST INCOME', 'in', 5_000, 3.7]]],
      ['unassigned', 'Unassigned payments', 'out', 3_700, 7.6, [
        ['account', '905-0000 — TRAVELLING', 'out', 700, 1.4],
        ['account', 'Supplier advances (预付)', 'out', 3_000, 6.2],
      ]],
    ]);
    expect(laid.nodes[0]).toMatchObject({ totalLabel: 'Total Cash In', cells: { '310-0010': 89_000 } });
    expect(laid.nodes[2]!.cells).toEqual({ '310-0010': 44_000 });
    expect(laid.nodes[3]!.children[0]!.cells).toEqual({ '310-0010': 60_000, '320-0000': -20_000 });
    /* One account, two lines, two ids — the monthly merge keys by id. */
    const dep = laid.nodes[0]!.children[0]!;
    expect(dep.children.map((n) => n.id)).toEqual(['in:acc:300-0000', 'out:acc:300-0000']);
    expect(laid.nodes[3]!.children[0]!.id).toBe('net:acc:350-0010');
  });
});

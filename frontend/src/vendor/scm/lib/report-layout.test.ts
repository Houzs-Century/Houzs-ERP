/* The editor's operations on a report layout (owner 2026-09-14, docs/bugs/0911).
   Every one returns a new tree and leaves the given one alone; an account is
   never lost by moving, deleting or unticking the shelf it sits on. */

import { describe, expect, test } from 'vitest';
import {
  accountKey, addCategory, addSubtotal, blockOfKey, categoryIds, flattenLaid, fmtPct, foldsChildren, folderOpen, itemKey, laidDepth, leafKeys, linesVisible, moveWithinSiblings, newCategoryId, newSubtotalId, pctOf, placeItem,
  removeCategory, removeSubtotal, renameCategory, setAccountFlow, setCategoryFlow, setCategoryTick, setTotalLabel, unplaceAccount, unplacedAccounts,
  type LaidNode, type Layout, type LayoutAccountRow, type LayoutBlockDef, type LayoutItem,
} from './report-layout';

const layout = (): Layout => ({
  version: 1,
  blocks: {
    tradingIncome: [{ kind: 'account', code: '501-0000' }],
    expenses: [
      {
        kind: 'category', id: 'acc:900-0000', label: 'Operating Expense', code: '900-0000',
        children: [
          { kind: 'account', code: '900-A001' },
          { kind: 'category', id: 'acc:900-A002', label: 'ADVERTISEMENT', code: '900-A002', children: [{ kind: 'account', code: '900-A014' }] },
        ],
      },
      { kind: 'account', code: '900-O001' },
    ],
  },
});

const shape = (items: LayoutItem[]): unknown[] =>
  items.map((it) => (it.kind === 'account' ? it.code : it.kind === 'subtotal' ? { subtotal: it.id } : { [it.id]: shape(it.children) }));

describe('moving among siblings', () => {
  test('down swaps with the next; the ends stay put; the given tree is untouched', () => {
    const before = layout();
    const snapshot = JSON.stringify(before);
    const down = moveWithinSiblings(before, 'expenses', accountKey('900-A001'), 1);
    expect(shape(down.blocks.expenses!)).toEqual([{ 'acc:900-0000': [{ 'acc:900-A002': ['900-A014'] }, '900-A001'] }, '900-O001']);
    expect(JSON.stringify(before)).toBe(snapshot);
    /* Already first: nothing moves, the same object comes back. */
    expect(moveWithinSiblings(before, 'expenses', 'acc:900-0000', -1)).toBe(before);
    expect(moveWithinSiblings(before, 'expenses', accountKey('nope'), 1)).toBe(before);
  });

  test('a top-level item moves among the block\'s roots', () => {
    const up = moveWithinSiblings(layout(), 'expenses', accountKey('900-O001'), -1);
    expect(shape(up.blocks.expenses!)).toEqual(['900-O001', { 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }] }]);
  });
});

describe('categories', () => {
  test('rename, add at the top or under a parent, delete promotes what it held', () => {
    let l = renameCategory(layout(), 'acc:900-A002', 'Marketing');
    expect((l.blocks.expenses![0] as { children: Array<{ label?: string }> }).children[1]!.label).toBe('Marketing');
    l = addCategory(l, 'expenses', null, 'Staff', 'cat:staff');
    l = addCategory(l, 'expenses', 'cat:staff', 'Salaries', 'cat:sal');
    expect(shape(l.blocks.expenses!)).toEqual([
      { 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }] }, '900-O001', { 'cat:staff': [{ 'cat:sal': [] }] },
    ]);
    /* Adding under an account, or a missing parent, changes nothing. */
    expect(addCategory(l, 'expenses', accountKey('900-O001'), 'X', 'cat:x')).toBe(l);
    l = removeCategory(l, 'acc:900-A002');
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A001', '900-A014'] }, '900-O001', { 'cat:staff': [{ 'cat:sal': [] }] }]);
    l = removeCategory(l, 'acc:900-0000');
    expect(shape(l.blocks.expenses!)).toEqual(['900-A001', '900-A014', '900-O001', { 'cat:staff': [{ 'cat:sal': [] }] }]);
  });

  test('a tick is per company: untick adds the id, tick removes it, none left means the field goes', () => {
    let l = setCategoryTick(layout(), 'acc:900-0000', 2, false);
    const cat = () => l.blocks.expenses![0] as { hiddenFor?: number[] };
    expect(cat().hiddenFor).toEqual([2]);
    l = setCategoryTick(l, 'acc:900-0000', 1, false);
    expect(cat().hiddenFor).toEqual([1, 2]);
    l = setCategoryTick(l, 'acc:900-0000', 2, true);
    expect(cat().hiddenFor).toEqual([1]);
    l = setCategoryTick(l, 'acc:900-0000', 1, true);
    expect(cat().hiddenFor).toBeUndefined();
  });
});

describe('placing an item', () => {
  test('into a category appends; before an item inserts above it; end goes last at the top', () => {
    const a014: LayoutItem = { kind: 'account', code: '900-A014' };
    let l = placeItem(layout(), 'expenses', a014, { kind: 'before', key: accountKey('900-A001') });
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A014', '900-A001', { 'acc:900-A002': [] }] }, '900-O001']);
    l = placeItem(l, 'expenses', { kind: 'account', code: '900-O001' }, { kind: 'into', categoryId: 'acc:900-A002' });
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A014', '900-A001', { 'acc:900-A002': ['900-O001'] }] }]);
    l = placeItem(l, 'expenses', { kind: 'account', code: '900-A001' }, { kind: 'end' });
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A014', { 'acc:900-A002': ['900-O001'] }] }, '900-A001']);
  });

  test('an account from Unassigned — not in the tree yet — is added where it is dropped', () => {
    const l = placeItem(layout(), 'expenses', { kind: 'account', code: '900-N001' }, { kind: 'into', categoryId: 'acc:900-0000' });
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }, '900-N001'] }, '900-O001']);
  });

  test('a category never goes into itself or under its own children', () => {
    const before = layout();
    const op = before.blocks.expenses![0]!;
    expect(placeItem(before, 'expenses', op, { kind: 'into', categoryId: 'acc:900-0000' })).toBe(before);
    expect(placeItem(before, 'expenses', op, { kind: 'into', categoryId: 'acc:900-A002' })).toBe(before);
    expect(placeItem(before, 'expenses', op, { kind: 'before', key: accountKey('900-A014') })).toBe(before);
    /* Sideways is fine: the whole subtree travels. */
    const moved = placeItem(before, 'expenses', op, { kind: 'end' });
    expect(shape(moved.blocks.expenses!)).toEqual(['900-O001', { 'acc:900-0000': ['900-A001', { 'acc:900-A002': ['900-A014'] }] }]);
  });

  test('unplacing an account takes the leaf out; a category or a stranger is left alone', () => {
    const l = unplaceAccount(layout(), 'expenses', '900-A014');
    expect(shape(l.blocks.expenses!)).toEqual([{ 'acc:900-0000': ['900-A001', { 'acc:900-A002': [] }] }, '900-O001']);
    const before = layout();
    expect(unplaceAccount(before, 'expenses', '900-0000')).toBe(before);
  });

  test('blockOfKey finds the block an item sits in', () => {
    expect(blockOfKey(layout(), accountKey('900-A014'))).toBe('expenses');
    expect(blockOfKey(layout(), accountKey('501-0000'))).toBe('tradingIncome');
    expect(blockOfKey(layout(), 'cat:none')).toBeNull();
  });
});

describe('what the tree does not place', () => {
  const row = (code: string, name: string, section: string | null, parentCode: string | null = null): LayoutAccountRow =>
    ({ code, name, type: 'EXPENSE', parentCode, section, perCompany: { 1: { active: true } } });
  const ACCOUNTS = [
    row('900-0000', 'Operating Expense', 'EXPENSES'),
    row('900-A001', 'ACCOUNTING FEE', 'EXPENSES', '900-0000'),
    row('900-A014', 'ADVERTISEMENT - SHOWROOM', 'EXPENSES', '900-A002'),
    row('900-N001', 'NEW SINCE THE SAVE', 'EXPENSES', '900-0000'),
    row('900-Z001', 'ZEBRA', 'EXPENSES'),
    row('950-0000', 'TAXATION', 'TAXATION'),
    row('999-0000', 'NOWHERE', null),
  ];
  const EXPENSES = { key: 'expenses', title: 'Expenses', sections: ['EXPENSES'] };

  test('lists the block\'s accounts the tree lacks — a category\'s header counts as placed, other sections stay out', () => {
    expect(unplacedAccounts(layout(), EXPENSES, ACCOUNTS).map((a) => a.code)).toEqual(['900-N001', '900-Z001']);
    const gone = removeCategory(layout(), 'acc:900-0000');
    expect(unplacedAccounts(gone, EXPENSES, ACCOUNTS).map((a) => a.code)).toEqual(['900-0000', '900-N001', '900-Z001']);
  });
});

describe('figures and ids', () => {
  test('pct and its print', () => {
    expect(pctOf(1_500, 100_000)).toBe(1.5);
    expect(pctOf(1, 3)).toBe(33.3);
    expect(pctOf(5, 0)).toBeNull();
    expect(pctOf(5, null)).toBeNull();
    expect(fmtPct(10.5)).toBe('10.5%');
    expect(fmtPct(-1.5)).toBe('-1.5%');
    expect(fmtPct(100)).toBe('100.0%');
    expect(fmtPct(null)).toBe('—');
  });

  test('laidDepth counts the levels a laid-out block goes down', () => {
    const acc = (id: string): LaidNode => ({ kind: 'account', id, label: id, amountSen: 1, pct: null, children: [] });
    const cat = (id: string, children: LaidNode[]): LaidNode => ({ kind: 'category', id, label: id, amountSen: 1, pct: null, children });
    expect(laidDepth([])).toBe(0);
    expect(laidDepth([acc('a')])).toBe(1);
    expect(laidDepth([cat('c', [acc('a'), cat('d', [acc('b')])]), acc('e')])).toBe(3);
  });

  test('leafKeys gathers every row under a node; flattenLaid lists the tree with depths (docs/bugs/0912)', () => {
    const acc = (key: string): LaidNode => ({ kind: 'account', id: `acc:${key}`, key, label: key, amountSen: 1, pct: null, children: [] });
    const cat = (id: string, children: LaidNode[]): LaidNode => ({ kind: 'category', id, label: id, amountSen: 1, pct: null, children });
    const tree = [cat('c', [acc('a'), cat('d', [acc('b'), acc('x:y')])]), acc('e')];
    expect(leafKeys(tree[0]!)).toEqual(['a', 'b', 'x:y']);
    expect(leafKeys(tree[1]!)).toEqual(['e']);
    expect(flattenLaid(tree).map(({ node, depth }) => [node.id, depth])).toEqual([['c', 1], ['acc:a', 2], ['d', 2], ['acc:b', 3], ['acc:x:y', 3], ['acc:e', 1]]);
  });

  test('categoryIds lists every category of a layout, every block, every depth', () => {
    expect(categoryIds(layout())).toEqual(['acc:900-0000', 'acc:900-A002']);
    expect(categoryIds(addCategory(layout(), 'tradingIncome', null, 'Sales', 'cat:s'))).toEqual(['cat:s', 'acc:900-0000', 'acc:900-A002']);
  });

  test('a new category id never looks like a chart code and is unique per call', () => {
    const id = newCategoryId(1_700_000_000_000, 5);
    expect(id).toMatch(/^cat:[0-9a-z]+$/);
    expect(id).not.toMatch(/^\d{3}-/);
    expect(newCategoryId(1_700_000_000_000, 5)).toBe(id);
    expect(newCategoryId(1_700_000_000_001, 5)).not.toBe(id);
  });
});

/* Folding a flattened tree: the level opens categories to a depth; a person
   opens or closes any one of them past that. */
describe('linesVisible', () => {
  const lines = [
    { id: 'blk', depth: 0 },
    { id: 'opex', depth: 1 },
    { id: 'advert', depth: 2 },
    { id: 'fb', depth: 3 },
    { id: 'rent', depth: 2 },
    { id: 'total', depth: 0 },
  ];
  const ids = (level: number | 'all', open: Record<string, boolean> = {}) => linesVisible(lines, level, open).map((l) => l.id);

  test('folders are the lines with a deeper line under them', () => {
    expect(lines.map((_, i) => foldsChildren(lines, i))).toEqual([true, true, true, false, false, false]);
  });

  test('All shows everything; L1 keeps the categories folded; L2 opens one more', () => {
    expect(ids('all')).toEqual(['blk', 'opex', 'advert', 'fb', 'rent', 'total']);
    expect(ids(1)).toEqual(['blk', 'opex', 'total']);
    expect(ids(2)).toEqual(['blk', 'opex', 'advert', 'rent', 'total']);
  });

  test('a person opens a folder the level closed, or closes one it opened; a closed parent hides the lot', () => {
    expect(ids(1, { opex: true })).toEqual(['blk', 'opex', 'advert', 'rent', 'total']);
    expect(ids(1, { opex: true, advert: true })).toEqual(['blk', 'opex', 'advert', 'fb', 'rent', 'total']);
    expect(ids('all', { advert: false })).toEqual(['blk', 'opex', 'advert', 'rent', 'total']);
    expect(ids('all', { opex: false, advert: true })).toEqual(['blk', 'opex', 'total']);
    expect(folderOpen({ id: 'opex', depth: 1 }, 1, {})).toBe(false);
    expect(folderOpen({ id: 'opex', depth: 1 }, 2, {})).toBe(true);
    expect(folderOpen({ id: 'opex', depth: 1 }, 1, { opex: true })).toBe(true);
  });
});

/* ── the Cash Flow tree (owner 2026-09-18) ───────────────────────────────── */

const cashFlow = (): Layout => ({
  version: 1,
  blocks: {
    accounts: [
      { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', children: [
        { kind: 'category', id: 'in:sec:CA', label: 'CURRENT ASSETS', children: [{ kind: 'account', code: '300-0000', flow: 'in' }, { kind: 'account', code: '320-0000', flow: 'in' }] },
      ] },
      { kind: 'category', id: 'side:out', label: 'PAYMENTS', flow: 'out', totalLabel: 'Total payments', children: [
        { kind: 'account', code: '300-0000', flow: 'out' },
        { kind: 'category', id: 'out:acc:601-0000', label: 'PURCHASES', code: '601-0000', children: [{ kind: 'account', code: '601-0003', flow: 'out' }] },
      ] },
    ],
  },
});
const cfBlock: LayoutBlockDef = { key: 'accounts', title: 'Accounts', sections: ['CURRENT ASSETS', 'COST OF GOODS SOLD', 'EXPENSES'] };
const cfAccounts: LayoutAccountRow[] = [
  { code: '300-0000', name: 'AR', type: 'ASSET', parentCode: null, section: 'CURRENT ASSETS', perCompany: {} },
  { code: '320-0000', name: 'CASH', type: 'ASSET', parentCode: null, section: 'CURRENT ASSETS', perCompany: {} },
  { code: '601-0000', name: 'PURCHASES', type: 'EXPENSE', parentCode: null, section: 'COST OF GOODS SOLD', perCompany: {} },
  { code: '601-0003', name: 'SOFA', type: 'EXPENSE', parentCode: '601-0000', section: 'COST OF GOODS SOLD', perCompany: {} },
  { code: '910-0000', name: 'UTILITIES', type: 'EXPENSE', parentCode: null, section: 'EXPENSES', perCompany: {} },
];
const codesOf = (rows: LayoutAccountRow[]): string[] => rows.map((a) => a.code);

describe('the Cash Flow tree', () => {
  test('an account line is keyed by its direction too — one account, two lines', () => {
    expect(accountKey('300-0000', 'in')).toBe('a:in:300-0000');
    expect(itemKey({ kind: 'account', code: '300-0000', flow: 'out' })).toBe('a:out:300-0000');
    expect(itemKey({ kind: 'subtotal', id: 'sub:1', label: 'Net' })).toBe('sub:1');
    const l = unplaceAccount(cashFlow(), 'accounts', '300-0000', 'out');
    expect(shape(l.blocks.accounts!)).toEqual([
      { 'side:in': [{ 'in:sec:CA': ['300-0000', '320-0000'] }] },
      { 'side:out': [{ 'out:acc:601-0000': ['601-0003'] }] },
    ]);
  });

  test('a top category takes a side; one deeper down follows its parent; the subtotal name is set or cleared', () => {
    const before = cashFlow();
    let l = setCategoryFlow(before, 'side:out', 'in');
    expect((l.blocks.accounts![1] as { flow?: string }).flow).toBe('in');
    expect(setCategoryFlow(before, 'in:sec:CA', 'out')).toBe(before);
    l = setTotalLabel(l, 'side:out', 'Net Loan');
    expect((l.blocks.accounts![1] as { totalLabel?: string }).totalLabel).toBe('Net Loan');
    l = setTotalLabel(l, 'side:out', '   ');
    expect('totalLabel' in (l.blocks.accounts![1] as object)).toBe(false);
    expect(setTotalLabel(before, 'a:in:300-0000', 'x')).toBe(before);
  });

  test('a line turns Net, its key follows; a subtotal joins the top level, moves there, never into a category, and goes', () => {
    let l = setAccountFlow(cashFlow(), 'accounts', 'a:out:300-0000', 'net');
    const out = l.blocks.accounts![1] as { children: LayoutItem[] };
    expect(out.children[0]).toEqual({ kind: 'account', code: '300-0000', flow: 'net' });
    expect(itemKey(out.children[0]!)).toBe('a:net:300-0000');
    expect(setAccountFlow(l, 'accounts', 'side:in', 'in')).toBe(l);
    l = addSubtotal(l, 'accounts', 'Net operation surplus / (deficit)', 'sub:ops');
    expect(l.blocks.accounts![2]).toEqual({ kind: 'subtotal', id: 'sub:ops', label: 'Net operation surplus / (deficit)' });
    const sub = l.blocks.accounts![2]!;
    /* Between the sides: fine. Into a category, or above a nested line: refused. */
    const moved = placeItem(l, 'accounts', sub, { kind: 'before', key: 'side:out' });
    expect(shape(moved.blocks.accounts!).map((x) => Object.keys(x as object)[0])).toEqual(['side:in', 'subtotal', 'side:out']);
    expect(placeItem(l, 'accounts', sub, { kind: 'into', categoryId: 'side:in' })).toBe(l);
    expect(placeItem(l, 'accounts', sub, { kind: 'before', key: 'a:in:300-0000' })).toBe(l);
    l = renameCategory(l, 'sub:ops', 'Cash Surplus');
    expect((l.blocks.accounts![2] as { label: string }).label).toBe('Cash Surplus');
    l = removeSubtotal(l, 'sub:ops');
    expect(l.blocks.accounts).toHaveLength(2);
    expect(removeSubtotal(l, 'sub:nope')).toBe(l);
    expect(newSubtotalId(1000, 5)).toMatch(/^sub:/);
  });

  test('the unplaced are asked for per side: a line reads its own side, Net reads both, a header account its top side', () => {
    const l = cashFlow();
    expect(codesOf(unplacedAccounts(l, cfBlock, cfAccounts, 'in'))).toEqual(['601-0000', '601-0003', '910-0000']);
    expect(codesOf(unplacedAccounts(l, cfBlock, cfAccounts, 'out'))).toEqual(['320-0000', '910-0000']);
    const net = setAccountFlow(unplaceAccount(l, 'accounts', '300-0000', 'in'), 'accounts', 'a:out:300-0000', 'net');
    expect(codesOf(unplacedAccounts(net, cfBlock, cfAccounts, 'in'))).toEqual(['601-0000', '601-0003', '910-0000']);
    /* Without a side, the old reading: placed anywhere counts. */
    expect(codesOf(unplacedAccounts(l, cfBlock, cfAccounts))).toEqual(['910-0000']);
  });
});

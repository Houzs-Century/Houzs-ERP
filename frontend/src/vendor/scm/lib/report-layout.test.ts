/* The editor's operations on a report layout (owner 2026-09-14, docs/bugs/0911).
   Every one returns a new tree and leaves the given one alone; an account is
   never lost by moving, deleting or unticking the shelf it sits on. */

import { describe, expect, test } from 'vitest';
import {
  accountKey, addCategory, blockOfKey, categoryIds, flattenLaid, fmtPct, foldsChildren, folderOpen, laidDepth, leafKeys, linesVisible, moveWithinSiblings, newCategoryId, pctOf, placeItem,
  removeCategory, renameCategory, setCategoryTick, unplaceAccount, unplacedAccounts,
  type LaidNode, type Layout, type LayoutAccountRow, type LayoutItem,
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

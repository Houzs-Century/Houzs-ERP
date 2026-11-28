/* Owner 2026-11-05 (subtotal 可以放在下面吗？现在都是在 title 那行不习惯): an open
   group's figures print on a Total line after its rows, the title bare; a folded
   group keeps them on its title; top-level lines are left alone. */
import { describe, expect, it } from 'vitest';
import { linesVisible, totalsBelow, type TotalsBelowLine } from './report-layout';

const L = (id: string, kind: string, depth: number, sen: number): TotalsBelowLine => ({ id, label: id, kind, depth, cells: { total: { amountSen: sen } } });
const all = [
  L('blk', 'block', 0, 0),
  L('warehouse', 'category', 1, 5000),
  L('rental', 'category', 2, 2000),
  L('r1', 'row', 3, 1200),
  L('r2', 'row', 3, 800),
  L('utilities', 'category', 2, 3000),
  L('u1', 'row', 3, 2000),
  L('u2', 'row', 3, 1000),
  L('tot:blk', 'total', 0, 5000),
];
const view = (level: number | 'all', open: Record<string, boolean> = {}) =>
  totalsBelow(linesVisible(all, level, open), all, level, open).map((l) => [l.id, l.bare ? 'bare' : l.kind, l.depth]);

describe('totalsBelow', () => {
  it('every open group closes with its own Total line, its title bare, at its own depth (L5 and deeper the same way)', () => {
    expect(view('all')).toEqual([
      ['blk', 'block', 0],
      ['warehouse', 'bare', 1],
      ['rental', 'bare', 2], ['r1', 'row', 3], ['r2', 'row', 3], ['sub:rental', 'total', 2],
      ['utilities', 'bare', 2], ['u1', 'row', 3], ['u2', 'row', 3], ['sub:utilities', 'total', 2],
      ['sub:warehouse', 'total', 1],
      ['tot:blk', 'total', 0],
    ]);
  });

  it('a folded group keeps its figures on the title and has no Total line', () => {
    expect(view('all', { rental: false })).toEqual([
      ['blk', 'block', 0],
      ['warehouse', 'bare', 1],
      ['rental', 'category', 2],
      ['utilities', 'bare', 2], ['u1', 'row', 3], ['u2', 'row', 3], ['sub:utilities', 'total', 2],
      ['sub:warehouse', 'total', 1],
      ['tot:blk', 'total', 0],
    ]);
  });

  it('the Total line carries the group’s figures and names it', () => {
    const out = totalsBelow(linesVisible(all, 'all', {}), all, 'all', {});
    expect(out.find((l) => l.id === 'sub:rental')).toMatchObject({ label: 'Total rental', cells: { total: { amountSen: 2000 } }, totalOf: 'rental' });
  });

  /* Owner 2026-11-27 (看了很乱): Total PURCHASES and Total COST OF FUNDS printed the same figures. */
  describe('no Total that repeats the one line under its group', () => {
    const cash = [
      L('blk', 'block', 0, 0),
      L('cost', 'category', 1, 900),
      L('purchases', 'category', 2, 900),
      L('p1', 'row', 3, 600),
      L('p2', 'row', 3, 300),
      L('exh', 'category', 1, 500),
      L('e1', 'row', 2, 400),
      L('commission', 'category', 2, 100),
      L('c1', 'row', 3, 100),
      L('radius', 'category', 1, 250),
      L('x1', 'row', 2, 200),
    ];
    const cashView = (open: Record<string, boolean> = {}) =>
      totalsBelow(linesVisible(cash, 'all', open), cash, 'all', open).map((l) => [l.id, l.bare ? 'bare' : l.kind]);

    it('a group whose only line is an account, or a group, of the same figures closes without a Total', () => {
      expect(cashView()).toEqual([
        ['blk', 'block'],
        ['cost', 'bare'], ['purchases', 'bare'], ['p1', 'row'], ['p2', 'row'], ['sub:purchases', 'total'],
        ['exh', 'bare'], ['e1', 'row'], ['commission', 'bare'], ['c1', 'row'], ['sub:exh', 'total'],
        ['radius', 'bare'], ['x1', 'row'], ['sub:radius', 'total'],
      ]);
    });

    it('a folded group as the only line: the outer group has no Total either', () => {
      expect(cashView({ purchases: false }).slice(0, 3)).toEqual([['blk', 'block'], ['cost', 'bare'], ['purchases', 'category']]);
      expect(cashView({ purchases: false })[3]).toEqual(['exh', 'bare']);
    });

    it('one line whose figures differ from its group (money booked on the group itself) keeps the Total', () => {
      expect(cashView().filter(([id]) => id === 'sub:radius')).toHaveLength(1);
    });
  });
});

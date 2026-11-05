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
  L('u1', 'row', 3, 3000),
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
      ['utilities', 'bare', 2], ['u1', 'row', 3], ['sub:utilities', 'total', 2],
      ['sub:warehouse', 'total', 1],
      ['tot:blk', 'total', 0],
    ]);
  });

  it('a folded group keeps its figures on the title and has no Total line', () => {
    expect(view('all', { rental: false })).toEqual([
      ['blk', 'block', 0],
      ['warehouse', 'bare', 1],
      ['rental', 'category', 2],
      ['utilities', 'bare', 2], ['u1', 'row', 3], ['sub:utilities', 'total', 2],
      ['sub:warehouse', 'total', 1],
      ['tot:blk', 'total', 0],
    ]);
  });

  it('the Total line carries the group’s figures and names it', () => {
    const out = totalsBelow(linesVisible(all, 'all', {}), all, 'all', {});
    expect(out.find((l) => l.id === 'sub:rental')).toMatchObject({ label: 'Total rental', cells: { total: { amountSen: 2000 } }, totalOf: 'rental' });
  });
});

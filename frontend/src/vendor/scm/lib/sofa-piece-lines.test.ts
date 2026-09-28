// One sofa module = one SO line (owner 2026-09-28, HC-SO-2609-221: two CNRs of
// a U were booked as one "CNR x2" line and the PO layout lost a corner).
import { describe, expect, it } from 'vitest';
import {
  dropOneMultiPick, expandSofaPieceItems, multiPickCount, pieceShareSen, splitSofaPieceLines, tapMultiPick,
} from './sofa-piece-lines';

const id = (x: { id: string }) => x.id;

describe('tapMultiPick', () => {
  it('a sofa piece tapped twice is picked twice, in tap order', () => {
    let picked: Array<{ id: string }> = [];
    for (const p of ['1A', 'CNR', '2NA', 'CNR']) picked = tapMultiPick(picked, { id: p }, id, true);
    expect(picked.map(id)).toEqual(['1A', 'CNR', '2NA', 'CNR']);
    expect(multiPickCount(picked, 'CNR', id)).toBe(2);
    expect(dropOneMultiPick(picked, 'CNR', id).map(id)).toEqual(['1A', 'CNR', '2NA']);
  });

  it('any other row still toggles', () => {
    const once = tapMultiPick([], { id: 'BED' }, id, false);
    expect(tapMultiPick(once, { id: 'BED' }, id, false)).toEqual([]);
  });
});

describe('splitting a sofa line', () => {
  it('shares the discount so the pieces sum to the line', () => {
    const shares = [0, 1, 2].map((i) => pieceShareSen(1000, i, 3));
    expect(shares).toEqual([334, 333, 333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('puts the pieces where the line was and leaves other lines alone', () => {
    const lines = [{ k: 'a', qty: 1 }, { k: 'cnr', qty: 2 }, { k: 'b', qty: 3 }];
    const out = splitSofaPieceLines(lines, {
      shouldSplit: (l) => l.k !== 'b',
      qtyOf: (l) => l.qty,
      asPiece: (l, i) => ({ k: `${l.k}${i}`, qty: 1 }),
    });
    expect(out).toEqual([{ k: 'a', qty: 1 }, { k: 'cnr0', qty: 1 }, { k: 'cnr1', qty: 1 }, { k: 'b', qty: 3 }]);
  });

  it('returns null when nothing splits (a fractional qty is not pieces)', () => {
    expect(splitSofaPieceLines([{ qty: 1 }, { qty: 1.5 }], { shouldSplit: () => true, qtyOf: (l) => l.qty, asPiece: (l) => l })).toBeNull();
  });

  it('create payloads: a sofa x2 goes out as two lines, a mattress x2 stays one', () => {
    const out = expandSofaPieceItems([
      { itemCode: '8030-CNR', itemGroup: 'sofa', qty: 2, discountSen: 101 },
      { itemCode: 'MAT-K', itemGroup: 'mattress', qty: 2, discountSen: 0 },
    ]);
    expect(out.map((it) => [it.itemCode, it.qty, it.discountSen])).toEqual([
      ['8030-CNR', 1, 51], ['8030-CNR', 1, 50], ['MAT-K', 2, 0],
    ]);
  });
});

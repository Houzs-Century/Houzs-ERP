import { describe, expect, it } from 'vitest';
import { splitMobileSofaPieces } from './mobile-sofa-pieces';

const line = (over: Partial<{ key: string; itemId: string; itemGroup: string; qty: string }>) => ({
  key: 'k', addIdempotencyKey: 'idem', itemId: '', itemGroup: 'sofa', qty: '1', photoKeys: ['p'], photoFiles: [], ...over,
});

describe('splitMobileSofaPieces', () => {
  it('splits a new sofa line x2 into two new lines; the copy carries no photo or id', () => {
    const out = splitMobileSofaPieces([line({ key: 'cnr', qty: '2' })], []);
    expect(out).toHaveLength(2);
    expect(out![0]).toMatchObject({ key: 'cnr', qty: '1', photoKeys: ['p'] });
    expect(out![1]).toMatchObject({ itemId: '', qty: '1', photoKeys: [] });
    expect(out![1]!.key).not.toBe('cnr');
    expect(out![1]!.addIdempotencyKey).not.toBe('idem');
  });

  it('leaves a saved x2 line alone until its qty is changed here', () => {
    const saved = [{ id: 'row1', qty: 2 }];
    expect(splitMobileSofaPieces([line({ itemId: 'row1', qty: '2' })], saved)).toBeNull();
    const out = splitMobileSofaPieces([line({ itemId: 'row1', qty: '3' })], saved);
    expect(out!.map((l) => [l.itemId, l.qty])).toEqual([['row1', '1'], ['', '1'], ['', '1']]);
  });

  it('never splits a non-sofa line', () => {
    expect(splitMobileSofaPieces([line({ itemGroup: 'mattress', qty: '2' })], [])).toBeNull();
  });
});

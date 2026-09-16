/* The server's own copy of "an amendment must request something", per line.
 * HC-SO-011410 (owner 2026-09-15): a phone Delivery Date change also carried a
 * SPEC line per remarked line, each equal to the line as stored except for a
 * `remark` key inside new_variants — and one of them opened a Purchaser
 * approval. Pinned: the remark side channel does not count; key order does not
 * count; a field the payload omits cannot make a change; every REAL change is
 * kept; ADD / REMOVE are always kept; a failed read is null, not "keep all". */
import { describe, expect, it } from 'vitest';
import {
  amendmentLineIsNoop, dropNoopAmendmentLines, variantsForCompare, canonicalJson,
} from './amendment-noop-lines';

const stored = {
  id: 'li-bed', item_code: 'JAGER-(K)', qty: 1, unit_price_sen: 0,
  variants: { gap: '14"', fabricCode: 'PC151-01', specials: [], size: null },
  remark: '账本原文: PC151-01/Divan8+4/gap14', discount_sen: 0,
};
const phoneBlob = { fabricCode: 'PC151-01', gap: '14"', size: null, specials: [], remark: '账本原文: PC151-01/Divan8+4/gap14' };

const makeSb = (rows: Array<Record<string, unknown>>, fail = false) => ({
  from: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake PostgREST builder
    const b: any = {
      select: () => b, eq: () => b, in: () => b,
      then: (resolve: (v: unknown) => void) => resolve(fail ? { data: null, error: { message: 'boom' } } : { data: rows, error: null }),
    };
    return b;
  },
});

describe('variantsForCompare', () => {
  it('ignores the remark side channel and key order, and reads {} as none', () => {
    expect(variantsForCompare(phoneBlob)).toBe(variantsForCompare(stored.variants));
    expect(variantsForCompare({ remark: 'x' })).toBe('null');
    expect(variantsForCompare(null)).toBe('null');
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });
});

describe('amendmentLineIsNoop', () => {
  const same = { salesOrderItemId: 'li-bed', changeType: 'SPEC', newItemCode: 'JAGER-(K)', newVariants: phoneBlob, newQty: 1, newUnitPriceSen: 0 };

  it('the HC-SO-011410 line — equal in everything but the remark key — is a no-op', () => {
    expect(amendmentLineIsNoop(same, stored)).toBe(true);
  });

  it('a field the payload omits cannot make it a change', () => {
    expect(amendmentLineIsNoop({ salesOrderItemId: 'li-bed', changeType: 'SPEC' }, stored)).toBe(true);
  });

  it.each([
    ['code', { newItemCode: 'JAGER-(Q)' }],
    ['qty', { newQty: 2 }],
    ['price', { newUnitPriceSen: 150000 }],
    ['remark', { newRemark: 'deliver after 6pm' }],
    ['discount', { newDiscountSen: 5000 }],
    ['variants', { newVariants: { ...phoneBlob, gap: '12"' } }],
  ])('a real %s change is kept', (_label, patch) => {
    expect(amendmentLineIsNoop({ ...same, ...patch }, stored)).toBe(false);
  });

  it('a cleared remark on a remarked line IS a change; the same remark restated is not', () => {
    expect(amendmentLineIsNoop({ ...same, newRemark: '' }, stored)).toBe(false);
    expect(amendmentLineIsNoop({ ...same, newRemark: stored.remark }, stored)).toBe(true);
  });

  it('ADD and REMOVE are whole-line changes, never no-ops', () => {
    expect(amendmentLineIsNoop({ changeType: 'ADD', newItemCode: 'JAGER-(K)' }, stored)).toBe(false);
    expect(amendmentLineIsNoop({ salesOrderItemId: 'li-bed', changeType: 'REMOVE' }, stored)).toBe(false);
  });
});

describe('dropNoopAmendmentLines', () => {
  it('drops the no-op lines and keeps the rest, in order', async () => {
    const dispose = { id: 'li-dispose', item_code: 'DISPOSE', qty: 1, unit_price_sen: 0, variants: null, remark: '账本原文: set', discount_sen: 0 };
    const out = await dropNoopAmendmentLines(makeSb([stored, dispose]), 'HC-SO-011410', [
      { salesOrderItemId: 'li-bed', changeType: 'SPEC', newItemCode: 'JAGER-(K)', newVariants: phoneBlob, newQty: 1, newUnitPriceSen: 0 },
      { salesOrderItemId: 'li-dispose', changeType: 'SPEC', newItemCode: 'DISPOSE', newVariants: { remark: '账本原文: set' }, newQty: 1, newUnitPriceSen: 0 },
      { changeType: 'ADD', newItemCode: 'TRANSPORTATION CHARGES', newQty: 1, newUnitPriceSen: 15000 },
      { salesOrderItemId: 'li-bed', changeType: 'QTY', newQty: 2 },
    ]);
    expect(out).not.toBeNull();
    expect(out!.dropped.map((l) => l.salesOrderItemId)).toEqual(['li-bed', 'li-dispose']);
    expect(out!.kept.map((l) => l.changeType)).toEqual(['ADD', 'QTY']);
  });

  it('keeps a line whose id is not on this order — the row builder refuses it as missing', async () => {
    const out = await dropNoopAmendmentLines(makeSb([stored]), 'HC-SO-011410', [
      { salesOrderItemId: 'li-elsewhere', changeType: 'SPEC', newQty: 1 },
    ]);
    expect(out!.kept).toHaveLength(1);
  });

  it('reads nothing when no line references an existing item', async () => {
    const never = { from: () => { throw new Error('must not read'); } };
    const out = await dropNoopAmendmentLines(never, 'HC-SO-1', [{ changeType: 'ADD', newItemCode: 'X' }]);
    expect(out!.kept).toHaveLength(1);
  });

  it('answers null when the read fails, never "keep everything"', async () => {
    expect(await dropNoopAmendmentLines(makeSb([], true), 'HC-SO-1', [{ salesOrderItemId: 'li-bed', changeType: 'SPEC' }])).toBeNull();
  });
});

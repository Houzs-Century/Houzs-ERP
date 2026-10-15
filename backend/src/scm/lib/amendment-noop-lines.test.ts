/* The server's own copy of "an amendment must request something", per line.
 * HC-SO-011410 (owner 2026-09-15): a phone Delivery Date change also carried a
 * SPEC line per remarked line, each equal to the line as stored except for a
 * `remark` key inside new_variants — and one of them opened a Purchaser
 * approval. Pinned: the remark side channel does not count; key order does not
 * count; a field the payload omits cannot make a change; every REAL change is
 * kept; ADD / REMOVE are always kept; a failed read is null, not "keep all". */
import { describe, expect, it } from 'vitest';
import {
  amendmentLineIsNoop, amendmentLinePriceOnly, dropNoopAmendmentLines, variantsForCompare, canonicalJson, splitPriceFromSpec, type StoredLine,
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

describe('edit-view fills are not changes (HC-0103)', () => {
  it('HC-SO-012826/A1: a blank sofa leg filled with "Default" is a no-op; a real leg is kept', () => {
    const sofa: StoredLine = {
      id: 'li', item_code: '9058-1NA', qty: 1, unit_price_sen: 0, remark: 'compartment corrected 2026-09-04', discount_sen: 0,
      variants: { colourId: 'NICCA-02', fabricId: 'NICCA', specials: ['Change 8030 Backcushion', 'Nylon Fabric'], seatHeight: '24' },
    };
    const sent = { salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: '9058-1NA', newQty: 1, newUnitPriceSen: 0 };
    expect(amendmentLineIsNoop({ ...sent, newVariants: { ...sofa.variants as object, legHeight: 'Default' } }, sofa)).toBe(true);
    expect(amendmentLineIsNoop({ ...sent, newVariants: { ...sofa.variants as object, legHeight: '6"' } }, sofa)).toBe(false);
  });

  it('HC-SO-011077/A1: a recomputed bedframe totalHeight is a no-op; a moved divan is kept', () => {
    const bed: StoredLine = {
      id: 'li', item_code: 'TRION (A)-(K)', qty: 1, unit_price_sen: 0, remark: '账本原文: TBC/8”divan+1”legs/10” gaps', discount_sen: 0,
      variants: { gap: '10"', divanHeight: '8"', legHeight: '1"', fabricCode: 'PC151-10', totalHeight: '9"' },
    };
    const sent = { salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: 'TRION (A)-(K)', newQty: 1, newUnitPriceSen: 0 };
    expect(amendmentLineIsNoop({ ...sent, newVariants: { ...bed.variants as object, totalHeight: '19"' } }, bed)).toBe(true);
    expect(amendmentLineIsNoop({ ...sent, newVariants: { ...bed.variants as object, divanHeight: '10"', totalHeight: '21"' } }, bed)).toBe(false);
  });

  it('HC-SO-2609-321/A2: a remark moved from variants.remark to the column is a no-op; an edited one is kept', () => {
    const line: StoredLine = {
      id: 'li', item_code: '9058-L(RHF)', qty: 1, unit_price_sen: 0, remark: null, discount_sen: 0,
      variants: { remark: 'Backrest change to 8069', colourId: 'NICCA-07', legHeight: 'Default' },
    };
    const sent = { salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: '9058-L(RHF)', newQty: 1, newUnitPriceSen: 0,
      newVariants: { colourId: 'NICCA-07', legHeight: 'Default' } };
    expect(amendmentLineIsNoop({ ...sent, newRemark: 'Backrest change to 8069' }, line)).toBe(true);
    expect(amendmentLineIsNoop({ ...sent, newRemark: 'Backrest change to 8030' }, line)).toBe(false);
  });
});

describe('amendmentLinePriceOnly', () => {
  // A full no-op baseline (every field equals `stored`), so patching ONE field
  // isolates that field as the only thing that moved.
  const base = {
    salesOrderItemId: 'li-bed', changeType: 'SPEC', newItemCode: 'JAGER-(K)',
    newVariants: phoneBlob, newQty: 1, newUnitPriceSen: 0, newRemark: stored.remark, newDiscountSen: 0,
  };

  it('a change that moves only the unit price is price-only', () => {
    expect(amendmentLinePriceOnly({ ...base, newUnitPriceSen: 25000 }, stored)).toBe(true);
  });

  it('a change that moves only the discount is price-only', () => {
    expect(amendmentLinePriceOnly({ ...base, newDiscountSen: 5000 }, stored)).toBe(true);
  });

  it('a no-op line (nothing moved) is NOT price-only', () => {
    expect(amendmentLinePriceOnly(base, stored)).toBe(false);
  });

  it('a remark-only change is NOT price-only (no money moved)', () => {
    expect(amendmentLinePriceOnly({ ...base, newRemark: 'deliver after 6pm' }, stored)).toBe(false);
  });

  it.each([
    ['sku', { newItemCode: 'JAGER-(Q)' }],
    ['qty', { newQty: 2 }],
    ['remark', { newRemark: 'deliver after 6pm' }],
    ['variants', { newVariants: { ...phoneBlob, gap: '12"' } }],
  ])('a price move alongside a %s move is NOT price-only', (_label, patch) => {
    expect(amendmentLinePriceOnly({ ...base, newUnitPriceSen: 25000, ...patch }, stored)).toBe(false);
  });

  it('ADD and REMOVE are whole-line changes, never price-only', () => {
    expect(amendmentLinePriceOnly({ changeType: 'ADD', newItemCode: 'JAGER-(K)', newUnitPriceSen: 25000 }, stored)).toBe(false);
    expect(amendmentLinePriceOnly({ salesOrderItemId: 'li-bed', changeType: 'REMOVE' }, stored)).toBe(false);
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

describe('splitPriceFromSpec (DEV-70)', () => {
  /* HC-SO-013490/A1's King mattress line: the set price sat on it. */
  const cur: StoredLine = { id: 'li', item_code: 'AKEMI SOLITUDE MATT (K)', qty: 1, unit_price_sen: 850000, variants: null, remark: null, discount_sen: 0 };

  it('a SKU swap that re-fills the price splits into a price-less spec half and a price-only half', () => {
    const halves = splitPriceFromSpec({ salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: 'HAPPI SLEEP SOLITUDE MATT (K)', newQty: 1, newUnitPriceSen: 0 }, cur);
    expect(halves).toEqual({
      spec: { salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: 'HAPPI SLEEP SOLITUDE MATT (K)', newQty: 1, newUnitPriceSen: null, newDiscountSen: null },
      price: { salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: null, newVariants: null, newQty: null, newRemark: null, newUnitPriceSen: 0, newDiscountSen: null },
    });
  });

  it('a price-only change is not split (it goes to PRICE whole)', () => {
    expect(splitPriceFromSpec({ salesOrderItemId: 'li', changeType: 'SPEC', newUnitPriceSen: 800000 }, cur)).toBeNull();
  });

  it('a spec change that resends the stored price is not split', () => {
    expect(splitPriceFromSpec({ salesOrderItemId: 'li', changeType: 'SPEC', newItemCode: 'X', newUnitPriceSen: 850000 }, cur)).toBeNull();
  });

  it('ADD and REMOVE are whole-line changes, never split', () => {
    expect(splitPriceFromSpec({ changeType: 'ADD', newItemCode: 'X', newUnitPriceSen: 0 }, cur)).toBeNull();
    expect(splitPriceFromSpec({ salesOrderItemId: 'li', changeType: 'REMOVE' }, cur)).toBeNull();
  });
});

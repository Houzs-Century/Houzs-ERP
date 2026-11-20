// Owner 2026-11-20: an order costs the prices of its order date. A line edit
// that does not change the product (colour, fabric, side, price, discount,
// quantity) keeps the cost the line carries; it used to be re-costed at
// today's product cost, which moved once 2990 raised its sofa costs.
import { describe, expect, it } from 'vitest';
import { lineEditKeepsCost } from './so-line-cost-edit';

const before = { itemCode: 'XAMMAR-2A(RHF)', variants: { seatHeight: '24', legHeight: '6', fabricCode: 'EZ-002' }, unitCostSen: 99225 };

describe('lineEditKeepsCost', () => {
  it('keeps the cost for a new colour or fabric, a new price or quantity', () => {
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...before.variants, fabricCode: 'EZ-012', fabricId: 'f2' } })).toBe(true);
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(RHF)', variants: before.variants })).toBe(true);
  });
  it('keeps the cost for the other side of the same piece', () => {
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(LHF)', variants: before.variants })).toBe(true);
  });
  it('re-costs another piece, another model, a seat height, a leg or a paid option', () => {
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-L(RHF)', variants: before.variants })).toBe(false);
    expect(lineEditKeepsCost(before, { itemCode: 'KABBIN-2A(RHF)', variants: before.variants })).toBe(false);
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...before.variants, seatHeight: '28' } })).toBe(false);
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...before.variants, legHeight: '4' } })).toBe(false);
    expect(lineEditKeepsCost(before, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...before.variants, specials: [{ code: 'USB' }] } })).toBe(false);
  });
  it('a line carrying no cost takes one like a new line', () => {
    expect(lineEditKeepsCost({ ...before, unitCostSen: 0 }, { itemCode: 'XAMMAR-2A(RHF)', variants: before.variants })).toBe(false);
  });
  it('compares values, not key order', () => {
    expect(lineEditKeepsCost({ ...before, variants: { specials: [{ a: 1, b: 2 }] } }, { itemCode: before.itemCode, variants: { specials: [{ b: 2, a: 1 }] } })).toBe(true);
  });
});

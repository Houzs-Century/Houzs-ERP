// Owner 2026-11-20: an order costs the prices of its order date. A line edit
// that does not change the product (colour, fabric, side, price, discount,
// quantity) keeps the cost the line carries; it used to be re-costed at
// today's product cost, which moved once 2990 raised its sofa costs.
import { describe, expect, it } from 'vitest';
import { changedSpecKeys, isCostNeutralVariantKey, lineEditCostKind, lineEditKeepsCost, qtyChangeLineCostSen } from './so-line-cost-edit';

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

// Owner 2026-11-23 (rule 2): after the order's opening day a product change is
// costed on the change day; a qty change that moves the selling amount costs its
// extra units that day; one that does not is a typo fix. Amounts are made up.
describe('lineEditCostKind', () => {
  const v = { seatHeight: '24', legHeight: '6', fabricCode: 'EZ-002' };
  const was = { itemCode: 'XAMMAR-2A(RHF)', variants: v, unitCostSen: 99225 };
  it('a colour, a label, a remark or a side is not a product change', () => {
    expect(lineEditCostKind(was, { itemCode: 'XAMMAR-2A(LHF)', variants: { ...v, fabricCode: 'EZ-012', fabricLabel: 'Grey', remark: 'call first', summary: 'x' } })).toBe('keep');
  });
  it('a seat height alone is `height`: the caller compares the two heights', () => {
    expect(lineEditCostKind(was, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...v, seatHeight: '28' } })).toBe('height');
  });
  it('a height with a leg, another piece or another model is a product change', () => {
    expect(lineEditCostKind(was, { itemCode: 'XAMMAR-2A(RHF)', variants: { ...v, seatHeight: '28', legHeight: '4' } })).toBe('product');
    expect(lineEditCostKind(was, { itemCode: 'XAMMAR-L(RHF)', variants: v })).toBe('product');
    expect(lineEditCostKind(was, { itemCode: 'KABBIN-2A(RHF)', variants: v })).toBe('product');
  });
  it('a line with no cost takes one', () => {
    expect(lineEditCostKind({ ...was, unitCostSen: 0 }, { itemCode: was.itemCode, variants: v })).toBe('product');
  });
  it('names the cost-neutral keys and the changed spec keys', () => {
    expect(['fabricCode', 'colourId', 'legHeightLabel', 'remark', 'cellIndex', 'freeItem'].every(isCostNeutralVariantKey)).toBe(true);
    expect(['seatHeight', 'legHeight', 'specials', 'divanHeight'].some(isCostNeutralVariantKey)).toBe(false);
    expect(changedSpecKeys({ seatHeight: '24', remark: 'a' }, { seatHeight: '28', remark: 'b' })).toEqual(['seatHeight']);
  });
});

describe('qtyChangeLineCostSen', () => {
  it('a qty change that keeps the selling amount is a typo fix: every unit keeps its order-date cost', () => {
    expect(qtyChangeLineCostSen({ qtyBefore: 2, qtyAfter: 1, lineCostBeforeSen: 20000, sellingChanged: false, changeDayUnitCostSen: 12000 })).toBe(10000);
    expect(qtyChangeLineCostSen({ qtyBefore: 1, qtyAfter: 2, lineCostBeforeSen: 10000, sellingChanged: false, changeDayUnitCostSen: 12000 })).toBe(20000);
  });
  it('more units at a new selling amount: the extra ones take the change-day cost', () => {
    expect(qtyChangeLineCostSen({ qtyBefore: 1, qtyAfter: 3, lineCostBeforeSen: 10000, sellingChanged: true, changeDayUnitCostSen: 12000 })).toBe(34000);
  });
  it('fewer units: the units left keep their cost', () => {
    expect(qtyChangeLineCostSen({ qtyBefore: 3, qtyAfter: 1, lineCostBeforeSen: 34000, sellingChanged: true, changeDayUnitCostSen: 12000 })).toBe(11333);
  });
  it('no change day (the opening day): the unit cost carries over', () => {
    expect(qtyChangeLineCostSen({ qtyBefore: 1, qtyAfter: 2, lineCostBeforeSen: 10000, sellingChanged: true, changeDayUnitCostSen: null })).toBe(20000);
  });
});

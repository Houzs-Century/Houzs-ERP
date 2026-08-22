// ----------------------------------------------------------------------------
// sku-category — the group is the SKU's, and a group that ignores the line's
// own attributes is a contradiction worth saying out loud.
// ----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { lineItemGroup, attributesTheGroupWillIgnore } from './sku-category';

const SOFA = { fabricCode: 'PC151-12', seatHeight: '30', legHeight: 'Default' };

describe('lineItemGroup — the product master wins', () => {
  const bySku = new Map([['2376-1A(LHF)', 'sofa']]);

  test('the SKU beats whatever the caller sent', () => {
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)', itemGroup: 'others' })).toBe('sofa');
  });

  /* THE REGRESSION: the caller sent nothing at all. */
  test('the SKU fills a blank the caller left', () => {
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)' })).toBe('sofa');
    expect(lineItemGroup(bySku, { itemCode: '2376-1A(LHF)', itemGroup: null })).toBe('sofa');
  });

  test('a code with no product row keeps the caller value', () => {
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM', itemGroup: 'others' })).toBe('others');
  });

  test('and resolves to null when neither has one', () => {
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM' })).toBeNull();
    expect(lineItemGroup(bySku, { itemCode: 'RAW-FOAM', itemGroup: '   ' })).toBeNull();
  });

  test('the code is trimmed before lookup', () => {
    expect(lineItemGroup(bySku, { itemCode: '  2376-1A(LHF) ' })).toBe('sofa');
  });
});

describe('attributesTheGroupWillIgnore — the contradiction', () => {
  /* Exactly the shape that made HC-GRN-2608-003 invisible. */
  test('a blank group on a line carrying fabric + seat is reported', () => {
    expect(attributesTheGroupWillIgnore(null, SOFA).sort())
      .toEqual(['fabricCode', 'legHeight', 'seatHeight']);
  });

  test('so is `others`', () => {
    expect(attributesTheGroupWillIgnore('others', SOFA).length).toBe(3);
  });

  test('a sofa group composes them, so there is nothing to report', () => {
    expect(attributesTheGroupWillIgnore('sofa', SOFA)).toEqual([]);
    expect(attributesTheGroupWillIgnore('BEDFRAME', SOFA)).toEqual([]);
  });

  test('an accessory with no attributes is not a contradiction', () => {
    expect(attributesTheGroupWillIgnore('accessory', null)).toEqual([]);
    expect(attributesTheGroupWillIgnore('accessory', {})).toEqual([]);
  });

  /* Blank strings are not attributes — a line that merely HAS the keys, empty,
     must not be reported or the signal drowns. */
  test('empty attribute values are not reported', () => {
    expect(attributesTheGroupWillIgnore(null, { fabricCode: '', seatHeight: '   ' })).toEqual([]);
  });

  test('the POS vocabulary counts too', () => {
    expect(attributesTheGroupWillIgnore(null, { depth: '30', sofaLegHeight: '4"' }).sort())
      .toEqual(['depth', 'sofaLegHeight']);
  });
});

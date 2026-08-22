// ----------------------------------------------------------------------------
// sku-category — the group is the SKU's, and a group that ignores the line's
// own attributes is a contradiction worth saying out loud.
// ----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { lineItemGroup, attributesTheGroupWillIgnore, resolveItemGroups } from './sku-category';

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

/* ── resolveItemGroups — the OUTBOUND rewrite (docs/bugs/0523) ────────────────
   The inbound helpers above hand a route a lookup it calls where it writes. A
   delivery order reads the group in three places (stock check, commitment
   planner, stored row) and the stored one is what the OUT movement is keyed
   from later, so the rewrite is the guarantee that all three say one thing. */
const fakeSb = (rows: Array<{ code: string; category: string | null }> | null) => ({
  from: () => ({
    select: () => ({
      in: () => ({
        eq: () => Promise.resolve({ data: rows, error: rows ? null : { message: 'boom' } }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: rows ? null : { message: 'boom' } }).then(res),
      }),
    }),
  }),
});

describe('resolveItemGroups — one value, before any reader', () => {
  const catalogue = [{ code: 'BF-KING-01', category: 'BEDFRAME' }, { code: 'SPARE-LEG', category: null }];

  test('a wrong group and a missing group both become the SKU\'s', async () => {
    const out = await resolveItemGroups(fakeSb(catalogue), [
      { itemCode: 'BF-KING-01', itemGroup: 'others', qty: 1 },
      { itemCode: 'BF-KING-01', qty: 2 },
    ], 1);
    expect(out.map((l) => l.itemGroup)).toEqual(['bedframe', 'bedframe']);
    /* Everything else on the line rides through untouched — the routes pass
       these same objects on to the row builder. */
    expect(out[1]!.qty).toBe(2);
  });

  test('an unclassified code keeps what the caller sent', async () => {
    const out = await resolveItemGroups(fakeSb(catalogue), [{ itemCode: 'SPARE-LEG', itemGroup: 'accessory' }], 1);
    expect(out[0]!.itemGroup).toBe('accessory');
  });

  test('the input array is not mutated', async () => {
    const input = [{ itemCode: 'BF-KING-01', itemGroup: 'others' }];
    await resolveItemGroups(fakeSb(catalogue), input, 1);
    expect(input[0]!.itemGroup).toBe('others');
  });

  /* FAIL SOFT — a product read that blipped must never be the reason a delivery
     cannot be saved. Same contract skuCategoryMap states. */
  test('a failed catalogue read leaves every line exactly as it arrived', async () => {
    const out = await resolveItemGroups(fakeSb(null), [{ itemCode: 'BF-KING-01', itemGroup: 'others' }], 1);
    expect(out[0]!.itemGroup).toBe('others');
  });
});

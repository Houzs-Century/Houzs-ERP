// BUG-63 — swapping a line's product (HC-SO-2609-337: 8069-2A(RHF) -> 8069-2B(LHF))
// saved it at RM 0: the new SKU had no sell price, so the editor sent 0 and the
// PATCH wrote it over the stored RM 4,888.
import { describe, expect, test } from 'vitest';
import { erpLineTrust, recomputeFromSnapshot, unitAfterLineEdit } from './mfg-pricing-recompute';
import { soRouterSource } from '../../../tests/lib/so-router-source';

const STORED = 488_800;

/** A sofa module line with no cells and no sell price: the engine cannot price
 *  it and hands back whatever the client sent. */
const resolve = (clientUnitSen: number, zeroPriceIntended: unknown, migrated: boolean) => {
  const trust = erpLineTrust(false, clientUnitSen, zeroPriceIntended, migrated);
  const r = recomputeFromSnapshot(
    { itemCode: '8069-2B(LHF)', itemGroup: 'sofa', qty: 1, unitPriceSen: clientUnitSen, variants: {} } as never,
    { code: '8069-2B(LHF)', category: 'SOFA', sell_price_sen: null } as never,
    null, null, null, null, null, null, null, null, null, null, null, null,
    trust,
  );
  return unitAfterLineEdit(r.unit_price_sen, STORED, trust);
};

describe('BUG-63 line edit keeps the stored price when no new price is found', () => {
  test('an unclaimed 0 after a product swap keeps the stored price', () => {
    expect(resolve(0, undefined, false)).toBe(STORED);
  });

  test("the operator's claimed RM 0 still makes the line free", () => {
    expect(resolve(0, true, false)).toBe(0);
  });

  test("a migrated line's 0 still stands", () => {
    expect(resolve(0, undefined, true)).toBe(0);
  });

  test('a typed price still wins', () => {
    expect(resolve(350_000, undefined, false)).toBe(350_000);
  });

  test('a line stored at 0 stays 0', () => {
    expect(unitAfterLineEdit(0, 0, true)).toBe(0);
    expect(unitAfterLineEdit(0, null, true)).toBe(0);
  });

  test('the line PATCH route persists through it', () => {
    expect(soRouterSource()).toMatch(
      /unitAfterLineEdit\(recomputedPatch \? recomputedPatch\.unit_price_sen : clientUnit, prev\.unit_price_sen, patchTrust\)/,
    );
  });
});

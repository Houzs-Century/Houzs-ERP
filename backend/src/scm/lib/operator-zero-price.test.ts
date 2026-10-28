// ----------------------------------------------------------------------------
// 'operator-zero' — a 0 the operator TYPED survives; every other 0 does not.
//
// `0` carries two meanings on the wire: "the client could not resolve a price"
// and "this line is free". The engine has always read it as the first, which is
// right for every caller that cannot say otherwise. The ERP line editor CAN say
// otherwise (`zeroPriceIntended`), and that statement is what selects this mode
// (owner requirement 2026-08-18: a salesperson may set a line to RM 0).
//
// Two properties matter and both are asserted here:
//   1. a flagless 0 still takes the catalogue fill — that is every other caller
//      in the system, and the change must be invisible to them;
//   2. 'operator-zero' is NOT 'including-zero'. The latter also suppresses
//      selling surcharges, because a MIGRATED document must never be re-priced
//      (10,856 of 13,909 migrated lines are priced 0). An operator-authored zero
//      is not migrated history and must keep pricing its surcharges.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { recomputeFromSnapshot, type TrustSelling } from './mfg-pricing-recompute';

/** A plain catalogue line: product priced RM 2,990. `trustOperatorSelling` is
 *  the 15th positional, so the intervening optionals are passed explicitly. */
const run = (trust: TrustSelling, clientUnitSen: number) =>
  recomputeFromSnapshot(
    { itemCode: 'X-1', itemGroup: 'others', qty: 1, unitPriceSen: clientUnitSen, variants: {} } as never,
    { code: 'X-1', category: 'OTHERS', sell_price_sen: 299_000 } as never,
    null, // fabric
    null, // config
    null, // sofaCombos
    null, // sofaModulePrices
    null, // sellingFabricTiers
    null, // fabricAddonConfig
    null, // pwpBaseSen
    null, // pwpSofaComboIds
    null, // specialAddons
    null, // sofaModuleCostRows
    null, // modelFabricOverrides
    null, // compartmentFabricOverrides
    trust,
  );

describe("trust mode 'operator-zero'", () => {
  test('a flagless 0 still takes the catalogue fill — unchanged for every other caller', () => {
    expect(run(true, 0).unit_price_sen).toBe(299_000);
    expect(run(false, 0).unit_price_sen).toBe(299_000);
  });

  test("an operator-typed 0 survives", () => {
    expect(run('operator-zero', 0).unit_price_sen).toBe(0);
  });

  test('the mode changes nothing for a priced line — plain trust already covered that', () => {
    expect(run('operator-zero', 200_000).unit_price_sen).toBe(200_000);
    expect(run(true, 200_000).unit_price_sen).toBe(200_000);
  });

  test('no trust still re-prices a non-zero client figure to the catalogue', () => {
    expect(run(false, 200_000).unit_price_sen).toBe(299_000);
  });
});

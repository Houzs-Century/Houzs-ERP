/* HC-0134: special_addons was read for every company and keyed by code, so a
 * 2990 selling price on a shared code priced the Houzs Century line. */
import { describe, expect, it } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { loadSpecialAddons } from './mfg-pricing-recompute';

const ROWS = [
  { company_id: 1, code: 'Divan Full Cover', selling_price_sen: 0, cost_price_sen: 0, option_groups: [], active: true },
  { company_id: 2, code: 'Divan Full Cover', selling_price_sen: 12500, cost_price_sen: 0, option_groups: [], active: true },
];

describe('loadSpecialAddons', () => {
  it("reads only the order's own company's add-ons", async () => {
    const defs = await loadSpecialAddons(fakeSb({ special_addons: ROWS }), 1);
    expect(defs.map((d) => [d.code, d.sellingPriceSen])).toEqual([['Divan Full Cover', 0]]);
  });
});

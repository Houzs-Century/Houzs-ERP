/* HC-0134: the special delivery fee lookup read every company's rules, so a
 * 2990 rule whose target matched a Houzs Century line priced the HC order. */
import { describe, expect, it } from 'vitest';

import { fakeSb } from './fake-postgrest';
import { specialDeliveryFeesForLines } from './special-delivery';

const LINE = { category: 'SOFA', modelId: 'm1', sizeCode: null, builtCompartments: [] };
const RULES = [
  { company_id: 1, target: [{ modelId: 'm1', scope: 'model' }], standalone_fee: 500, cross_cat_followup_fee: 0 },
  { company_id: 2, target: [{ modelId: 'm1', scope: 'model' }], standalone_fee: 125, cross_cat_followup_fee: 0 },
];

describe('specialDeliveryFeesForLines', () => {
  it("applies only the order's own company rules", async () => {
    const fees = await specialDeliveryFeesForLines(fakeSb({ special_delivery_fee_rules: RULES }), [LINE], new Map(), 1);
    expect(fees.map((f) => f.standaloneFee)).toEqual([50000]);
  });
});

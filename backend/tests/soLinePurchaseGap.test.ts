import { describe, expect, it } from 'vitest';

import { soLinePurchaseGap } from '../src/scm/lib/so-line-purchase-gap';

/** HC-SO-012949 line 1 as production holds it: a CODY single bedframe on a
 *  proceeded, IN_PRODUCTION company-1 order with nothing bought for it. */
const cody = {
  companyId: 1,
  orderStatus: 'IN_PRODUCTION',
  orderProcessed: true,
  itemGroup: 'bedframe',
  itemCode: 'CODY-(S)',
  cancelled: false,
  qty: 1,
  poQtyPicked: 0,
};

describe('soLinePurchaseGap', () => {
  it('flags the line the flag was written for', () => {
    expect(soLinePurchaseGap(cody)).toBe(true);
  });

  it('flags a sofa and an (SP) mattress on the same terms', () => {
    expect(soLinePurchaseGap({ ...cody, itemGroup: 'sofa', itemCode: '9058-1NA' })).toBe(true);
    expect(soLinePurchaseGap({ ...cody, itemGroup: 'mattress', itemCode: 'JAGER (Q) (SP)' })).toBe(true);
  });

  it('does NOT flag a pooled line - a plain mattress or an accessory is bought against stock', () => {
    /* The whole value of the flag is that it is rare enough to act on. A
       pooled group with no purchase order of its own is normal, and including
       those would bury the finding in hundreds of correct rows. */
    expect(soLinePurchaseGap({ ...cody, itemGroup: 'mattress', itemCode: 'JAGER (Q)' })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, itemGroup: 'accessories', itemCode: 'PILLOW-01' })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, itemGroup: 'service', itemCode: 'DELIVERY' })).toBe(false);
  });

  it('does NOT flag an order that has not been proceeded', () => {
    /* Owner 2026-08-18: the Processing Date IS the release for purchasing to
       order. Before it, no purchase order is the normal state of a good order. */
    expect(soLinePurchaseGap({ ...cody, orderProcessed: false })).toBe(false);
  });

  it('does NOT flag a finished or cancelled order, or a cancelled line', () => {
    for (const st of ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT']) {
      expect(soLinePurchaseGap({ ...cody, orderStatus: st })).toBe(false);
    }
    expect(soLinePurchaseGap({ ...cody, cancelled: true })).toBe(false);
    /* Case and padding must not change the answer - the header column is free
       text on the migrated documents. */
    expect(soLinePurchaseGap({ ...cody, orderStatus: '  shipped ' })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, orderStatus: 'CONFIRMED' })).toBe(true);
  });

  it('does NOT flag company 2 - it pools, so no purchase order is not a dead end there', () => {
    expect(soLinePurchaseGap({ ...cody, companyId: 2 })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, companyId: null })).toBe(false);
  });

  it('does NOT flag a PARTIAL order - that is a different sentence for a buyer', () => {
    expect(soLinePurchaseGap({ ...cody, qty: 3, poQtyPicked: 1 })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, qty: 3, poQtyPicked: 3 })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, qty: 3, poQtyPicked: 0 })).toBe(true);
  });

  it('treats a missing po_qty_picked as zero, and a zero-quantity line as nothing to buy', () => {
    expect(soLinePurchaseGap({ ...cody, poQtyPicked: null })).toBe(true);
    expect(soLinePurchaseGap({ ...cody, qty: 0 })).toBe(false);
    expect(soLinePurchaseGap({ ...cody, qty: null })).toBe(false);
  });
});

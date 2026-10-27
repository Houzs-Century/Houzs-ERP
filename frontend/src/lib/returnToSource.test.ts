import { describe, expect, it } from 'vitest';
import { afterCreatePath, sourceDocPath } from './returnToSource';

describe('afterCreatePath', () => {
  it('HC-0127: a document raised from another document returns to the source', () => {
    expect(afterCreatePath('/scm/delivery-returns/dr-1', sourceDocPath.deliveryOrder('do-9'))).toBe('/scm/delivery-orders/do-9');
  });

  it('a document keyed from scratch opens the new document', () => {
    expect(afterCreatePath('/scm/delivery-returns/dr-1', null)).toBe('/scm/delivery-returns/dr-1');
  });

  it('an empty source id counts as no source', () => {
    expect(sourceDocPath.deliveryOrder('')).toBeNull();
    expect(sourceDocPath.salesOrder(null)).toBeNull();
  });

  it('sales and consignment orders are addressed by doc no, escaped', () => {
    expect(sourceDocPath.salesOrder('2990-SO 1/2')).toBe('/scm/sales-orders/2990-SO%201%2F2');
    expect(sourceDocPath.consignmentOrder('CO-1')).toBe('/scm/consignment-orders/CO-1');
  });

  it('every source kind maps to its detail route', () => {
    expect(sourceDocPath.goodsReceipt('g1')).toBe('/scm/grns/g1');
    expect(sourceDocPath.purchaseOrder('p1')).toBe('/scm/purchase-orders/p1');
    expect(sourceDocPath.consignmentNote('n1')).toBe('/scm/consignment-notes/n1');
    expect(sourceDocPath.purchaseConsignmentOrder('c1')).toBe('/scm/purchase-consignment-orders/c1');
    expect(sourceDocPath.purchaseConsignmentReceive('r1')).toBe('/scm/purchase-consignment-receives/r1');
  });
});

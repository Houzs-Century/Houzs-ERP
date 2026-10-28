// SO create — the operator-store warehouse default (owner 2026-08-25).
//
// The case that forced it: 2990-SO-2608-045 (POS walk-in, no state, no
// location) was born with FOUR goods lines carrying warehouse_id NULL. A NULL
// line matches no allocation bucket — it sits PENDING with no incoming PO
// while its goods sit in the warehouse — and the do-link-orphan-sentinel had
// been red for days on exactly this class. The order was sold AT a store, by
// an operator parked under that store (scm.staff.showroom_warehouse_id), so
// until an address says otherwise the order belongs there.
import { describe, expect, it } from 'vitest';
import { chooseCreateWarehouseDefault } from '../src/scm/lib/so-warehouse';

const KL = 'wh-kl';
const PJ_SHOWROOM = 'wh-pj-showroom';

describe('chooseCreateWarehouseDefault', () => {
  it('the -045 shape: no location, no state → the operator store', () => {
    expect(chooseCreateWarehouseDefault({
      explicitSalesLocation: null,
      salesLocationWarehouseId: null,
      stateWarehouseId: null,
      operatorStoreWarehouseId: PJ_SHOWROOM,
    })).toEqual({ warehouseId: PJ_SHOWROOM, usedOperatorStore: true });
  });

  it('a resolved State always beats the store — it is a statement about the ORDER', () => {
    expect(chooseCreateWarehouseDefault({
      explicitSalesLocation: null,
      salesLocationWarehouseId: null,
      stateWarehouseId: KL,
      operatorStoreWarehouseId: PJ_SHOWROOM,
    })).toEqual({ warehouseId: KL, usedOperatorStore: false });
  });

  it('an explicit resolved Location beats both — the read-time rule, at write time', () => {
    expect(chooseCreateWarehouseDefault({
      explicitSalesLocation: 'KL WAREHOUSE',
      salesLocationWarehouseId: KL,
      stateWarehouseId: null,
      operatorStoreWarehouseId: PJ_SHOWROOM,
    })).toEqual({ warehouseId: KL, usedOperatorStore: false });
  });

  it('an explicit Location that resolves to NOTHING blocks the store too', () => {
    // The operator said something specific (typo / retired warehouse);
    // silently overriding it with their parking spot would bind lines to a
    // warehouse that contradicts the header text. Keeps today's NULL and the
    // [null-warehouse] signal keeps naming it.
    expect(chooseCreateWarehouseDefault({
      explicitSalesLocation: 'KL WEREHOUSE',
      salesLocationWarehouseId: null,
      stateWarehouseId: null,
      operatorStoreWarehouseId: PJ_SHOWROOM,
    })).toEqual({ warehouseId: null, usedOperatorStore: false });
  });

  it('no store parked (headless caller / un-parked staff) → NULL, as before', () => {
    expect(chooseCreateWarehouseDefault({
      explicitSalesLocation: null,
      salesLocationWarehouseId: null,
      stateWarehouseId: null,
      operatorStoreWarehouseId: null,
    })).toEqual({ warehouseId: null, usedOperatorStore: false });
  });

  it('state present AND store present: state wins even when both resolve', () => {
    // A mapped state is the customer's address speaking; the store is only a
    // birthplace. usedOperatorStore false means the header takes the derived
    // location, not the store label.
    const r = chooseCreateWarehouseDefault({
      explicitSalesLocation: null,
      salesLocationWarehouseId: null,
      stateWarehouseId: KL,
      operatorStoreWarehouseId: PJ_SHOWROOM,
    });
    expect(r.warehouseId).toBe(KL);
    expect(r.usedOperatorStore).toBe(false);
  });
});

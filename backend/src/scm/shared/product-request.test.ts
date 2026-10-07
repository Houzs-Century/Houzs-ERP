import { describe, expect, test } from 'vitest';
import {
  canTransition, nextStatus, requesterMayChange, awaitsPurchaser, productRefusal, pcoFromRequestRefusal,
  defaultSkuCode, requestVariants, PRODUCT_REQUEST_STATUSES, type ProductRequestStatus, type ProductRequestAction,
} from './product-request';

describe('product request — state machine', () => {
  test('the Purchaser decides a REQUESTED request, and only that one', () => {
    expect(nextStatus('REQUESTED', 'approve')).toBe('APPROVED');
    expect(nextStatus('REQUESTED', 'reject')).toBe('REJECTED');
    for (const s of PRODUCT_REQUEST_STATUSES.filter((x) => x !== 'REQUESTED')) {
      expect(canTransition(s, 'approve')).toBe(false);
      expect(canTransition(s, 'reject')).toBe(false);
    }
  });

  test('the requester withdraws before a decision or after a rejection, and resubmits a rejected one', () => {
    expect(nextStatus('REQUESTED', 'withdraw')).toBe('WITHDRAWN');
    expect(nextStatus('REJECTED', 'withdraw')).toBe('WITHDRAWN');
    expect(nextStatus('REJECTED', 'resubmit')).toBe('REQUESTED');
    expect(canTransition('APPROVED', 'withdraw')).toBe(false);
    expect(canTransition('APPROVED', 'resubmit')).toBe(false);
    expect(requesterMayChange('REQUESTED')).toBe(true);
    expect(requesterMayChange('REJECTED')).toBe(true);
    expect(requesterMayChange('APPROVED')).toBe(false);
    expect(awaitsPurchaser('REQUESTED')).toBe(true);
    expect(awaitsPurchaser('REJECTED')).toBe(false);
  });

  test('a PC Order is raised from an APPROVED request only, and closes from APPROVED or PCO_ISSUED', () => {
    expect(nextStatus('APPROVED', 'issue_pco')).toBe('PCO_ISSUED');
    expect(canTransition('REQUESTED', 'issue_pco')).toBe(false);
    expect(canTransition('PCO_ISSUED', 'issue_pco')).toBe(false);
    expect(nextStatus('APPROVED', 'close')).toBe('CLOSED');
    expect(nextStatus('PCO_ISSUED', 'close')).toBe('CLOSED');
    expect(canTransition('REQUESTED', 'close')).toBe(false);
  });

  test('terminal states accept nothing', () => {
    const actions: ProductRequestAction[] = ['approve', 'reject', 'withdraw', 'resubmit', 'issue_pco', 'close'];
    for (const s of ['WITHDRAWN', 'CLOSED'] as ProductRequestStatus[]) {
      for (const a of actions) expect(canTransition(s, a)).toBe(false);
    }
  });
});

describe('product request — the product line', () => {
  test('a repack names an existing SKU', () => {
    expect(productRefusal({ request_type: 'REPACK', item_code: null, proposed_model_name: 'Aurora' })?.error).toBe('item_code_required');
    expect(productRefusal({ request_type: 'REPACK', item_code: '5530-3S', proposed_model_name: null })).toBeNull();
  });
  test('a new product names an existing SKU or a new Model, never neither', () => {
    expect(productRefusal({ request_type: 'NEW_PRODUCT', item_code: null, proposed_model_name: null })?.error).toBe('product_required');
    expect(productRefusal({ request_type: 'NEW_PRODUCT', item_code: '  ', proposed_model_name: ' ' })?.error).toBe('product_required');
    expect(productRefusal({ request_type: 'NEW_PRODUCT', item_code: null, proposed_model_name: 'Aurora 2-Seater' })).toBeNull();
    expect(productRefusal({ request_type: 'NEW_PRODUCT', item_code: '5530-3S', proposed_model_name: null })).toBeNull();
  });
});

describe('product request — raising the PC Order', () => {
  const base = { request_no: 'HC-PDR-2610-001' };
  test('refused until approved, and refused again once issued', () => {
    expect(pcoFromRequestRefusal({ ...base, status: 'REQUESTED', item_code: '5530-3S' })?.error).toBe('request_not_approved');
    expect(pcoFromRequestRefusal({ ...base, status: 'PCO_ISSUED', item_code: '5530-3S' })?.error).toBe('request_already_issued');
    expect(pcoFromRequestRefusal({ ...base, status: 'CLOSED', item_code: '5530-3S' })?.error).toBe('request_not_approved');
  });
  test('refused while the new Model has no SKU yet — the order would carry a code the catalogue has not got', () => {
    expect(pcoFromRequestRefusal({ ...base, status: 'APPROVED', item_code: null })?.error).toBe('model_not_created');
    expect(pcoFromRequestRefusal({ ...base, status: 'APPROVED', item_code: 'AURORA-2S' })).toBeNull();
  });
  test('a sofa SKU code carries its compartment; other categories take the model code', () => {
    expect(defaultSkuCode('aurora', 'SOFA', '2s')).toBe('AURORA-2S');
    expect(defaultSkuCode('Aurora Max', 'SOFA', null)).toBe('AURORA-MAX');
    expect(defaultSkuCode('HILTON', 'BEDFRAME', 'Q')).toBe('HILTON');
  });
  test('the PC Order line carries the picked fabric, seat and leg in the editor keys, and nothing empty', () => {
    expect(requestVariants({ fabric_code: 'LIN-01', seat_size: '22', leg_size: null })).toEqual({ fabricCode: 'LIN-01', seatHeight: '22' });
    expect(requestVariants({ fabric_code: ' ', seat_size: null, leg_size: '4' })).toEqual({ legHeight: '4' });
  });
});

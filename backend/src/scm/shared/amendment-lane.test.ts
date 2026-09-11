// amendment-lane — the two-lane split IS the permission boundary (which desk
// may approve which change), so its classification is pinned by test: a change
// that silently swaps lanes is a change in WHO can approve it.

import { describe, it, expect } from 'vitest';
import {
  classifyHeaderKey,
  classifyLine,
  classifyLineItemCode,
  splitAmendmentByLane,
  canLaneTransition,
  laneActionTarget,
  laneIsOpen,
  LANE_APPROVE_KEY,
} from './amendment-lane';
import { soAmendableHeaderKeys } from './so-field-policy';

describe('classifyHeaderKey', () => {
  it('routes the Processing Date to LINES — purchasing re-times the supplier (owner 2026-07-27)', () => {
    expect(classifyHeaderKey('processingDate')).toBe('LINES');
  });

  it('routes delivery schedule + location + address/disposal fields to DELIVERY', () => {
    expect(classifyHeaderKey('customerDeliveryDate')).toBe('DELIVERY');
    expect(classifyHeaderKey('customerState')).toBe('DELIVERY');
    expect(classifyHeaderKey('postcode')).toBe('DELIVERY');
    expect(classifyHeaderKey('city')).toBe('DELIVERY');
    expect(classifyHeaderKey('address1')).toBe('DELIVERY');
    expect(classifyHeaderKey('address4')).toBe('DELIVERY');
    expect(classifyHeaderKey('shipToAddress')).toBe('DELIVERY');
    expect(classifyHeaderKey('billToAddress')).toBe('DELIVERY');
    expect(classifyHeaderKey('installToAddress')).toBe('DELIVERY');
    expect(classifyHeaderKey('replacementDisposal')).toBe('DELIVERY');
  });

  it('routes the customer-info block to DELIVERY (owner 2026-08-21)', () => {
    // The lane whose label has always read "delivery / customer info" finally
    // carries customer info: name / phone / email sign with Logistics.
    expect(classifyHeaderKey('debtorName')).toBe('DELIVERY');
    expect(classifyHeaderKey('phone')).toBe('DELIVERY');
    expect(classifyHeaderKey('email')).toBe('DELIVERY');
  });

  it('throws on an unknown key instead of guessing a lane', () => {
    expect(() => classifyHeaderKey('salesLocation')).toThrow(/no lane/);
    expect(() => classifyHeaderKey('customerName')).toThrow(/no lane/);
  });

  it('covers EVERY amendable header key (drift guard vs so-field-policy)', () => {
    for (const key of soAmendableHeaderKeys()) {
      expect(() => classifyHeaderKey(key)).not.toThrow();
    }
  });
});

describe('classifyLineItemCode', () => {
  it('routes product SKUs to LINES', () => {
    expect(classifyLineItemCode('PC151-01')).toBe('LINES');
    expect(classifyLineItemCode('SOFA-3S')).toBe('LINES');
    expect(classifyLineItemCode(null)).toBe('LINES');
    expect(classifyLineItemCode(undefined)).toBe('LINES');
  });

  it('routes the SVC service family (delivery fee / dispose / lift) to DELIVERY', () => {
    expect(classifyLineItemCode('SVC-DELIVERY')).toBe('DELIVERY');
    expect(classifyLineItemCode('SVC-DELIVERY-EAST-MALAYSIA')).toBe('DELIVERY');
    expect(classifyLineItemCode('SVC-DISPOSE')).toBe('DELIVERY');
    expect(classifyLineItemCode('svc-lift')).toBe('DELIVERY');
  });

  it('routes a BARE-code service line to DELIVERY by item_group (go-live / AutoCount codes lack the SVC- prefix)', () => {
    // owner 2026-09-11: DISPOSE / STORAGE / TRANSPORTATION CHARGES carry
    // item_group='service' but no SVC- prefix — the code-only test used to
    // mis-route them to LINES (Purchasing).
    expect(classifyLine({ itemCode: 'DISPOSE', itemGroup: 'service' })).toBe('DELIVERY');
    expect(classifyLine({ itemCode: 'TRANSPORTATION CHARGES', itemGroup: 'service' })).toBe('DELIVERY');
    expect(classifyLine({ itemCode: 'STORAGE', itemGroup: 'service' })).toBe('DELIVERY');
  });

  it('keeps a real product line on LINES regardless of its group', () => {
    expect(classifyLine({ itemCode: '9028-L(RHF)', itemGroup: 'sofa' })).toBe('LINES');
    expect(classifyLine({ itemCode: 'PC151-01', itemGroup: null })).toBe('LINES');
    expect(classifyLine({ itemCode: 'JAGER-(Q)', itemGroup: 'bedframe' })).toBe('LINES');
  });
});

describe('splitAmendmentByLane', () => {
  type L = { id: string; code: string | null };
  const byCode = (l: L) => ({ itemCode: l.code });

  it('splits a mixed submission into both lanes (proc date rides LINES)', () => {
    const split = splitAmendmentByLane<L>(
      { customerDeliveryDate: '2026-08-01', processingDate: '2026-07-30' },
      [{ id: 'a', code: 'PC151-01' }, { id: 'b', code: 'SVC-DELIVERY' }],
      byCode,
    );
    expect(split.lanes).toEqual(['LINES', 'DELIVERY']);
    expect(split.perLane.LINES.lines.map((l) => l.id)).toEqual(['a']);
    expect(split.perLane.LINES.headerChanges).toEqual({ processingDate: '2026-07-30' });
    expect(split.perLane.DELIVERY.lines.map((l) => l.id)).toEqual(['b']);
    expect(split.perLane.DELIVERY.headerChanges).toEqual({
      customerDeliveryDate: '2026-08-01',
    });
  });

  it('a product-only submission yields only LINES', () => {
    const split = splitAmendmentByLane<L>({}, [{ id: 'a', code: 'PC151-01' }], byCode);
    expect(split.lanes).toEqual(['LINES']);
    expect(split.perLane.DELIVERY.lines).toEqual([]);
    expect(split.perLane.DELIVERY.headerKeys).toEqual([]);
  });

  it('a both-dates reschedule splits into two one-signature documents', () => {
    const split = splitAmendmentByLane<L>(
      { customerDeliveryDate: '2026-08-01', processingDate: '2026-07-30' },
      [],
      byCode,
    );
    expect(split.lanes).toEqual(['LINES', 'DELIVERY']);
    expect(split.perLane.LINES.headerKeys).toEqual(['processingDate']);
    expect(split.perLane.DELIVERY.headerKeys).toEqual(['customerDeliveryDate']);
  });

  it('an address / disposal change yields only DELIVERY', () => {
    const split = splitAmendmentByLane<L>(
      { address1: '12 Jalan Baru', replacementDisposal: 'Old sofa 1pc' },
      [],
      byCode,
    );
    expect(split.lanes).toEqual(['DELIVERY']);
  });

  it('splits a bare-code service line into DELIVERY via item_group', () => {
    // The go-live shape that mis-routed to Purchasing: a real product line plus a
    // DISPOSE service line whose code has no SVC- prefix. The item_group in the
    // identity lands the DISPOSE line in its own DELIVERY (Logistics) document.
    type LG = { id: string; code: string | null; group: string | null };
    const split = splitAmendmentByLane<LG>(
      {},
      [{ id: 'a', code: '9028-L(RHF)', group: 'sofa' }, { id: 'b', code: 'DISPOSE', group: 'service' }],
      (l) => ({ itemCode: l.code, itemGroup: l.group }),
    );
    expect(split.lanes).toEqual(['LINES', 'DELIVERY']);
    expect(split.perLane.LINES.lines.map((l) => l.id)).toEqual(['a']);
    expect(split.perLane.DELIVERY.lines.map((l) => l.id)).toEqual(['b']);
  });
});

describe('lane state machine', () => {
  it('approve / reject / withdraw are legal ONLY from REQUESTED', () => {
    for (const action of ['approve-so', 'reject', 'withdraw'] as const) {
      expect(canLaneTransition('REQUESTED', action)).toBe(true);
      expect(canLaneTransition('SO_APPROVED', action)).toBe(false);
      expect(canLaneTransition('REJECTED', action)).toBe(false);
      // Legacy-only states can never host a lane action.
      expect(canLaneTransition('SUPPLIER_PENDING', action)).toBe(false);
      expect(canLaneTransition('PO_APPROVED', action)).toBe(false);
      expect(canLaneTransition('SENT', action)).toBe(false);
    }
  });

  it('legacy actions are not lane actions', () => {
    expect(canLaneTransition('REQUESTED', 'supplier-confirm')).toBe(false);
    expect(canLaneTransition('REQUESTED', 'approve-po')).toBe(false);
    expect(canLaneTransition('REQUESTED', 'send')).toBe(false);
  });

  it('targets + openness', () => {
    expect(laneActionTarget('approve-so')).toBe('SO_APPROVED');
    expect(laneActionTarget('reject')).toBe('REJECTED');
    expect(laneActionTarget('withdraw')).toBe('REJECTED');
    expect(laneIsOpen('REQUESTED')).toBe(true);
    expect(laneIsOpen('SO_APPROVED')).toBe(false);
    expect(laneIsOpen('REJECTED')).toBe(false);
  });

  it('lane approve keys are the two new flat permissions', () => {
    expect(LANE_APPROVE_KEY.LINES).toBe('scm.amendment.approve_lines');
    expect(LANE_APPROVE_KEY.DELIVERY).toBe('scm.amendment.approve_delivery');
  });
});

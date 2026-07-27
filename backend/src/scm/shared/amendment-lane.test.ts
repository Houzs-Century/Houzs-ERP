// amendment-lane — the two-lane split IS the permission boundary (which desk
// may approve which change), so its classification is pinned by test: a change
// that silently swaps lanes is a change in WHO can approve it.

import { describe, it, expect } from 'vitest';
import {
  classifyHeaderKey,
  classifyLineItemCode,
  splitAmendmentByLane,
  canLaneTransition,
  laneActionTarget,
  laneIsOpen,
  LANE_APPROVE_KEY,
} from './amendment-lane';
import { soAmendableHeaderKeys } from './so-field-policy';

describe('classifyHeaderKey', () => {
  it('routes the schedule pair + location fields to DELIVERY', () => {
    expect(classifyHeaderKey('internalExpectedDd')).toBe('DELIVERY');
    expect(classifyHeaderKey('customerDeliveryDate')).toBe('DELIVERY');
    expect(classifyHeaderKey('customerState')).toBe('DELIVERY');
    expect(classifyHeaderKey('postcode')).toBe('DELIVERY');
    expect(classifyHeaderKey('city')).toBe('DELIVERY');
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
});

describe('splitAmendmentByLane', () => {
  type L = { id: string; code: string | null };
  const byCode = (l: L) => l.code;

  it('splits a mixed submission into both lanes', () => {
    const split = splitAmendmentByLane<L>(
      { customerDeliveryDate: '2026-08-01', internalExpectedDd: '2026-07-30' },
      [{ id: 'a', code: 'PC151-01' }, { id: 'b', code: 'SVC-DELIVERY' }],
      byCode,
    );
    expect(split.lanes).toEqual(['LINES', 'DELIVERY']);
    expect(split.perLane.LINES.lines.map((l) => l.id)).toEqual(['a']);
    expect(split.perLane.LINES.headerKeys).toEqual([]);
    expect(split.perLane.DELIVERY.lines.map((l) => l.id)).toEqual(['b']);
    expect(split.perLane.DELIVERY.headerChanges).toEqual({
      customerDeliveryDate: '2026-08-01',
      internalExpectedDd: '2026-07-30',
    });
  });

  it('a product-only submission yields only LINES', () => {
    const split = splitAmendmentByLane<L>({}, [{ id: 'a', code: 'PC151-01' }], byCode);
    expect(split.lanes).toEqual(['LINES']);
    expect(split.perLane.DELIVERY.lines).toEqual([]);
    expect(split.perLane.DELIVERY.headerKeys).toEqual([]);
  });

  it('a header-only reschedule yields only DELIVERY', () => {
    const split = splitAmendmentByLane<L>(
      { customerDeliveryDate: '2026-08-01', internalExpectedDd: '2026-07-30' },
      [],
      byCode,
    );
    expect(split.lanes).toEqual(['DELIVERY']);
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

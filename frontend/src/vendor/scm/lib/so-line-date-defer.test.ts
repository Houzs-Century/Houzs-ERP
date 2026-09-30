import { describe, it, expect } from 'vitest';
import { deferLineDateToHeader, withoutLineDate } from './so-line-date-defer';

describe('deferLineDateToHeader — proceeding on the phone (BUG-39 follow-up)', () => {
  it('defers a cascaded line date while the order has no stored Processing Date', () => {
    expect(deferLineDateToHeader({ storedProcessingDate: '', overridden: false })).toBe(true);
    expect(deferLineDateToHeader({ storedProcessingDate: null, overridden: false })).toBe(true);
  });

  it('sends a hand-edited line date — it is the operator\'s, not the cascade\'s', () => {
    expect(deferLineDateToHeader({ storedProcessingDate: '', overridden: true })).toBe(false);
  });

  it('sends the date as before once the order already has a Processing Date', () => {
    expect(deferLineDateToHeader({ storedProcessingDate: '2026-10-01', overridden: false })).toBe(false);
  });
});

describe('withoutLineDate', () => {
  it('drops only the delivery date', () => {
    expect(withoutLineDate({ itemCode: 'A', qty: 2, lineDeliveryDate: '2026-10-10' })).toEqual({ itemCode: 'A', qty: 2 });
  });
});

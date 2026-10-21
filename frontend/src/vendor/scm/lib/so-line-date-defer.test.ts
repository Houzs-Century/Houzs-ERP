import { describe, it, expect } from 'vitest';
import { deferLineDateToHeader, lineDatePinned, withoutLineDate } from './so-line-date-defer';

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

describe('lineDatePinned — the phone pins a line only when the operator moved it off the header (HC-0131)', () => {
  it('a line that took the header date follows the header', () => {
    expect(lineDatePinned({ lineDate: '2026-10-09', headerDate: '2026-10-09', handEdited: false })).toBe(false);
  });

  it('a hand-edited date that ends up equal to the header still follows it', () => {
    expect(lineDatePinned({ lineDate: '2026-10-09', headerDate: '2026-10-09', handEdited: true })).toBe(false);
  });

  it("a hand-edited date different from the header is the operator's own", () => {
    expect(lineDatePinned({ lineDate: '2026-10-15', headerDate: '2026-10-09', handEdited: true })).toBe(true);
  });

  it('a blank line date is never pinned', () => {
    expect(lineDatePinned({ lineDate: '', headerDate: '2026-10-09', handEdited: true })).toBe(false);
  });
});

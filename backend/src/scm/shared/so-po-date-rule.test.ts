import { describe, expect, test } from 'vitest';
import {
  deliveryBroughtForward,
  deliveryNeedsPurchaserOk,
  processingDateFrozenByPo,
  PROCESSING_DATE_PO_LOCKED,
  PURCHASER_OK_REQUIRED,
} from './so-po-date-rule';

describe('processingDateFrozenByPo', () => {
  test('HC-SO-2609-395: a PO holds 2026-09-30, moving it to 2026-10-10 is refused', () => {
    expect(processingDateFrozenByPo({ storedProc: '2026-09-30', nextProc: '2026-10-10', hasLivePo: true })).toBe(true);
  });
  test('clearing it under a PO is refused too', () => {
    expect(processingDateFrozenByPo({ storedProc: '2026-09-30', nextProc: '', hasLivePo: true })).toBe(true);
  });
  test('the same date is not a change', () => {
    expect(processingDateFrozenByPo({ storedProc: '2026-09-30', nextProc: '2026-09-30', hasLivePo: true })).toBe(false);
  });
  test('a first Processing Date on a legacy order with a PO is allowed', () => {
    expect(processingDateFrozenByPo({ storedProc: '', nextProc: '2026-10-10', hasLivePo: true })).toBe(false);
  });
  test('no PO, no freeze', () => {
    expect(processingDateFrozenByPo({ storedProc: '2026-09-30', nextProc: '2026-10-10', hasLivePo: false })).toBe(false);
  });
});

describe('deliveryNeedsPurchaserOk', () => {
  test('postponing is Logistic alone', () => {
    expect(deliveryNeedsPurchaserOk({ storedDeliv: '2026-10-20', nextDeliv: '2026-10-30', hasLivePo: true })).toBe(false);
  });
  test('bringing it forward under a PO needs the Purchaser', () => {
    expect(deliveryNeedsPurchaserOk({ storedDeliv: '2026-10-20', nextDeliv: '2026-10-15', hasLivePo: true })).toBe(true);
  });
  test('bringing it forward with no PO stays Logistic alone', () => {
    expect(deliveryNeedsPurchaserOk({ storedDeliv: '2026-10-20', nextDeliv: '2026-10-15', hasLivePo: false })).toBe(false);
  });
  test('a request that does not touch the Delivery Date needs nothing', () => {
    expect(deliveryNeedsPurchaserOk({ storedDeliv: '2026-10-20', nextDeliv: null, hasLivePo: true })).toBe(false);
  });
  test('a first date or a cleared date is not "earlier"', () => {
    expect(deliveryBroughtForward('', '2026-10-15')).toBe(false);
    expect(deliveryBroughtForward('2026-10-20', '')).toBe(false);
  });
});

test('refusal messages stay under the 200-character client limit', () => {
  expect(PROCESSING_DATE_PO_LOCKED.message.length).toBeLessThan(200);
  expect(PURCHASER_OK_REQUIRED.message.length).toBeLessThan(200);
});

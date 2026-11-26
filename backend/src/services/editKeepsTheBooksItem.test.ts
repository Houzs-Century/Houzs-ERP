import { describe, expect, it } from 'vitest';
import { composeDetails, composeEdit, ItemCodeError } from './autocount-writeback';

const AMBIGUOUS = 'DIVAN ONLY-(Q)';
const CREDITOR_WITHOUT_IT = '400-H003';

const line = (over: Record<string, unknown> = {}) => ({
  item_code: AMBIGUOUS,
  item_group: 'bedframe',
  qty: 1,
  unit_price_sen: 0,
  location: 'KL',
  ...over,
} as never);

describe('an edit does not refuse a code it will not send', () => {
  it('composes an edit for a KEYED line whose code resolves to several items', () => {
    const payload = composeEdit('PO', 'HC-PO-006690', {}, [line({ linked_ac_dtlkey: 640589 })],
      { supplierCode: CREDITOR_WITHOUT_IT });
    expect(payload.Lines).toHaveLength(1);
    expect(payload.Lines[0].DtlKey).toBe(640589);
    expect(payload.Lines[0].ItemCode).toBeUndefined();
  });

  it('STILL refuses a KEYLESS line, because that one is appended WITH its code', () => {
    expect(() => composeEdit('PO', 'HC-PO-006690', {}, [line()],
      { supplierCode: CREDITOR_WITHOUT_IT })).toThrow();
  });

  it('STILL refuses on a CREATE, where every code is sent', () => {
    expect(() => composeDetails([line({ linked_ac_dtlkey: 640589 })],
      { supplierCode: CREDITOR_WITHOUT_IT })).toThrow(ItemCodeError);
  });
});

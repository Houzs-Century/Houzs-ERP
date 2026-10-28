// An edit was refused for a code it was never going to send.
//
// composeEdit strips ItemCode from every keyed line — AUTOCOUNT OWNS THE ITEM ON
// A LINE IT ALREADY HOLDS — and then asked composeDetails to resolve that code
// first anyway. HC-PO-006690 was refused because `DIVAN ONLY-(Q)` resolves to
// four book items and none is under its creditor.
import { describe, expect, it } from 'vitest';
import { composeDetails, composeEdit, ItemCodeError } from './autocount-writeback';

/* The live shape. `DIVAN ONLY-(Q)` exists under four creditors — AERO-, HOK-,
   NB- and NK- — and with NO creditor named the resolver picks one happily. It
   refuses only when a creditor IS named and holds none of them, which is
   HC-PO-006690's: measured 2026-09-09, `400-H003` refuses and `400-O002` does
   not. So every case here names the creditor; without it there is nothing to
   refuse and the test would pass for the wrong reason. */
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
    /* The line goes, and it carries the book's key and NOT an item code — which
       is the whole reason resolving one was pointless. */
    expect(payload.Lines[0].DtlKey).toBe(640589);
    expect(payload.Lines[0].ItemCode).toBeUndefined();
  });

  it('STILL refuses a KEYLESS line, because that one is appended WITH its code', () => {
    /* The half that must not move: a keyless line on an edit is a new line in a
       licensed ledger, and it carries its ItemCode. An unresolvable one there
       is a real refusal. */
    expect(() => composeEdit('PO', 'HC-PO-006690', {}, [line()],
      { supplierCode: CREDITOR_WITHOUT_IT })).toThrow();
  });

  it('STILL refuses on a CREATE, where every code is sent', () => {
    expect(() => composeDetails([line({ linked_ac_dtlkey: 640589 })],
      { supplierCode: CREDITOR_WITHOUT_IT })).toThrow(ItemCodeError);
  });
});

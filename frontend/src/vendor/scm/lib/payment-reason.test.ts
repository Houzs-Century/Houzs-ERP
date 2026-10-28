/* When a payment action asks for a reason, and in what words (docs/bugs/0785,
   docs/bugs/0888). Pinned here because both screens read this one module: a
   wrong answer here asks the Owner on every payment or never asks Finance. */
import { describe, expect, it } from 'vitest';
import {
  AMEND_ASK_BODY, HOLDER_ASK_BODY, owesPaymentReason, paymentReasonAsk, reasonWhyFor,
} from './payment-reason';

describe('owesPaymentReason — the literal holding of the key', () => {
  it('a role that names the key owes a reason on everything', () => {
    expect(owesPaymentReason({ permissions: ['scm.so_payment.amend'] })).toBe(true);
    expect(owesPaymentReason({ permissions: ['scm.so_payment.amend', '*'] })).toBe(true);
  });

  it('the wildcard alone does not — the Owner is not a holder', () => {
    expect(owesPaymentReason({ permissions: ['*'] })).toBe(false);
    expect(owesPaymentReason(null)).toBe(false);
  });
});

describe('reasonWhyFor — which rule is asking', () => {
  it('a holder is asked on every row, whatever opened it', () => {
    expect(reasonWhyFor('same_day', true)).toBe('holder');
    expect(reasonWhyFor('draft', true)).toBe('holder');
    expect(reasonWhyFor('amend', true)).toBe('holder');
    expect(reasonWhyFor(null, true)).toBe('holder');
  });

  it('a non-holder is asked only when the amend right opened the door', () => {
    expect(reasonWhyFor('amend', false)).toBe('amend');
    expect(reasonWhyFor('same_day', false)).toBeNull();
    expect(reasonWhyFor('draft', false)).toBeNull();
    expect(reasonWhyFor(null, false)).toBeNull();
  });
});

describe('paymentReasonAsk — the words', () => {
  it('names the action in the title and the rule in the body, and REQUIRES the input', () => {
    expect(paymentReasonAsk('edit', 'amend')).toMatchObject({
      title: 'Why is this payment being corrected?', body: AMEND_ASK_BODY,
      input: { label: 'Reason', required: true }, confirmLabel: 'Save changes',
    });
    expect(paymentReasonAsk('add', 'holder')).toMatchObject({ title: 'Why is this payment being recorded?', body: HOLDER_ASK_BODY, confirmLabel: 'Save payment' });
    expect(paymentReasonAsk('proof', 'holder').title).toBe('Why is this proof being attached?');
    expect(paymentReasonAsk('proof-replace', 'holder').title).toBe('Why is this proof being replaced?');
  });

  it('only a removal is dangerous', () => {
    expect(paymentReasonAsk('delete', 'amend')).toMatchObject({ title: 'Why is this payment being removed?', danger: true });
    expect(paymentReasonAsk('add', 'holder').danger).toBeUndefined();
  });

  it("the holder's sentence says where the action will be listed", () => {
    expect(HOLDER_ASK_BODY).toContain('Accounting › Corrections');
  });
});

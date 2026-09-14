/* When a payment write owes a reason (docs/bugs/0785, docs/bugs/0888), decided
   against a caller shaped like the real context. Pinned here because the four
   routes share this one rule: a wrong answer asks the Owner on every payment,
   or lets Finance through without a word. */
import { describe, expect, it } from 'vitest';
import { paymentReasonRule } from './so-payment-reason';
import { AMEND_SOURCE, KEY_HOLDER_REASON_REQUIRED, REASON_REQUIRED } from '../../acc/payment-corrections';

const caller = (permissions: string[]) => ({ get: () => ({ id: 1, permissions }) }) as unknown as Parameters<typeof paymentReasonRule>[0];
const FINANCE = caller(['projects.read', 'scm.so_payment.amend']);
const OWNER = caller(['*']);
const SALES = caller(['sales.read']);
const CHEW = caller(['scm.so_payment.amend', '*']);

describe('a role that names the key', () => {
  it('owes a reason on every write, refuses without one in its own words, and marks the row', () => {
    expect(paymentReasonRule(FINANCE, { reason: '' })).toEqual({ keyHolder: true, owed: true, refusal: KEY_HOLDER_REASON_REQUIRED, audit: {} });
    expect(paymentReasonRule(FINANCE, { reason: '  Balance collected on delivery ' }))
      .toEqual({ keyHolder: true, owed: true, refusal: null, audit: { source: AMEND_SOURCE, note: 'Balance collected on delivery' } });
  });

  it('holds it beside the wildcard too — the owner on a custom role', () => {
    expect(paymentReasonRule(CHEW, { reason: undefined }).refusal).toBe(KEY_HOLDER_REASON_REQUIRED);
  });
});

describe('the wildcard alone', () => {
  it('owes nothing on a write the window let through — a same-day fix, an add', () => {
    expect(paymentReasonRule(OWNER, { reason: undefined })).toEqual({ keyHolder: false, owed: false, refusal: null, audit: {} });
    expect(paymentReasonRule(OWNER, { reason: undefined, viaAmend: false }).owed).toBe(false);
  });

  it('owes the amend reason when the amend right opened the door, as before', () => {
    expect(paymentReasonRule(OWNER, { reason: undefined, viaAmend: true })).toEqual({ keyHolder: false, owed: true, refusal: REASON_REQUIRED, audit: {} });
    expect(paymentReasonRule(OWNER, { reason: 'Keyed twice', viaAmend: true }).audit).toEqual({ source: AMEND_SOURCE, note: 'Keyed twice' });
  });
});

describe('a role without the key', () => {
  it('owes nothing on the day, and never reaches the amend door', () => {
    expect(paymentReasonRule(SALES, { reason: undefined })).toEqual({ keyHolder: false, owed: false, refusal: null, audit: {} });
  });

  it('a reason volunteered where none is owed is not written as a correction', () => {
    expect(paymentReasonRule(SALES, { reason: 'just because' }).audit).toEqual({});
  });
});

describe('the reason itself', () => {
  it('is trimmed and capped at 500 characters — a query-borne one has no schema to cap it', () => {
    const long = 'x'.repeat(600);
    expect((paymentReasonRule(FINANCE, { reason: long }).audit as { note: string }).note).toHaveLength(500);
    expect(paymentReasonRule(FINANCE, { reason: '   ' }).refusal).toBe(KEY_HOLDER_REASON_REQUIRED);
  });
});

/* The voucher header says what kind of paper it is, not "Purpose: Other"
   (owner 2026-09-07). */
import { describe, expect, it } from 'vitest';
import { pvTypeLabel, pvTypeOf } from './pv-type-label';

describe('pvTypeLabel — the document kind in the owner\'s words', () => {
  it('an AP Payment says so; a plain voucher — stored OTHER, or the legacy FREIGHT — is a Payment Voucher', () => {
    expect(pvTypeLabel('SUPPLIER_PAYMENT')).toBe('AP Payment');
    expect(pvTypeLabel('OTHER')).toBe('Payment Voucher');
    expect(pvTypeLabel('FREIGHT')).toBe('Payment Voucher');
    expect(pvTypeLabel(null)).toBe('Payment Voucher');
  });

  it('the edit form offers two kinds only; FREIGHT reads as a plain voucher', () => {
    expect(pvTypeOf('SUPPLIER_PAYMENT')).toBe('SUPPLIER_PAYMENT');
    expect(pvTypeOf('FREIGHT')).toBe('OTHER');
    expect(pvTypeOf(undefined)).toBe('OTHER');
  });
});


import { describe, it, expect } from 'vitest';
import { withoutFrozenHeaderFields } from './so-amendment-header';
import { diffHeaderPayload } from './so-header-diff';

const patch = {
  debtorName: 'Hee Wai loon',
  phone: '+60123456789',
  email: 'hee@example.com',
  address1: '51, Jln Utara',
  address2: 'Pjs 12',
  postcode: '46200',
  city: 'Petaling Jaya',
  customerState: 'Selangor',
  processingDate: '2026-08-25',
  customerDeliveryDate: '2026-09-01',
  note: 'ring the bell',
  emergencyContactName: 'Fatimah',
  customerType: 'EXISTING',
};

describe('withoutFrozenHeaderFields', () => {
  it('carries NO frozen column at all — the direct PATCH cannot trip the lock on one', () => {
    const out = withoutFrozenHeaderFields(patch);
    for (const key of ['debtorName', 'phone', 'email', 'address1', 'address2', 'postcode',
      'city', 'customerState', 'processingDate', 'customerDeliveryDate']) {
      expect(key in out, key).toBe(false);
    }
  });

  it('leaves the FREE fields alone — they are what the direct PATCH exists to save', () => {
    const out = withoutFrozenHeaderFields(patch);
    expect(out.note).toBe('ring the bell');
    expect(out.emergencyContactName).toBe('Fatimah');
    expect(out.customerType).toBe('EXISTING');
  });

  it('drops salesLocation too — DERIVED, re-derived server-side from the approved State', () => {
    const out = withoutFrozenHeaderFields({ ...patch, salesLocation: 'WH-KL' });
    expect('salesLocation' in out).toBe(false);
  });

  it('a stored value with surrounding whitespace never reaches the direct PATCH', () => {
    const seeded = { debtorName: 'MR LIM ', address1: '26, JLN BU4/9 BANDAR UTAMA ', note: '' };
    const outgoing = { debtorName: 'MR LIM ', address1: '26, JLN BU4/9 BANDAR UTAMA ', note: '' };
    expect(diffHeaderPayload(seeded, withoutFrozenHeaderFields(outgoing))).toEqual({});
  });

  it('a FREE edit beside an untouched frozen field still goes out alone', () => {
    const seeded = { debtorName: 'MR LIM ', note: '' };
    const outgoing = { debtorName: 'MR LIM ', note: 'leave at guard house' };
    expect(diffHeaderPayload(seeded, withoutFrozenHeaderFields(outgoing)))
      .toEqual({ note: 'leave at guard house' });
  });

  it('does not mutate its input', () => {
    const input = { ...patch };
    withoutFrozenHeaderFields(input);
    expect(input).toEqual(patch);
  });
});

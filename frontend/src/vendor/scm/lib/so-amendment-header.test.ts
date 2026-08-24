// Cover for the HEADER half of an SO amendment — the frozen-field revert.
//
// The module had no tests. The gap mattered: withFrozenHeaderFieldsReverted
// reverts EVERY key in AMENDABLE_HEADER_KEYS that is present in the patch, and
// it reads each original from the `original` argument. A caller that collects a
// key into the patch but omits it from `original` therefore does not revert
// that column — it NULLS it (outValue(undefined) === null), which reads to the
// server as a genuine change to a frozen column.
//
// That is a caller-shape bug the type system cannot catch: AmendableHeaderValues
// is Partial<Record<...>>, so an omitted key type-checks.

import { describe, it, expect } from 'vitest';
import { withFrozenHeaderFieldsReverted } from './so-amendment-header';

/* The header patch both surfaces build for a locked SO. Address lines joined
   the frozen set on 2026-07-27 (two-lane phase 2), so they appear here. */
const patch = {
  debtorName: 'Hee Wai loon',
  phone: '+60123456789',
  address1: '51, Jln Utara',
  address2: 'Pjs 12',
  postcode: '46200',
  city: 'Petaling Jaya',
  customerState: 'Selangor',
  processingDate: '2026-08-25',
  customerDeliveryDate: '2026-09-01',
};

/* What the SO actually holds — the values a revert must restore. Customer
   name / phone joined the frozen set 2026-08-21 (owner: "需要加上更新客户
   信息"), so they carry originals here like the address block does. */
const original = {
  debtorName: 'Hee Wai Loon',
  phone: '+60129999999',
  address1: '51, Jln Utara',
  address2: 'Pjs 12',
  postcode: '46200',
  city: 'Petaling Jaya',
  customerState: 'Selangor',
  processingDate: '2026-08-20',
  customerDeliveryDate: '2026-08-30',
};

describe('withFrozenHeaderFieldsReverted', () => {
  it('restores every frozen column to its saved value, so the direct PATCH carries no frozen change', () => {
    const out = withFrozenHeaderFieldsReverted(patch, original);
    expect(out.address1).toBe('51, Jln Utara');
    expect(out.address2).toBe('Pjs 12');
    expect(out.processingDate).toBe('2026-08-20');
    expect(out.customerDeliveryDate).toBe('2026-08-30');
    // Customer info is frozen since 2026-08-21: the requested change rides the
    // amendment while the direct-PATCH half reverts to what the SO holds.
    expect(out.debtorName).toBe('Hee Wai Loon');
    expect(out.phone).toBe('+60129999999');
  });

  it('leaves the FREE fields alone — they are what the direct PATCH exists to save', () => {
    const out = withFrozenHeaderFieldsReverted(
      { ...patch, note: 'ring the bell', emergencyContactName: 'Fatimah' },
      original,
    );
    expect(out.note).toBe('ring the bell');
    expect(out.emergencyContactName).toBe('Fatimah');
  });

  /* THE MOBILE DEFECT (2026-08-21). MobileNewSO collected address1/address2
     into the amendment's header changes but passed an `original` carrying only
     the five date/location keys. address1 is in the patch and in
     AMENDABLE_HEADER_KEYS, so it was reverted to outValue(undefined) === null.
     The subsequent diff then saw null vs the stored street and sent it, and the
     server 409'd so_locked_processing on a column the operator never touched —
     blocking EVERY mobile amendment on a locked SO that has an address. */
  it('an original that omits a collected key NULLS it — the shape that broke mobile', () => {
    const out = withFrozenHeaderFieldsReverted(patch, {
      processingDate: '2026-08-20',
      customerDeliveryDate: '2026-08-30',
      customerState: 'Selangor',
      postcode: '46200',
      city: 'Petaling Jaya',
    });
    expect(out.address1).toBeNull();
    expect(out.address2).toBeNull();
  });

  it('drops salesLocation entirely — it is DERIVED and must never reach the lock diff', () => {
    const out = withFrozenHeaderFieldsReverted({ ...patch, salesLocation: 'WH-KL' }, original);
    expect('salesLocation' in out).toBe(false);
  });
});

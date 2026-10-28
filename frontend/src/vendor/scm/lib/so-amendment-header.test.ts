// so-amendment-header.test — the direct-save half of a locked-SO edit.
//
// HISTORY OF THIS HELPER, because it has now bitten twice through the SAME seam:
//   * 2026-08-21 (ledger 0488): mobile passed an `original` missing two keys, the
//     "revert" wrote NULL for them, and every mobile amendment on an SO with an
//     address 409'd so_locked_processing.
//   * 2026-09-12 (ledger, this PR): desktop passed a complete `original`, but the
//     revert TRIMMED it (outValue) while the pristine payload held the raw stored
//     value. AutoCount-imported rows carry trailing spaces ("MR LIM "), so the
//     "reverted" name differed from the seeded one, the diff sent it, and the
//     server 409'd — on a colour-only edit the operator never touched the name in.
// Both are the same defect: a revert must reproduce the seeded value BYTE FOR
// BYTE or it becomes an edit. The helper now DROPS every frozen key instead of
// reverting it — there is nothing to reproduce, so there is nothing to get wrong.

import { describe, it, expect } from 'vitest';
import { withoutFrozenHeaderFields } from './so-amendment-header';
import { diffHeaderPayload } from './so-header-diff';

/* The header patch both surfaces build for a locked SO. */
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

  /* THE DESKTOP DEFECT (2026-09-12, HC-SO-013497). Stored debtor_name is
     "MR LIM " (trailing space, AutoCount import). The operator changed ONE
     line's fabric colour. The old revert wrote outValue("MR LIM ") === "MR LIM"
     into the patch; the pristine payload held "MR LIM "; diffHeaderPayload
     (deliberately no trim) sent debtorName; the server's raw compare 409'd.
     With the frozen keys dropped, the diff has nothing to compare. */
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

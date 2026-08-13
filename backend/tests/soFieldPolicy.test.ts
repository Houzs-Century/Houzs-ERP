// ----------------------------------------------------------------------------
// so-field-policy — SERVER-SIDE ENFORCEMENT of the SO edit split.
//
// The owner's ruling: FREE fields save straight to the database; CONTROLLED
// fields raise an amendment instead. The UI expresses that by disabling inputs,
// but the UI is not the control — a client that posts a CONTROLLED field
// directly must be REJECTED. lockedColumnsChanged() is the predicate the PATCH
// handler calls to do that, and this suite exercises it directly rather than a
// re-implementation that could drift from what ships.
// ----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import {
  SO_HEADER_FIELD_POLICY,
  soProcessingLockColumns,
  soAmendableHeaderFields,
  soAmendableHeaderKeys,
  soHeaderFieldClass,
  lockedColumnsChanged,
  paymentRowMutable,
  PAYMENT_WINDOW_CLOSED_MESSAGE,
} from '../src/scm/shared/so-field-policy';

/* A pristine locked SO header, as `before` would look inside the handler. */
const BEFORE: Record<string, unknown> = {
  processing_date: '2026-07-10',
  customer_delivery_date: '2026-08-01',
  customer_state: 'Selangor',
  sales_location: 'SELANGOR',
  postcode: '47500',
  city: 'Subang Jaya',
  phone: '0123456789',
  email: 'a@b.com',
  address1: '12 Jalan Satu',
  address2: 'Taman Dua',
  debtor_name: 'Ali bin Abu',
  note: 'ring the bell',
  emergency_contact_name: 'Siti',
};

describe('lockedColumnsChanged — a CONTROLLED field posted directly is rejected', () => {
  it('rejects a Delivery Date change', () => {
    expect(lockedColumnsChanged({ customer_delivery_date: '2026-09-01' }, BEFORE))
      .toEqual(['customer_delivery_date']);
  });

  it('rejects a State change', () => {
    expect(lockedColumnsChanged({ customer_state: 'Johor' }, BEFORE))
      .toEqual(['customer_state']);
  });

  it('rejects a Postcode change', () => {
    expect(lockedColumnsChanged({ postcode: '80000' }, BEFORE)).toEqual(['postcode']);
  });

  it('rejects a City change — the gap this policy closed', () => {
    /* City was disabled by the mobile UI and named in its lock copy, but was in
       NEITHER backend set. So a client that simply POSTED city wrote straight
       through on a locked, PO'd SO, and no amendment could carry it either.
       This assertion is the regression guard for that. */
    expect(lockedColumnsChanged({ city: 'Petaling Jaya' }, BEFORE)).toEqual(['city']);
  });

  it('rejects the DERIVED sales_location if a client sends a changed one', () => {
    expect(lockedColumnsChanged({ sales_location: 'JOHOR' }, BEFORE))
      .toEqual(['sales_location']);
  });

  it('rejects an address change — two-lane phase 2 (owner 2026-07-27)', () => {
    /* The owner's category-2 ruling reversed the earlier "address lines save
       straight away": a street/unit change on a locked SO is a Logistics-
       approved amendment now. This is the regression guard for the reversal. */
    expect(lockedColumnsChanged({ address1: '99 Jalan Baru', address2: 'Taman Baru' }, BEFORE).sort())
      .toEqual(['address1', 'address2']);
    expect(lockedColumnsChanged({ replacement_disposal: 'Old sofa 1pc' }, BEFORE))
      .toEqual(['replacement_disposal']);
  });

  it('reports EVERY offending column, not just the first', () => {
    const changed = lockedColumnsChanged(
      { customer_state: 'Johor', postcode: '80000', city: 'JB', phone: '0199999999' },
      BEFORE,
    );
    expect(changed.sort()).toEqual(['city', 'customer_state', 'postcode']);
  });
});

describe('lockedColumnsChanged — FREE fields pass straight through', () => {
  it('lets the owner-ruled free-edit fields through on a locked SO', () => {
    // Owner: payments + contact details stay free — the amendment gate exists
    // for what gets DELIVERED or CHARGED, and routing contact details through
    // approval means nobody updates them. The delivery ADDRESS left this list
    // 2026-07-27 (two-lane phase 2) — see the CONTROLLED rejection test above.
    const patch = {
      phone: '0177777777',
      email: 'new@b.com',
      debtor_name: 'Ali A. Abu',
      note: 'leave with guard',
      emergency_contact_name: 'Fatimah',
    };
    expect(lockedColumnsChanged(patch, BEFORE)).toEqual([]);
  });

  it('treats an unchanged CONTROLLED column as no change', () => {
    // This is what lets a client send the amendment's direct-save half with the
    // frozen columns reverted to their originals rather than splitting requests.
    expect(lockedColumnsChanged(
      { customer_state: 'Selangor', postcode: '47500', city: 'Subang Jaya', phone: '011' },
      BEFORE,
    )).toEqual([]);
  });

  it('collapses null / undefined / empty-string the same way the route does', () => {
    // A form re-sending a blank field as '' must not read as a change from null.
    expect(lockedColumnsChanged({ postcode: '' }, { ...BEFORE, postcode: null })).toEqual([]);
    expect(lockedColumnsChanged({ city: '' }, { ...BEFORE, city: undefined })).toEqual([]);
  });

  it('cannot be tripped by a column that is never sent', () => {
    // `col in updates` semantics — load-bearing for the revert-and-omit flow.
    expect(lockedColumnsChanged({}, BEFORE)).toEqual([]);
  });
});

describe('lockedColumnsChanged — the Remove-Processing-Date escape hatch', () => {
  it('lets a super-admin CLEAR the processing + delivery dates', () => {
    expect(lockedColumnsChanged(
      { processing_date: '', customer_delivery_date: '' },
      BEFORE,
      { superAdminClearsProcessingDate: true },
    )).toEqual([]);
  });

  it('still rejects the same admin MOVING the date instead of clearing it', () => {
    // To reschedule a locked SO: remove the date first (unlocks), then set the
    // new pair. Moving it directly stays a 409 even for a super-admin.
    expect(lockedColumnsChanged(
      { processing_date: '2026-07-25' },
      BEFORE,
      { superAdminClearsProcessingDate: true },
    )).toEqual(['processing_date']);
  });

  it('does not let the escape hatch leak onto State / Postcode / City', () => {
    expect(lockedColumnsChanged(
      { customer_state: 'Johor', postcode: '', city: '' },
      BEFORE,
      { superAdminClearsProcessingDate: true },
    ).sort()).toEqual(['city', 'customer_state', 'postcode']);
  });
});

describe('so-field-policy — derived constants stay coherent', () => {
  it('puts every CONTROLLED and DERIVED column in the lock set', () => {
    const locked = soProcessingLockColumns();
    for (const f of SO_HEADER_FIELD_POLICY) {
      expect(locked.has(f.column), `${f.column} missing from the lock set`).toBe(true);
    }
  });

  it('offers every CONTROLLED field to the amendment, and no DERIVED one', () => {
    /* THE INVARIANT: a column frozen with no amendment path is a field nobody
       can ever change again. A DERIVED one must be excluded instead, because
       the server recomputes it and a client that SENDS it trips the lock. */
    const amendable = soAmendableHeaderFields();
    for (const f of SO_HEADER_FIELD_POLICY) {
      if (f.cls === 'CONTROLLED') {
        expect(amendable[f.payloadKey], `${f.payloadKey} not amendable`).toBe(f.column);
      } else {
        expect(amendable[f.payloadKey], `${f.payloadKey} must not be amendable`).toBeUndefined();
      }
    }
    expect(soAmendableHeaderKeys()).not.toContain('salesLocation');
  });

  it('classifies unknown keys as FREE — the documented default, not a miss', () => {
    expect(soHeaderFieldClass('phone')).toBe('FREE');
    expect(soHeaderFieldClass('venueId')).toBe('FREE');
    expect(soHeaderFieldClass('city')).toBe('CONTROLLED');
    expect(soHeaderFieldClass('salesLocation')).toBe('DERIVED');
  });
});

describe('paymentRowMutable — the same-day window (Owner 2026-07-19)', () => {
  const TODAY = '2026-07-19';

  it('allows edit/delete on the day the row was keyed in', () => {
    expect(paymentRowMutable(TODAY, TODAY, false).mutable).toBe(true);
  });

  it('LOCKS the row from the next day onward', () => {
    const r = paymentRowMutable('2026-07-18', TODAY, false);
    expect(r.mutable).toBe(false);
    expect(r.problem).toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  it('keys off the CREATION day, so an old row stays locked', () => {
    /* The exploit this closes: if the window keyed off the document's payment
       date, editing an old payment's date to today would unlock its own
       deletion — the edit and the delete authorising each other. Callers pass
       mytDateOf(created_at); this asserts an old creation day stays shut. */
    expect(paymentRowMutable('2026-01-04', TODAY, false).mutable).toBe(false);
  });

  it('exempts DRAFT sales orders, matching the long-standing PATCH exemption', () => {
    expect(paymentRowMutable('2026-01-04', TODAY, true).mutable).toBe(true);
  });

  it('explains why in plain language that survives the client error filter', () => {
    const msg = paymentRowMutable('2026-07-18', TODAY, false).problem as string;
    expect(msg).toMatch(/day it was keyed in/i);
    expect(msg).not.toMatch(/[{}]/);
    expect(msg.length).toBeLessThan(200);
  });
});

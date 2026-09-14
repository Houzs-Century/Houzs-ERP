// The Delivery Order header lock rule (owner ruling 2026-09-14) — one module the
// server's PATCH and both screens read. These pin the rule itself; the route
// behaviour is pinned in routes/doHeaderFieldLock.test.ts.
import { describe, expect, it } from 'vitest';
import {
  DO_HEADER_OPEN_COLS, DO_HEADER_LOCK_COLS, DO_HEADER_LOCK_BODY_KEYS,
  doHeaderLocked, doLockedHeaderChanges, isDoHeaderKeyLocked, sameDoHeaderValue, stripLockedDoHeaderKeys,
} from './do-header-lock';

// The exhaustive partition against the route's own PATCH map is
// tests/doHeaderLockPartition.test.ts (it reads the route file from disk).

describe('the owner ruling 2026-09-14, as data', () => {
  it('locks customer, address, contact and commercial fields', () => {
    for (const col of ['debtor_code', 'debtor_name', 'phone', 'email', 'address1', 'address2', 'city',
      'state', 'customer_state', 'postcode', 'customer_country', 'emergency_contact_name',
      'emergency_contact_phone', 'emergency_contact_relationship', 'sales_location', 'currency',
      'branding', 'customer_delivery_date', 'note', 'notes']) {
      expect(DO_HEADER_LOCK_COLS.has(col), col).toBe(true);
    }
  });

  it('leaves the dispatch-execution fields open', () => {
    for (const col of ['driver_id', 'driver_name', 'vehicle', 'arrival_at', 'departure_at',
      'shipout_date', 'customer_delivered_date', 'time_range', 'delivery_substatus']) {
      expect(DO_HEADER_OPEN_COLS.has(col), col).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('doHeaderLocked reads has_children strictly', () => {
    expect(doHeaderLocked({ has_children: true })).toBe(true);
    expect(doHeaderLocked({ has_children: false })).toBe(false);
    expect(doHeaderLocked({ has_children: 'true' })).toBe(false);
    expect(doHeaderLocked(null)).toBe(false);
  });

  it('isDoHeaderKeyLocked only bites when the DO is locked', () => {
    expect(isDoHeaderKeyLocked('phone', true)).toBe(true);
    expect(isDoHeaderKeyLocked('phone', false)).toBe(false);
    expect(isDoHeaderKeyLocked('driverName', true)).toBe(false);
    expect(DO_HEADER_LOCK_BODY_KEYS.has('doDate') && DO_HEADER_LOCK_BODY_KEYS.has('soDate')).toBe(true);
  });

  it('stripLockedDoHeaderKeys drops locked keys only when locked', () => {
    const body = { debtorName: 'A', phone: '1', driverName: 'D', expectedDeliveryAt: '2026-09-01' };
    expect(stripLockedDoHeaderKeys(body, false)).toEqual(body);
    expect(stripLockedDoHeaderKeys(body, true)).toEqual({ driverName: 'D', expectedDeliveryAt: '2026-09-01' });
  });

  it('sameDoHeaderValue: blank, phone and date are compared the way a person would', () => {
    expect(sameDoHeaderValue('note', null, '')).toBe(true);
    expect(sameDoHeaderValue('phone', '012-345 6789', '+60123456789')).toBe(true);
    expect(sameDoHeaderValue('phone', '012-345 6789', '+60199999999')).toBe(false);
    expect(sameDoHeaderValue('customer_delivery_date', '2026-09-01T00:00:00+00:00', '2026-09-01')).toBe(true);
    expect(sameDoHeaderValue('customer_delivery_date', '2026-09-01', '2026-09-02')).toBe(false);
    expect(sameDoHeaderValue('address1', 'A', 'B')).toBe(false);
  });

  it('doLockedHeaderChanges lists only locked columns that genuinely change', () => {
    const before = { phone: '012-345 6789', address1: 'Old', driver_name: 'X', notes: null };
    expect(doLockedHeaderChanges({ phone: '+60123456789', driver_name: 'Y', notes: '' }, before)).toEqual([]);
    expect(doLockedHeaderChanges({ address1: 'New', driver_name: 'Y' }, before)).toEqual(['address1']);
  });
});

import { describe, it, expect } from 'vitest';
import { changedPoIdentityLockCols, poIdentityLockedRefusal, PO_IDENTITY_LOCK_COLS } from './po-identity-lock';

describe('changedPoIdentityLockCols', () => {
  const before = {
    supplier_id: 'sup-1', currency: 'MYR', purchase_location_id: 'loc-1',
    po_date: '2026-08-01', expected_at: '2026-09-01', notes: 'old',
  };

  it('returns [] when only PO-own fields change (dates/notes save with a GRN)', () => {
    expect(changedPoIdentityLockCols({ notes: 'new', expected_at: '2026-10-01', po_date: '2026-08-05' }, before)).toEqual([]);
  });

  it('flags a supplier change', () => {
    expect(changedPoIdentityLockCols({ supplier_id: 'sup-2' }, before)).toEqual(['supplier_id']);
  });

  it('flags currency and purchase location together', () => {
    const cols = changedPoIdentityLockCols({ currency: 'USD', purchase_location_id: 'loc-2' }, before);
    expect(cols.sort()).toEqual(['currency', 'purchase_location_id']);
  });

  it('does not flag an inherited field re-sent unchanged (blank/null collapse)', () => {
    expect(changedPoIdentityLockCols({ supplier_id: 'sup-1', currency: 'MYR' }, before)).toEqual([]);
  });

  it('only these three columns are inherited', () => {
    expect([...PO_IDENTITY_LOCK_COLS].sort()).toEqual(['currency', 'purchase_location_id', 'supplier_id']);
  });

  it('the refusal names the fields and the cancel-to-source remedy', () => {
    const r = poIdentityLockedRefusal(['supplier_id']);
    expect(r.error).toBe('po_identity_locked');
    expect(r.message).toContain('supplier');
    expect(r.message).toContain('cancel the GRN');
    expect(r.fields).toEqual(['supplier_id']);
  });
});

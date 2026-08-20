import { describe, expect, it } from 'vitest';
import { isDefaultMrpView, MRP_REFRESH_COMPANY_IDS } from '../src/scm/lib/mrp-snapshot';

/* The snapshot is served ONLY for the exact params it was computed with (no
   category/warehouse filter, undated hidden) — catFilter/whFilter change the
   allocation inputs, not just the output rows, so a stored full result cannot be
   post-filtered. isDefaultMrpView is the gate that keeps that correct. */
describe('isDefaultMrpView', () => {
  it('is true ONLY for the default view (no filters, undated hidden)', () => {
    expect(isDefaultMrpView(null, null, false)).toBe(true);
  });

  it('is false when any filter or the undated toggle is active', () => {
    expect(isDefaultMrpView('SOFA', null, false)).toBe(false);   // category filter
    expect(isDefaultMrpView(null, 'wh-1', false)).toBe(false);   // warehouse filter
    expect(isDefaultMrpView(null, null, true)).toBe(false);      // undated shown
    expect(isDefaultMrpView('SOFA', 'wh-1', true)).toBe(false);  // all three
  });
});

describe('MRP_REFRESH_COMPANY_IDS', () => {
  it('covers the two live tenants', () => {
    expect([...MRP_REFRESH_COMPANY_IDS].sort()).toEqual([1, 2]);
  });
});

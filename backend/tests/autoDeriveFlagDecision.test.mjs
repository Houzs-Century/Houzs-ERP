import { describe, it, expect } from 'vitest';
import { decideFlagWrite } from '../scripts/lib/auto-derive-flag-decision.mjs';

const KEY = 'scm.auto_derive_product_cost';
const call = (over) => decideFlagWrite({ key: KEY, companyId: 1, desired: 'on', existing: null, ...over });

describe('decideFlagWrite', () => {
  it('arms the mechanism for company 1 when no row exists yet', () => {
    expect(call({})).toEqual({ ok: true, action: 'insert', from: null });
  });

  it('updates company 1s own row and reports what it is moving from', () => {
    expect(call({ existing: { value: 'off', company_id: 1 } })).toEqual({ ok: true, action: 'update', from: 'off' });
  });

  // Owner 2026-09-25: the switch is now global and retail is protected at write
  // time (mergeRetailOntoDerivedSeatGrid + company 2's DB trigger), so arming
  // company 2 is no longer forbidden. In practice the single (key) row is owned
  // by company 1 and the global reader arms both; the re-point guard below still
  // stops a second owner from being written.
  it('no longer forbids company 2 (would own the row when none exists)', () => {
    expect(call({ companyId: 2 })).toEqual({ ok: true, action: 'insert', from: null });
  });

  it('still lets company 2 be switched OFF', () => {
    expect(call({ companyId: 2, desired: 'off', existing: { value: 'on', company_id: 2 } }))
      .toEqual({ ok: true, action: 'update', from: 'on' });
  });

  it('refuses to move an existing row to a different company', () => {
    const out = call({ companyId: 3, existing: { value: 'off', company_id: 1 } });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/belongs to company 1/);
  });

  it('requires a real company id and a real value', () => {
    expect(call({ companyId: Number.NaN }).ok).toBe(false);
    expect(call({ companyId: 0 }).ok).toBe(false);
    expect(call({ desired: 'yes' }).ok).toBe(false);
    expect(call({ desired: '' }).ok).toBe(false);
  });
});

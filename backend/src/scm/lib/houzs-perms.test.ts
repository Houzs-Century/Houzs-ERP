/* The SCM caller shims read the REAL Houzs user stashed on `houzsUser`. Pinned:
   the Title's policy row decides "is this person Sales" before the position
   name does — a Sales title whose name does not start with "Sales" (owner
   report 2026-10-07: only the Sales Director could raise a product request)
   must read as Sales here exactly as it does at the login umbrella. */
import { describe, expect, test } from 'vitest';
import { canViewAllSales, isSalesCaller } from './houzs-perms';
import type { PositionPolicyRow } from '../../services/positionPolicyRows';

type Stash = {
  position_name: string | null;
  department_name: string | null;
  position_policy?: PositionPolicyRow | null;
  permissions_set: Set<string>;
};
const ctx = (hu: Stash | null) => ({ get: (k: string) => (k === 'houzsUser' ? hu : undefined) }) as never;
const row = (cohort: PositionPolicyRow['cohort'], profile: PositionPolicyRow['profile'] = null): PositionPolicyRow =>
  ({ position_id: 1, cohort, profile, can_move_money: false, can_write_config: false, is_fleet: false, duty: 'none' } as unknown as PositionPolicyRow);

describe('isSalesCaller', () => {
  test('a Sales-cohort title whose name does not start with "Sales" is Sales', () => {
    expect(isSalesCaller(ctx({ position_name: 'Showroom Consultant', department_name: 'Retail', position_policy: row('sales', 'rep'), permissions_set: new Set() }))).toBe(true);
  });
  test('without a policy row the stable org fields decide', () => {
    expect(isSalesCaller(ctx({ position_name: 'Sales Executive', department_name: null, permissions_set: new Set() }))).toBe(true);
    expect(isSalesCaller(ctx({ position_name: 'Branch Lead', department_name: 'Sales Department', permissions_set: new Set() }))).toBe(true);
    expect(isSalesCaller(ctx({ position_name: 'Storekeeper', department_name: 'Operation Department', permissions_set: new Set() }))).toBe(false);
  });
  test('a policy row that says restricted overrides a Sales-looking name', () => {
    expect(isSalesCaller(ctx({ position_name: 'Sales Support Driver', department_name: null, position_policy: row('restricted'), permissions_set: new Set() }))).toBe(false);
  });
  test('no stashed caller is not Sales', () => {
    expect(isSalesCaller(ctx(null))).toBe(false);
  });
});

describe('canViewAllSales', () => {
  test('a director by policy row sees all, whatever the position name', () => {
    expect(canViewAllSales(ctx({ position_name: 'Head of Retail', department_name: null, position_policy: row('sales', 'director'), permissions_set: new Set() }))).toBe(true);
  });
  test('a rep by policy row does not', () => {
    expect(canViewAllSales(ctx({ position_name: 'Sales Executive', department_name: null, position_policy: row('sales', 'rep'), permissions_set: new Set() }))).toBe(false);
  });
});

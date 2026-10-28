import { describe, it, expect } from 'vitest';
import { derivePosRole, POSITION_SLUG_TO_POS_ROLE } from './pos-staff-role';

describe('derivePosRole — POS role follows the Houzs position (owner 2026-07-24, #104)', () => {
  it('maps every sales-side position to its 2990 POS tier', () => {
    expect(derivePosRole('super_admin', 'sales')).toBe('super_admin');
    expect(derivePosRole('sales_director', 'sales')).toBe('sales_director');
    expect(derivePosRole('sales_manager', 'sales')).toBe('outlet_manager');
    expect(derivePosRole('sales_executive', 'sales')).toBe('sales_executive');
    expect(derivePosRole('sales_person', 'sales')).toBe('sales');
    expect(derivePosRole('sales_trainee', 'sales')).toBe('sales');
  });

  it('leaves non-sales positions on the STORED role (owner: they do not use POS)', () => {
    for (const slug of [
      'hr_manager',
      'finance_manager',
      'admin_assistant',
      'ops_director',
      'ops_manager',
      'ops_executive',
      'purchasing',
      'logistic',
      'storekeeper',
      'driver',
      'helper',
    ]) {
      expect(derivePosRole(slug, 'sales')).toBe('sales');
      expect(derivePosRole(slug, 'admin')).toBe('admin');
    }
  });

  it('falls back to the stored role when the position is missing (unlinked 2990 mirror rows, system row)', () => {
    expect(derivePosRole(null, 'sales_director')).toBe('sales_director');
    expect(derivePosRole(undefined, 'super_admin')).toBe('super_admin');
    expect(derivePosRole('', 'sales')).toBe('sales');
  });

  it('never maps an unknown slug — a renamed/new position cannot silently grant a tier', () => {
    expect(derivePosRole('sales_supremo', 'sales')).toBe('sales');
    expect(Object.keys(POSITION_SLUG_TO_POS_ROLE)).toEqual([
      'super_admin',
      'sales_director',
      'sales_manager',
      'sales_executive',
      'sales_person',
      'sales_trainee',
    ]);
  });

  it('passes the stored role through untouched even when it is null/undefined', () => {
    expect(derivePosRole(null, null)).toBeNull();
    expect(derivePosRole('purchasing', undefined)).toBeUndefined();
  });
});

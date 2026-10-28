import { describe, expect, test } from 'vitest';
import type { DriverRow } from '../../vendor/scm/lib/drivers-queries';
import { driverEditPatch, driverEditUnchanged } from './driverEdit';

const DRIVER: DriverRow = {
  id: 'drv-1',
  driver_code: 'DRV-016',
  name: 'Shamsul fiqri bin samsuddin',
  phone: '+60111234567',
  ic_number: null,
  vehicle: null,
  in_house: true,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
};

const form = (over: Partial<Parameters<typeof driverEditPatch>[1]> = {}) => ({
  name: DRIVER.name,
  phone: DRIVER.phone,
  icNumber: DRIVER.ic_number ?? '',
  vehicle: DRIVER.vehicle ?? '',
  inHouse: true,
  ...over,
});

describe('driverEditPatch', () => {
  test('an untouched form sends only the id', () => {
    const patch = driverEditPatch(DRIVER, form());
    expect(patch).toEqual({ id: 'drv-1' });
    expect(driverEditUnchanged(patch)).toBe(true);
  });

  test('a renamed driver sends name alone, trimmed', () => {
    const patch = driverEditPatch(DRIVER, form({ name: '  Shamsul Fiqri  ' }));
    expect(patch).toEqual({ id: 'drv-1', name: 'Shamsul Fiqri' });
    expect(driverEditUnchanged(patch)).toBe(false);
  });

  test('phone / IC / vehicle each diff on their own', () => {
    expect(driverEditPatch(DRIVER, form({ phone: '+60129999999' }))).toEqual({ id: 'drv-1', phone: '+60129999999' });
    expect(driverEditPatch(DRIVER, form({ icNumber: '900101-01-5523' }))).toEqual({ id: 'drv-1', icNumber: '900101-01-5523' });
    expect(driverEditPatch(DRIVER, form({ vehicle: 'Hilux WMN1234' }))).toEqual({ id: 'drv-1', vehicle: 'Hilux WMN1234' });
  });

  test('inHouse stays OUT of the patch unless the toggle actually moved', () => {
    // Same value → not sent (so renaming a 3PL driver never trips the 409).
    expect(driverEditPatch({ ...DRIVER, in_house: false }, form({ inHouse: false, name: 'Jan' })))
      .toEqual({ id: 'drv-1', name: 'Jan' });
    // Moved → sent.
    expect(driverEditPatch(DRIVER, form({ inHouse: false }))).toEqual({ id: 'drv-1', inHouse: false });
  });

  test('clearing IC back to blank is a real change', () => {
    const patch = driverEditPatch({ ...DRIVER, ic_number: '900101-01-5523' }, form({ icNumber: '' }));
    expect(patch).toEqual({ id: 'drv-1', icNumber: '' });
  });
});

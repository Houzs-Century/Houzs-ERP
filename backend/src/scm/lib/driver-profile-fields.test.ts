import { describe, expect, it } from 'vitest';
import { driverProfilePatch, normalizeLicenseExpiry, INVALID_LICENSE_EXPIRY } from './driver-profile-fields';

describe('normalizeLicenseExpiry', () => {
  it('keeps a real date', () => {
    expect(normalizeLicenseExpiry('2027-05-01')).toBe('2027-05-01');
  });
  it('treats blank / null as "left blank" (null), not rejected', () => {
    expect(normalizeLicenseExpiry('')).toBeNull();
    expect(normalizeLicenseExpiry('   ')).toBeNull();
    expect(normalizeLicenseExpiry(null)).toBeNull();
    expect(normalizeLicenseExpiry(undefined)).toBeNull();
  });
  it('rejects a non-date and an impossible calendar date', () => {
    expect(normalizeLicenseExpiry('soon')).toBe(INVALID_LICENSE_EXPIRY);
    expect(normalizeLicenseExpiry('2027-13-01')).toBe(INVALID_LICENSE_EXPIRY);
    expect(normalizeLicenseExpiry('2027-02-30')).toBe(INVALID_LICENSE_EXPIRY);
    expect(normalizeLicenseExpiry('27-5-1')).toBe(INVALID_LICENSE_EXPIRY);
  });
});

describe('driverProfilePatch', () => {
  it('emits only the keys present in the body', () => {
    const r = driverProfilePatch({ address: '1 Road' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toEqual({ address: '1 Road' });
  });
  it('maps every camelCase input to its column and blanks to null', () => {
    const r = driverProfilePatch({
      licenseNo: 'L1', licenseExpiry: '2028-01-01', address: '', emergencyContactName: 'A', emergencyContactPhone: ' 011 ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toEqual({
      license_no: 'L1', license_expiry: '2028-01-01', address: null, emergency_contact_name: 'A', emergency_contact_phone: '011',
    });
  });
  it('fails closed on a bad expiry', () => {
    const r = driverProfilePatch({ licenseExpiry: '2028-99-99' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_license_expiry');
  });
});

// ---------------------------------------------------------------------------
// driver-profile-fields.ts — the OFFICE-maintained profile on an outsource
// driver (owner 2026-11-28): licence number + expiry, home address and an
// emergency contact. name / phone / IC already have their rules in
// fleet-crew-fields.ts; this is the rest.
//
// PURE, so the create and PATCH paths in routes/drivers.ts cannot drift and the
// one rule that needs a guard — the expiry is a real calendar date — is
// testable. The photo lives in POD_BUCKET (R2) and is set by its own endpoint
// (POST /drivers/:id/photo), the way users.profile_pic_r2_key is, so it is NOT
// mapped here.
// ---------------------------------------------------------------------------

/** Returned when the licence expiry cannot be stored as a date. A distinct
 *  sentinel, because null is a LEGITIMATE value (the field is optional) and the
 *  caller must not confuse "left blank" with "rejected". Mirrors INVALID_IC. */
export const INVALID_LICENSE_EXPIRY = Symbol('invalid_license_expiry');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const textOrNull = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/** A licence expiry is a plain calendar date (yyyy-mm-dd) or blank. A bad value
 *  is caught here with a clean 400 rather than letting a `date` column 500. */
export function normalizeLicenseExpiry(
  raw: unknown,
): string | null | typeof INVALID_LICENSE_EXPIRY {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!ISO_DATE.test(s)) return INVALID_LICENSE_EXPIRY;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return INVALID_LICENSE_EXPIRY;
  }
  return s;
}

export type DriverProfileColumns = {
  license_no: string | null;
  license_expiry: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

export type DriverProfileResult =
  | { ok: true; fields: Partial<DriverProfileColumns> }
  | { ok: false; error: 'invalid_license_expiry'; reason: string };

/**
 * Map the camelCase profile inputs onto the scm.drivers columns. Only the keys
 * PRESENT in `body` are emitted, so a PATCH touches only what changed and a
 * create fills only what was supplied. Blank strings become null.
 */
export function driverProfilePatch(body: Record<string, unknown>): DriverProfileResult {
  const fields: Partial<DriverProfileColumns> = {};
  if (body.licenseNo !== undefined) fields.license_no = textOrNull(body.licenseNo);
  if (body.address !== undefined) fields.address = textOrNull(body.address);
  if (body.emergencyContactName !== undefined) {
    fields.emergency_contact_name = textOrNull(body.emergencyContactName);
  }
  if (body.emergencyContactPhone !== undefined) {
    fields.emergency_contact_phone = textOrNull(body.emergencyContactPhone);
  }
  if (body.licenseExpiry !== undefined) {
    const exp = normalizeLicenseExpiry(body.licenseExpiry);
    if (exp === INVALID_LICENSE_EXPIRY) {
      return {
        ok: false,
        error: 'invalid_license_expiry',
        reason: 'Enter the licence expiry as a date (YYYY-MM-DD), or leave it blank.',
      };
    }
    fields.license_expiry = exp;
  }
  return { ok: true, fields };
}

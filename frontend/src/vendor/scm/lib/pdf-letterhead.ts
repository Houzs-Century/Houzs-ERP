
import { composeCompanyAddress, shortCompanyName, HOUZS_COMPANY_CODE } from '../../../lib/branding-text';
import { canonicalizeSinglePhone, formatPhone } from '../../shared/phone';
import type { PdfLetterhead } from './pdf-host';

/** The Branding fields a letterhead reads (lib/branding.ts Branding; the backend's is the same shape). */
export type LetterheadBranding = {
  companyName: string;
  registrationNo: string;
  address: string;
  postcode?: string;
  phone: string;
  email: string;
  website: string;
  csPhone?: string;
  csEmail?: string;
};

/** Split the single-line branding address into ≤2 print lines on a comma
 *  boundary, matching the historic two-line letterhead block. */
export function splitAddressLines(address: string): string[] {
  const a = (address || '').trim();
  if (!a) return [];
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [a];
  const split = Math.max(1, Math.ceil(parts.length / 2));
  const line1 = parts.slice(0, split).join(', ') + ',';
  const line2 = parts.slice(split).join(', ') + (a.endsWith('.') ? '.' : '');
  return [line1, line2];
}

/** The printed letterhead for one company's branding. `companyCode` picks the
 *  footer's portal label. */
export function letterheadFromBranding(b: LetterheadBranding, companyCode: string): PdfLetterhead {
  const csPhone = b.csPhone ?? '';
  return {
    name: b.companyName,
    reg: b.registrationNo,
    addressLines: splitAddressLines(composeCompanyAddress(b)),
    phone: formatPhone(canonicalizeSinglePhone(b.phone)),
    email: b.email,
    website: b.website,
    /* Customer-service desk (owner 2026-08-07) — deliberately NOT `phone` /
       `email` above, which are the company's headline contacts. Blank for a
       company that has not set one, and the document omits the line rather than
       borrowing another company's. Canonicalised on read like `phone`. */
    csPhone: csPhone ? formatPhone(canonicalizeSinglePhone(csPhone)) : '',
    csEmail: b.csEmail ?? '',
    portalLabel: portalLabelFor(companyCode, b.companyName),
  };
}

function portalLabelFor(companyCode: string, companyName: string): string {
  if ((companyCode || '').trim().toUpperCase() === HOUZS_COMPANY_CODE) return 'Houzs ERP';
  return `${shortCompanyName(companyName)} ERP`;
}

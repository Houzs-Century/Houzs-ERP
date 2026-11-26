// ----------------------------------------------------------------------------
// pdf-letterhead — a company's Branding record as the block a document prints.
// One rule for the browser (pdf-common.ts host) and the Worker (AI Connector
// get_pdf), so the two letterheads cannot drift. Pure: no fetch, no DOM.
// ----------------------------------------------------------------------------

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
  // Balance the comma-separated chunks across two lines (first line gets the
  // bulk; the tail — typically "postcode City, State." — goes on line two).
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
    // Weave the structured postcode into the free-text address (legacy rows,
    // and rows whose address already embeds the postcode, are unchanged).
    addressLines: splitAddressLines(composeCompanyAddress(b)),
    // Printed on every document, so it shows the same canonical shape the rest
    // of the app uses: "+60 3-1234 5678", not "03-1234 5678". canonicalize-
    // SinglePhone refuses anything that is not unambiguously one number (this
    // field has held "03-1234 5678 / 019-876 5432"), and formatPhone returns
    // its input untouched for anything it does not recognise — so a value
    // either renders in the canonical form or exactly as it was stored. It is
    // applied on READ as well as on write because rows saved before the write
    // path canonicalised still hold the local form.
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

/* Footer "portal" label. HOUZS keeps the historic literal byte-identical; any
   other active company renders "<short name> ERP" (e.g. "2990's Home ERP"). */
function portalLabelFor(companyCode: string, companyName: string): string {
  if ((companyCode || '').trim().toUpperCase() === HOUZS_COMPANY_CODE) return 'Houzs ERP';
  return `${shortCompanyName(companyName)} ERP`;
}

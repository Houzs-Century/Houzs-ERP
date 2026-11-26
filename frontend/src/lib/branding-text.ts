// ----------------------------------------------------------------------------
// branding-text — the pure text rules of a company's branding (no fetch, no DOM),
// split out of branding.ts so the Worker can print the same letterhead the
// browser does (vendor/scm/lib/pdf-letterhead.ts). branding.ts re-exports them.
// ----------------------------------------------------------------------------

export const HOUZS_COMPANY_CODE = "HOUZS";

/** Human short name for inline copy ("<X> ERP" portal label, "<X> CS Team"):
 *  the company name minus a trailing legal suffix / registration parens.
 *  Mirrors the backend's shortCompanyName (services/branding.ts) so PDFs and
 *  HTML prints render the same label. "Houzs Century Sdn Bhd" → "Houzs
 *  Century"; "2990's Home" → "2990's Home". */
export function shortCompanyName(name: string): string {
  const short = (name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*,?\s*(sdn\.?\s*bhd\.?|berhad|bhd\.?)\s*$/i, "")
    .trim();
  return short || name;
}

/** Effective single-line company address for letterheads: the free-text
 *  `address` with the structured `postcode` woven in. Mirrors the backend's
 *  composeBrandingAddress (services/branding.ts) so the frontend PDFs and the
 *  backend HTML prints render the same block. Legacy rows render byte-identically
 *  — the postcode is only appended when it is set AND not already present in the
 *  address text, so the HOUZS seed ("…43300 Seri Kembangan…") is unchanged. */
export function composeCompanyAddress(b: {
  address: string;
  postcode?: string;
}): string {
  const a = (b.address || "").trim();
  const p = (b.postcode || "").trim();
  if (!p || a.includes(p)) return a;
  if (!a) return p;
  // Drop trailing punctuation so we don't print "…Selangor., 43300".
  return `${a.replace(/[.,\s]+$/, "")}, ${p}`;
}

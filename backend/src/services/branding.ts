import type { Env } from "../types";
import { bumpConfigVersion } from "./configCache";


export interface Branding {
  companyName: string;
  registrationNo: string;
  address: string;
  // Structured postcode, kept SEPARATE from the free-text address lines
  // (owner ask 2026-07-18). "" when unset — the address alone is then the
  // letterhead source, so legacy single-field rows render unchanged.
  postcode: string;
  phone: string;
  email: string;
  website: string;
  logoR2Key: string;
  // R2 object key for an optional SECOND logo used on printed documents only
  // (PDF letterheads + the HTML prints); "" = fall back to logoR2Key.
  //
  // Why two (owner 2026-08-06): the app chrome is DARK and paper is WHITE, so
  // one file cannot serve both. 2990's on-screen logo is the white variant —
  // correct in the sidebar, a near-invisible watermark on a Delivery Order.
  // This slot holds the dark variant for paper. Companies that only ever
  // uploaded one logo are unaffected: blank means "print the same one", which
  // is exactly today's behaviour.
  printLogoR2Key: string;
  // Customer-service contact printed on documents (owner 2026-08-07). Kept
  // SEPARATE from `phone` / `email`, which are the company's headline contacts:
  // the desk a customer should call about a delivery is not the same desk, and
  // Houzs already carried a hardcoded CS number in the ASSR print for exactly
  // this reason. "" = the document simply omits the line.
  //
  // Per company, like everything else in this row — a 2990 delivery order must
  // never print a houzscentury.com address.
  csPhone: string;
  csEmail: string;
  /** Where a CUSTOMER pays (owner 2026-09-21: 给顾客的是要进什么户口): bank,
   *  account name and number, one item per line, printed as PAYMENT DETAILS
   *  on the Deposit Invoice and the Sales Invoice. "" omits the block. */
  customerPaymentDetails: string;
  /** Where an OTHER DEBTOR pays — a different account from the customers'
   *  (给 other debtor 的户口又不一样) — printed on the Other Debtor invoice. */
  debtorPaymentDetails: string;
  debtorInvoiceTerms: string;
}

const BRANDING_KEY = "branding";

/** Company code whose canonical branding row is the legacy 'branding' key. */
export const HOUZS_COMPANY_CODE = "HOUZS";

/** app_settings key for a company's branding row. HOUZS stays on the legacy
 *  bare 'branding' key (backwards compatible); everyone else gets a
 *  'branding:<CODE>' row. */
export function brandingKeyForCompany(companyCode: string): string {
  const code = (companyCode || HOUZS_COMPANY_CODE).trim().toUpperCase();
  return code === HOUZS_COMPANY_CODE ? BRANDING_KEY : `branding:${code}`;
}

export const DEFAULT_BRANDING: Branding = {
  companyName: "Houzs Century Sdn Bhd",
  registrationNo: "202201031135 (1476832-W)",
  address:
    "1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong, 43300 Seri Kembangan, Selangor.",
  postcode: "43300",
  phone: "011-1110 8883",
  email: "hello@houzscentury.com",
  website: "",
  logoR2Key: "",
  printLogoR2Key: "",
  csPhone: "",
  csEmail: "",
  customerPaymentDetails: "",
  debtorPaymentDetails: "",
  debtorInvoiceTerms: "",
};

export const DEFAULT_BRANDING_2990: Branding = {
  companyName: "2990's Home",
  registrationNo: "",
  address: "",
  postcode: "",
  phone: "",
  email: "",
  website: "",
  logoR2Key: "",
  printLogoR2Key: "",
  csPhone: "",
  csEmail: "",
  customerPaymentDetails: "",
  debtorPaymentDetails: "",
  debtorInvoiceTerms: "",
};

/** Compile-time defaults per company code. Unknown codes get a name-only
 *  Branding carrying the code itself so a future third company never renders
 *  another company's identity before its row is seeded. */
export function defaultBrandingForCompany(companyCode: string): Branding {
  const code = (companyCode || HOUZS_COMPANY_CODE).trim().toUpperCase();
  if (code === HOUZS_COMPANY_CODE) return { ...DEFAULT_BRANDING };
  if (code === "2990") return { ...DEFAULT_BRANDING_2990 };
  return { ...DEFAULT_BRANDING_2990, companyName: code };
}

/** Human short name for inline copy ("<X> CS Team", "<X> Representative"):
 *  the company name minus a trailing legal suffix / registration parens.
 *  "Houzs Century Sdn Bhd" → "Houzs Century"; "2990's Home" → "2990's Home". */
export function shortCompanyName(name: string): string {
  const short = (name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*,?\s*(sdn\.?\s*bhd\.?|berhad|bhd\.?)\s*$/i, "")
    .trim();
  return short || name;
}

/** Effective single-line company address for letterheads: the free-text
 *  `address` with the structured `postcode` woven in. Legacy rows render
 *  byte-identically — the postcode is only appended when it is set AND not
 *  already present in the address text, so a row whose address already embeds
 *  its postcode (e.g. the HOUZS seed "…43300 Seri Kembangan…") is unchanged.
 *  The owner keeps full control of exact wording via the Address field; this is
 *  a best-effort overlay for rows that keep the postcode in its own field. */
export function composeBrandingAddress(b: {
  address: string;
  postcode?: string;
}): string {
  const a = (b.address || "").trim();
  const p = (b.postcode || "").trim();
  if (!p || a.includes(p)) return a;
  if (!a) return p;
  return `${a.replace(/[.,\s]+$/, "")}, ${p}`;
}

/** The logo key a PRINTED document should use: the dedicated print logo when
 *  one is uploaded, otherwise the on-screen logo. "" = text-only letterhead.
 *
 *  Every print surface must go through this — the frontend jspdf letterheads
 *  (lib/branding.ts mirrors it), the ASSR print and the project print. A print
 *  site reading logoR2Key directly would silently keep printing the screen
 *  variant after the owner uploads a print one. */
export function letterheadLogoKey(b: {
  logoR2Key: string;
  printLogoR2Key?: string;
}): string {
  return (b.printLogoR2Key || "").trim() || (b.logoR2Key || "").trim();
}

/** Split the single-line branding address into ≤2 print lines on a comma
 *  boundary — same convention as the frontend PDF letterhead. Blank → []. */
export function brandingAddressLines(address: string): string[] {
  const a = (address || "").trim();
  if (!a) return [];
  const parts = a.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [a];
  const split = Math.max(1, Math.ceil(parts.length / 2));
  const line1 = parts.slice(0, split).join(", ") + ",";
  const line2 = parts.slice(split).join(", ") + (a.endsWith(".") ? "." : "");
  return [line1, line2];
}

function normalize(raw: unknown, defaults: Branding = DEFAULT_BRANDING): Branding {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" ? v : fallback;
  return {
    companyName: str(r.companyName, defaults.companyName),
    registrationNo: str(r.registrationNo, defaults.registrationNo),
    address: str(r.address, defaults.address),
    postcode: str(r.postcode, ""),
    phone: str(r.phone, defaults.phone),
    email: str(r.email, defaults.email),
    website: str(r.website, defaults.website),
    logoR2Key: str(r.logoR2Key, defaults.logoR2Key),
    printLogoR2Key: str(r.printLogoR2Key, ""),
    csPhone: str(r.csPhone, ""),
    csEmail: str(r.csEmail, ""),
    customerPaymentDetails: str(r.customerPaymentDetails, ""),
    debtorPaymentDetails: str(r.debtorPaymentDetails, ""),
    debtorInvoiceTerms: str(r.debtorInvoiceTerms, ""),
  };
}

export async function getBranding(env: Env): Promise<Branding> {
  return getBrandingForCompany(env, HOUZS_COMPANY_CODE);
}

let companyCodeCache: { at: number; byId: Map<number, string>; codes: Set<string> } | null = null;
const COMPANY_CODE_TTL_MS = 5 * 60 * 1000;

export async function resolveCompanyCode(
  env: Env,
  company: number | string | null | undefined,
): Promise<string> {
  if (company === null || company === undefined || company === "") {
    return HOUZS_COMPANY_CODE;
  }
  const raw = String(company).trim();
  if (raw === "") return HOUZS_COMPANY_CODE;
  const upper = raw.toUpperCase();
  try {
    if (!companyCodeCache || Date.now() - companyCodeCache.at > COMPANY_CODE_TTL_MS) {
      const res = await env.DB.prepare(`SELECT id, code FROM companies`).all<{
        id: number | string;
        code: string;
      }>();
      const byId = new Map<number, string>();
      const codes = new Set<string>();
      for (const r of res.results ?? []) {
        const code = String(r.code).toUpperCase();
        byId.set(Number(r.id), code);
        codes.add(code);
      }
      companyCodeCache = { at: Date.now(), byId, codes };
    }
    if (companyCodeCache.codes.has(upper)) return upper;
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) {
      return companyCodeCache.byId.get(id) ?? HOUZS_COMPANY_CODE;
    }
    return /^\d+$/.test(raw) ? HOUZS_COMPANY_CODE : upper;
  } catch {
    return /^\d+$/.test(raw) ? HOUZS_COMPANY_CODE : upper;
  }
}

/**
 * Company-aware branding read. `company` may be a companies.id (a document
 * row's company_id), a company code ('HOUZS' | '2990'), or null/undefined
 * (→ HOUZS). Resolution: the company's app_settings row → that company's
 * compile-time default. Never throws.
 */
export async function getBrandingForCompany(
  env: Env,
  company: number | string | null | undefined,
): Promise<Branding> {
  const code = await resolveCompanyCode(env, company);
  const defaults = defaultBrandingForCompany(code);
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM app_settings WHERE key = ?`,
    )
      .bind(brandingKeyForCompany(code))
      .first<{ value: string }>();
    if (!row?.value) return defaults;
    return normalize(JSON.parse(row.value), defaults);
  } catch {
    return defaults;
  }
}

export async function setBrandingForCompany(
  env: Env,
  company: number | string | null | undefined,
  branding: Branding,
  updatedBy: number | null,
): Promise<void> {
  const code = await resolveCompanyCode(env, company);
  const json = JSON.stringify(branding);
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = datetime('now'),
       updated_by = excluded.updated_by`,
  )
    .bind(brandingKeyForCompany(code), json, updatedBy ?? null)
    .run();
  await bumpConfigVersion(env, "branding");
}

/** Legacy signature — writes the HOUZS row. Kept so untouched callers break
 *  nothing. */
export async function setBranding(
  env: Env,
  branding: Branding,
  updatedBy: number | null,
): Promise<void> {
  return setBrandingForCompany(env, HOUZS_COMPANY_CODE, branding, updatedBy);
}


import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "./requestCorrelation";
import { HOUZS_COMPANY_CODE } from "../../../shared/src/lib/branding-text";
export { HOUZS_COMPANY_CODE, shortCompanyName, composeCompanyAddress } from "../../../shared/src/lib/branding-text";

export interface Branding {
  companyName: string;
  registrationNo: string;
  address: string;
  postcode: string;
  phone: string;
  email: string;
  website: string;
  logoR2Key: string;
  /** R2 object key for the optional SECOND logo used on PRINTED documents
   *  ("" = fall back to logoR2Key). Served via GET
   *  /api/branding/logo?variant=print.
   *
   *  Why two (owner 2026-08-06): the app chrome is DARK and paper is WHITE, so
   *  one file cannot serve both — 2990's white logo is right in the sidebar and
   *  a near-invisible watermark on a Delivery Order. Blank means "print the
   *  on-screen one", i.e. exactly the pre-2026-08 behaviour. */
  printLogoR2Key: string;
  csPhone: string;
  csEmail: string;
  /** Where a CUSTOMER pays (owner 2026-09-21): bank, account name and number,
   *  one item per line — PAYMENT DETAILS on the Deposit Invoice and the Sales
   *  Invoice. "" omits the block. */
  customerPaymentDetails: string;
  debtorPaymentDetails: string;
  debtorInvoiceTerms: string;
}

/** Seeded defaults — VERBATIM the values that were hardcoded before this change
 *  (frontend pdf-common.ts COMPANY + AuthScreens "Houzs Century" lockup + the
 *  email from-address). Mirrors the 0038_branding_config.sql seed row so the
 *  fetch returns the same values it falls back to. */
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

/** 2990 company defaults — mirrors the backend's DEFAULT_BRANDING_2990 and
 *  migration 0094 seed. Blank fields are owner-editable placeholders; they
 *  must STAY blank (letterheads omit blank lines), never snap to a Houzs
 *  literal. */
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

/** Defaults for the given company code (GET /api/branding echoes the active
 *  company's code alongside the branding). Unknown/absent code → HOUZS, the
 *  pre-multi-company behaviour. */
export function defaultBrandingForCompany(companyCode?: string | null): Branding {
  const code = (companyCode ?? "").trim().toUpperCase();
  if (code === "2990") return { ...DEFAULT_BRANDING_2990 };
  return { ...DEFAULT_BRANDING };
}


/** Hostname default company — mirrors the backend companyContext middleware's
 *  defaultCompanyCodeForHost (erp.2990shome.com → 2990; everything else →
 *  HOUZS). Used pre-fetch (and pre-auth, where GET /api/branding 401s) so the
 *  login screen / first paint on a 2990 hostname never flashes Houzs. */
export function hostDefaultCompanyCode(): string {
  try {
    return window.location.hostname.toLowerCase().includes("2990")
      ? "2990"
      : HOUZS_COMPANY_CODE;
  } catch {
    return HOUZS_COMPANY_CODE;
  }
}

/** Normalise a partial/loose server payload into a complete Branding, falling
 *  back to the given company's default for any missing/blank field (default:
 *  the HOUZS seed — untouched callers unchanged). Dual-reads
 *  camelCase ?? snake_case so a snake_cased backend column never reads
 *  undefined (the repo's #1 recurring bug). */
export function normalizeBranding(
  raw: unknown,
  defaults: Branding = DEFAULT_BRANDING,
): Branding {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string, fallback: string): string => {
    const v = (r[camel] ?? r[snake]) as unknown;
    const s = v == null ? "" : String(v).trim();
    return s || fallback;
  };
  return {
    companyName: pick("companyName", "company_name", defaults.companyName),
    registrationNo: pick("registrationNo", "registration_no", defaults.registrationNo),
    address: pick("address", "address", defaults.address),
    postcode: pick("postcode", "postcode", ""),
    phone: pick("phone", "phone", defaults.phone),
    email: pick("email", "email", defaults.email),
    website: ((r.website ?? r.web_site) as string | undefined)?.toString().trim() ?? "",
    logoR2Key: ((r.logoR2Key ?? r.logo_r2_key) as string | undefined)?.toString().trim() ?? "",
    printLogoR2Key:
      ((r.printLogoR2Key ?? r.print_logo_r2_key) as string | undefined)?.toString().trim() ?? "",
    csPhone: ((r.csPhone ?? r.cs_phone) as string | undefined)?.toString().trim() ?? "",
    csEmail: ((r.csEmail ?? r.cs_email) as string | undefined)?.toString().trim() ?? "",
    customerPaymentDetails: ((r.customerPaymentDetails ?? r.customer_payment_details) as string | undefined)?.toString().trim() ?? "",
    debtorPaymentDetails: ((r.debtorPaymentDetails ?? r.debtor_payment_details) as string | undefined)?.toString().trim() ?? "",
    debtorInvoiceTerms: ((r.debtorInvoiceTerms ?? r.debtor_invoice_terms) as string | undefined)?.toString().trim() ?? "",
  };
}


let brandingCache: Branding = defaultBrandingForCompany(hostDefaultCompanyCode());

let brandingCompanyCodeCache: string = hostDefaultCompanyCode();

export function setBrandingCache(b: Branding, companyCode?: string): void {
  brandingCache = b;
  if (companyCode) brandingCompanyCodeCache = companyCode.trim().toUpperCase();
}

export function getBrandingCache(): Branding {
  return brandingCache;
}

export function getBrandingCompanyCode(): string {
  return brandingCompanyCodeCache;
}


export interface BrandingLogo {
  key: string;
  company?: string;
  dataUrl: string;
  format: "PNG" | "JPEG";
  width: number;
  height: number;
}

let logoCache: BrandingLogo | null = null;
let logoInflight: Promise<void> | null = null;
let logoFailedKey: string | null = null;

/**
 * The logo key a PRINTED document should use: the dedicated print logo when one
 * is uploaded, otherwise the on-screen logo. "" = text-only letterhead.
 * Mirrors the backend's letterheadLogoKey (services/branding.ts) so the jspdf
 * letterheads and the server-rendered HTML prints pick the same file.
 *
 * The app chrome (CompanyMark) deliberately does NOT go through this — it wants
 * the on-screen variant, which is the whole reason there are two.
 */
export function letterheadLogoKey(b: {
  logoR2Key: string;
  printLogoR2Key?: string;
}): string {
  return (b.printLogoR2Key || "").trim() || (b.logoR2Key || "").trim();
}

/** Sync accessor for drawHeader(). null = no logo (text-only header). */
export function getBrandingLogoCache(): BrandingLogo | null {
  const key = letterheadLogoKey(brandingCache);
  if (!key) return null;
  if (!logoCache || logoCache.key !== key) return null;
  if (logoCache.company && logoCache.company !== brandingCompanyCodeCache) return null;
  return logoCache;
}

/** Drop the memo — called after a logo upload/remove in Settings so the next
 *  PDF re-reads the new state instead of a stale image. */
export function clearBrandingLogoCache(): void {
  logoCache = null;
  logoInflight = null;
  logoFailedKey = null;
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });

/**
 * The letterhead draws the logo inside 40mm x 16mm (pdf-common `drawHeader`).
 * At 300dpi that is 472 x 189 px — anything larger is detail no printer will
 * ever emit.
 *
 * It is not merely wasted: jsPDF embeds the bitmap RAW, uncompressed, into
 * EVERY document. A 3508 x 1561 logo (what the 2990 upload actually was) is
 * 16.4 MB of pixels plus 5.5 MB of alpha — which is why one Delivery Order
 * PDF weighed 21 MB and could not be emailed.
 */
export const LETTERHEAD_MAX_PX = { width: 480, height: 192 } as const;

/**
 * Scale factor to fit `w x h` inside the letterhead box — 1 when it already
 * does, so a sensibly sized logo is passed through untouched (byte-identical
 * output, no re-encode).
 *
 * Exported for its own test: the canvas work below cannot run in jsdom, but
 * the arithmetic that decides it is the part worth pinning.
 */
export function letterheadScale(width: number, height: number): number {
  if (!width || !height) return 1;
  return Math.min(
    1,
    LETTERHEAD_MAX_PX.width / width,
    LETTERHEAD_MAX_PX.height / height,
  );
}

async function fitLogoForLetterhead(
  dataUrl: string,
  width: number,
  height: number,
  isPng: boolean,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const scale = letterheadScale(width, height);
  if (scale >= 1) return { dataUrl, width, height };
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = dataUrl;
    });
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl, width, height };
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.92);
    if (!out || !out.startsWith("data:image/")) return { dataUrl, width, height };
    return { dataUrl: out, width: w, height: h };
  } catch {
    return { dataUrl, width, height };
  }
}

const dataUrlDimensions = (dataUrl: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUrl;
  });

/**
 * Ensure the branding logo (if any) is memoized for the PDF libs. Fail-soft:
 * any fetch/decode failure leaves the memo empty, and the letterhead simply
 * renders text-only — a PDF must never fail because of a logo. Concurrent
 * callers share one in-flight fetch.
 */
export async function ensureBrandingLogoLoaded(): Promise<void> {
  const key = letterheadLogoKey(brandingCache);
  const usingPrintSlot = key !== "" && key === (brandingCache.printLogoR2Key || "").trim();
  const expectedCompany = brandingCompanyCodeCache;
  if (!key) return;
  if (logoCache && logoCache.key === key) return;
  if (logoFailedKey === key) return;
  if (logoInflight) return logoInflight;

  logoInflight = (async () => {
    try {
      const { api, tokenStore } = await import("../api/client");
      const { companyHeader } = await import("./activeCompany");
      const token = tokenStore.get();
      const params = new URLSearchParams({ k: key });
      if (usingPrintSlot) params.set("variant", "print");
      const res = await correlatedFetch(
        `${api.baseUrl}/api/branding/logo?${params.toString()}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...companyHeader(),
          },
        },
      );
      if (!res.ok) throw correlateError(new Error(`logo fetch ${res.status}`), requestIdFromResponse(res));
      const servedCompany = res.headers.get("x-company-code");
      if (servedCompany && servedCompany.toUpperCase() !== expectedCompany.toUpperCase()) {
        throw new Error(`logo served for ${servedCompany}, expected ${expectedCompany}`);
      }
      const { dataUrl, width, height, contentType } = await consumeCorrelated(res, async () => {
        const blob = await res.blob();
        const raw = await blobToDataUrl(blob);
        const natural = await dataUrlDimensions(raw);
        if (!natural.width || !natural.height) throw new Error("logo has no dimensions");
        const isPng = blob.type === "image/png" || raw.startsWith("data:image/png");
        const fitted = await fitLogoForLetterhead(raw, natural.width, natural.height, isPng);
        return { ...fitted, contentType: isPng ? "image/png" : blob.type };
      });
      const format: BrandingLogo["format"] =
        contentType === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      logoCache = { key, company: expectedCompany, dataUrl, format, width, height };
      logoFailedKey = null;
    } catch {
      logoFailedKey = key;
    } finally {
      logoInflight = null;
    }
  })();
  return logoInflight;
}


const brandLogoCache = new Map<string, BrandingLogo>();
const brandLogoInflight = new Map<string, Promise<void>>();
const brandLogoFailed = new Set<string>();

/** Sync accessor for drawHeader() callers. null = not loaded / no brand logo
 *  (the header falls back to the company logo, then text-only). */
export function getBrandLogoCache(key: string | null | undefined): BrandingLogo | null {
  if (!key) return null;
  return brandLogoCache.get(key) ?? null;
}

/** Drop the memo — called after a brand-logo upload/remove in Project
 *  Maintenance so the next PDF re-reads the new state instead of a stale
 *  image. */
export function clearBrandLogoCache(): void {
  brandLogoCache.clear();
  brandLogoInflight.clear();
  brandLogoFailed.clear();
}

/**
 * Ensure a brand logo is memoized for the PDF libs. Fail-soft: any
 * fetch/decode failure leaves the memo empty and the SO letterhead falls back
 * to the company logo — a PDF must never fail because of a logo. Concurrent
 * callers share one in-flight fetch per key.
 */
export async function ensureBrandLogoLoaded(key: string | null | undefined): Promise<void> {
  if (!key) return;
  if (brandLogoCache.has(key)) return;
  if (brandLogoFailed.has(key)) return;
  const inflight = brandLogoInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const { api, tokenStore } = await import("../api/client");
      const token = tokenStore.get();
      const res = await correlatedFetch(
        `${api.baseUrl}/api/projects/brands/logo?key=${encodeURIComponent(key)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw correlateError(new Error(`brand logo fetch ${res.status}`), requestIdFromResponse(res));
      const { dataUrl, width, height, contentType } = await consumeCorrelated(res, async () => {
        const blob = await res.blob();
        const raw = await blobToDataUrl(blob);
        const natural = await dataUrlDimensions(raw);
        if (!natural.width || !natural.height) throw new Error("logo has no dimensions");
        const isPng = blob.type === "image/png" || raw.startsWith("data:image/png");
        const fitted = await fitLogoForLetterhead(raw, natural.width, natural.height, isPng);
        return { ...fitted, contentType: isPng ? "image/png" : blob.type };
      });
      const format: BrandingLogo["format"] =
        contentType === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      brandLogoCache.set(key, { key, dataUrl, format, width, height });
    } catch {
      brandLogoFailed.add(key);
    } finally {
      brandLogoInflight.delete(key);
    }
  })();
  brandLogoInflight.set(key, p);
  return p;
}

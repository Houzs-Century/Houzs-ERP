// ----------------------------------------------------------------------------
// Company identity (Branding) — ONE source of truth for the company name /
// registration no / address / phone / email / website that used to be hardcoded
// across the app chrome, the login screen, and the jspdf document letterheads.
//
// Two consumption paths share this module:
//   • React components read it via useBranding() (hooks/useBranding.ts), which
//     fetches GET /api/branding once and caches it through the app's query layer.
//   • The pure jspdf PDF libs (vendor/scm/lib/pdf-common.ts) can't use hooks, so
//     they read getBrandingCache() — a plain module-level snapshot that
//     useBranding() pushes via setBrandingCache() the moment the fetch resolves.
//
// DEFAULT_BRANDING carries the CURRENT hardcoded values VERBATIM so the chrome,
// login screen, and PDFs render identically before the fetch resolves (or if it
// fails / the app is offline) — only centralised, nothing changes visually.
// ----------------------------------------------------------------------------

import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "./requestCorrelation";

export interface Branding {
  companyName: string;
  registrationNo: string;
  address: string;
  /** Structured postcode, kept SEPARATE from the free-text address lines (owner
   *  ask 2026-07-18). "" when unset — the address alone is then the letterhead
   *  source, so legacy single-field rows render unchanged. */
  postcode: string;
  phone: string;
  email: string;
  website: string;
  /** R2 object key for an uploaded logo ("" = none). Uploaded in Settings →
   *  Branding; served via GET /api/branding/logo (auth-gated). This is the
   *  ON-SCREEN logo (app chrome + login screen) and the letterhead fallback. */
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
  // Mirrors migration 0142's backfill (extracted from the address above). The
  // address still carries "43300", so composeCompanyAddress leaves the printed
  // letterhead byte-identical — this only makes the structured value available.
  postcode: "43300",
  phone: "011-1110 8883",
  email: "hello@houzscentury.com",
  website: "",
  logoR2Key: "",
  printLogoR2Key: "",
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
};

/** Defaults for the given company code (GET /api/branding echoes the active
 *  company's code alongside the branding). Unknown/absent code → HOUZS, the
 *  pre-multi-company behaviour. */
export function defaultBrandingForCompany(companyCode?: string | null): Branding {
  const code = (companyCode ?? "").trim().toUpperCase();
  if (code === "2990") return { ...DEFAULT_BRANDING_2990 };
  return { ...DEFAULT_BRANDING };
}

export const HOUZS_COMPANY_CODE = "HOUZS";

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
    // Rows written before the postcode field existed have no key → "" (a blank
    // postcode must stay blank; the address alone drives the letterhead then).
    postcode: pick("postcode", "postcode", ""),
    phone: pick("phone", "phone", defaults.phone),
    email: pick("email", "email", defaults.email),
    // website + logoR2Key default to empty (not the seed) — they're genuinely
    // optional, so a blank server value must stay blank, not snap to a literal.
    website: ((r.website ?? r.web_site) as string | undefined)?.toString().trim() ?? "",
    logoR2Key: ((r.logoR2Key ?? r.logo_r2_key) as string | undefined)?.toString().trim() ?? "",
    // Rows written before the print slot existed have no key → "" ("print the
    // on-screen logo").
    printLogoR2Key:
      ((r.printLogoR2Key ?? r.print_logo_r2_key) as string | undefined)?.toString().trim() ?? "",
  };
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

// ── Module-level cache for the pure (non-React) jspdf libs ────────────────────
// Pre-seeded with the HOSTNAME company's defaults so a PDF generated before any
// fetch (or with the fetch failed) still carries the correct letterhead — on a
// 2990 hostname that means 2990's name, never Houzs's. useBranding() calls
// setBrandingCache() on every successful fetch to keep this in sync.
let brandingCache: Branding = defaultBrandingForCompany(hostDefaultCompanyCode());

// The company code the cache currently holds. Pure consumers that need
// per-company COPY (pdf-common's portalLabel "Houzs ERP" vs "<X> ERP") read
// this alongside getBrandingCache(). Kept in sync by useBranding().
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

// ── Logo memo for the pure (non-React) jspdf libs ─────────────────────────────
// jspdf needs the image as a dataURL + its natural dimensions, and drawHeader()
// is synchronous — so the logo is fetched ONCE (authed, via the api client) and
// memoized at module level, keyed by logoR2Key. Upload keys carry a Date.now()
// stamp (new upload = new key), so key equality is a correct cache check.
// Multi-page / multi-print runs reuse the memo instead of refetching.

export interface BrandingLogo {
  key: string;
  dataUrl: string;
  /** jspdf addImage format tag. */
  format: "PNG" | "JPEG";
  /** Natural pixel size — used to preserve the aspect ratio in the header. */
  width: number;
  height: number;
}

let logoCache: BrandingLogo | null = null;
let logoInflight: Promise<void> | null = null;
let logoFailedKey: string | null = null; // don't hammer a 404/broken key

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
  return logoCache && logoCache.key === key ? logoCache : null;
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

/**
 * Re-encode an oversized logo down to letterhead size. PNG is kept as PNG so
 * transparency survives — a logo with an alpha channel flattened onto white
 * would show a box on any non-white background.
 *
 * Fail-soft in every direction: no canvas (jsdom), a tainted canvas, an
 * encoder that returns nothing — all fall back to the original image. A
 * heavier PDF is a bad day; a PDF with no letterhead is a wrong document.
 */
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
  // The PRINT slot when the owner uploaded one, else the on-screen logo. The
  // memo is keyed by whichever we resolved, so swapping slots never serves the
  // stale one.
  const key = letterheadLogoKey(brandingCache);
  const usingPrintSlot = key !== "" && key === (brandingCache.printLogoR2Key || "").trim();
  if (!key) return;                                   // no logo configured
  if (logoCache && logoCache.key === key) return;     // memo is current
  if (logoFailedKey === key) return;                  // known-bad — don't retry per print
  if (logoInflight) return logoInflight;

  logoInflight = (async () => {
    try {
      // Lazy import avoids a static api/client dependency for the many
      // consumers that only need the text branding.
      const { api, tokenStore } = await import("../api/client");
      const { companyHeader } = await import("./activeCompany");
      const token = tokenStore.get();
      // X-Company-Id rides along (like every api/client call) so the backend
      // serves the ACTIVE company's logo — without it a 2990 session on the
      // Houzs hostname would cache Houzs's logo under 2990's key.
      const res = await correlatedFetch(
        `${api.baseUrl}/api/branding/logo${usingPrintSlot ? "?variant=print" : ""}`,
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...companyHeader(),
          },
        },
      );
      if (!res.ok) throw correlateError(new Error(`logo fetch ${res.status}`), requestIdFromResponse(res));
      const { dataUrl, width, height, contentType } = await consumeCorrelated(res, async () => {
        const blob = await res.blob();
        const raw = await blobToDataUrl(blob);
        const natural = await dataUrlDimensions(raw);
        if (!natural.width || !natural.height) throw new Error("logo has no dimensions");
        // Shrink to what the letterhead actually draws BEFORE it reaches
        // jsPDF, which embeds the bitmap raw into every document.
        const isPng = blob.type === "image/png" || raw.startsWith("data:image/png");
        const fitted = await fitLogoForLetterhead(raw, natural.width, natural.height, isPng);
        return { ...fitted, contentType: isPng ? "image/png" : blob.type };
      });
      const format: BrandingLogo["format"] =
        contentType === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      logoCache = { key, dataUrl, format, width, height };
      logoFailedKey = null;
    } catch {
      logoFailedKey = key; // fail-soft: text-only header this session
    } finally {
      logoInflight = null;
    }
  })();
  return logoInflight;
}

// ── Per-brand logo memo (owner 2026-07 — brand letterheads on the SO PDF) ─────
// Same contract as the company-logo memo above, but keyed by the brand's R2
// key (project_brands.logo_r2_key, served by GET /api/projects/brands/logo).
// GET /api/scm/mfg-sales-orders/:docNo stamps `resolvedBrandLogoKey`; the SO
// PDF warms this memo with it and passes the result to drawHeader() in place
// of the company logo (company letterhead stays the fallback). Upload keys
// carry a Date.now() stamp (new upload = new key), so key equality is a
// correct cache check and the memo never serves a stale image.

const brandLogoCache = new Map<string, BrandingLogo>();
const brandLogoInflight = new Map<string, Promise<void>>();
const brandLogoFailed = new Set<string>(); // don't hammer a 404/broken key

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
  if (!key) return;                                    // no brand logo resolved
  if (brandLogoCache.has(key)) return;                 // memo is current
  if (brandLogoFailed.has(key)) return;                // known-bad — don't retry per print
  const inflight = brandLogoInflight.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      // Lazy import avoids a static api/client dependency for the many
      // consumers that only need the text branding (same as the company memo).
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
        // Shrink to what the letterhead actually draws BEFORE it reaches
        // jsPDF, which embeds the bitmap raw into every document.
        const isPng = blob.type === "image/png" || raw.startsWith("data:image/png");
        const fitted = await fitLogoForLetterhead(raw, natural.width, natural.height, isPng);
        return { ...fitted, contentType: isPng ? "image/png" : blob.type };
      });
      const format: BrandingLogo["format"] =
        contentType === "image/png" || dataUrl.startsWith("data:image/png") ? "PNG" : "JPEG";
      brandLogoCache.set(key, { key, dataUrl, format, width, height });
    } catch {
      brandLogoFailed.add(key); // fail-soft: company letterhead this session
    } finally {
      brandLogoInflight.delete(key);
    }
  })();
  brandLogoInflight.set(key, p);
  return p;
}

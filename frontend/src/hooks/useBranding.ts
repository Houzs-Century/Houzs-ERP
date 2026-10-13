import { useEffect, useSyncExternalStore } from "react";
import { buildQueryKey, useQuery } from "./useQuery";
import { api } from "../api/client";
import { queryClient } from "../lib/queryClient";
import {
  getActiveCompanyId,
  getActiveCompanySnapshot,
  subscribeActiveCompany,
} from "../lib/activeCompany";
import {
  type Branding,
  HOUZS_COMPANY_CODE,
  defaultBrandingForCompany,
  ensureBrandingLogoLoaded,
  hostDefaultCompanyCode,
  normalizeBranding,
  setBrandingCache,
  shortCompanyName,
} from "../lib/branding";

interface BrandingResponse {
  branding?: unknown;
  /** Active company the backend resolved for this request ('HOUZS' | '2990').
   *  Picks the matching default set so a blank 2990 field stays blank instead
   *  of snapping to a Houzs literal. Absent on a pre-multi-company backend. */
  companyCode?: string | null;
  /** postgres.js camelCases raw-SQL columns, but dual-read the snake form
   *  anyway (repo's #1 recurring bug class). */
  company_code?: string | null;
}

/** Branding plus the company it belongs to. All Branding fields are present,
 *  so every existing `const branding = useBranding()` callsite is unchanged. */
export type BrandingWithCompany = Branding & { companyCode: string };

const BRANDING_KEY = "/api/branding";
const BRANDING_STALE_MS = 10 * 60_000;

function fetchBranding(): Promise<BrandingResponse> {
  return api.get<BrandingResponse>(BRANDING_KEY);
}

function resolveBranding(data: BrandingResponse | null | undefined): BrandingWithCompany {
  const companyCode = (
    (data?.companyCode ?? data?.company_code)?.trim() ||
    hostDefaultCompanyCode()
  ).toUpperCase();
  const branding = data
    ? normalizeBranding(data.branding, defaultBrandingForCompany(companyCode))
    : defaultBrandingForCompany(companyCode);
  return { ...branding, companyCode };
}

/**
 * Bring the PDF letterhead cache up to THIS tab's company before a document is
 * drawn. BUG-111: the cache can still hold the hostname default (Houzs) while
 * the tab is on 2990, and a 2990 PO went to the supplier under Houzs's name.
 * Served from the query cache when useBranding already has this company's
 * answer, so a normal print costs no request. Throws when it cannot load:
 * a document with another company's letterhead is worse than a retry.
 */
export async function ensureBrandingForActiveCompany(): Promise<void> {
  let data: BrandingResponse;
  try {
    data = await queryClient.fetchQuery({
      queryKey: buildQueryKey(BRANDING_KEY, [getActiveCompanyId()]),
      queryFn: fetchBranding,
      staleTime: BRANDING_STALE_MS,
    });
  } catch {
    throw new Error("Could not load the company letterhead. Please try again.");
  }
  const { companyCode, ...branding } = resolveBranding(data);
  setBrandingCache(branding, companyCode);
  await ensureBrandingLogoLoaded();
}

/**
 * Company identity for the app chrome, the login screen, and (indirectly, via
 * the module-level cache) the jspdf letterheads.
 *
 * Fetches GET /api/branding once and caches it through the shared query layer
 * (request-dedup + SWR for free). The backend resolves the ACTIVE company
 * (top-bar switcher header → hostname default → HOUZS) and echoes its code;
 * switching company invalidates every query, so this refetches and the whole
 * chrome + PDF cache flips to the new company's identity.
 *
 * While the fetch is pending or if it fails (including pre-auth on the login
 * screen, where /api/branding 401s), callers get the HOSTNAME company's
 * defaults — Houzs literals on Houzs hosts (unchanged), 2990's name on a 2990
 * host — so the UI never flashes empty and never shows the wrong company.
 *
 * On every successful fetch we also push the value into the module-level cache
 * (lib/branding.ts) so the pure PDF libs, which can't call hooks, draw the same
 * letterhead.
 */
export function useBranding(): BrandingWithCompany {
  // Company identity is effectively static, so cache it well past the 30s
  // default to keep it out of the per-navigation waterfall. NOT Infinity on
  // purpose: a bounded staleTime keeps a self-healing net — worst case the
  // chrome shows old branding for <=10min, never "stuck until reload". Edits
  // are rare and the editor sees their own change immediately.
  //
  // The key is now EXPLICIT, so an edit in Settings that force-refetches via
  // q.reload() reliably reaches every consumer of this hook. It used to be
  // derived from `fetcher.toString()`, which minification could break by
  // aliasing the imported `api` differently per module — two callsites wanting
  // the same branding could end up on different keys and disagree.
  //
  // The tab's company is part of the key (BUG-111): the answer depends on the
  // X-Company-Id header, so one fetched before this tab adopted its company
  // must not be served once it has.
  const activeCompanyId = useSyncExternalStore(
    subscribeActiveCompany,
    getActiveCompanySnapshot,
    getActiveCompanySnapshot,
  );
  const q = useQuery<BrandingResponse>(BRANDING_KEY, fetchBranding, [activeCompanyId], {
    staleTime: BRANDING_STALE_MS,
  });

  const { companyCode, ...branding } = resolveBranding(q.data);

  // Keep the non-React PDF cache in sync once the real value lands.
  useEffect(() => {
    if (q.data) {
      setBrandingCache(branding, companyCode);
      // Warm the letterhead-logo memo in the background so the first PDF of
      // the session already has it. Fail-soft + memoized inside — a broken
      // logo never surfaces here, and repeat mounts don't refetch.
      void ensureBrandingLogoLoaded();
    }
    // branding is derived from q.data; depend on the raw payload to avoid a new
    // object identity re-firing the effect every render.
  }, [q.data, branding, companyCode]);

  // Browser-tab title follows the active company. HOUZS keeps the exact
  // index.html literal (byte-identical single-company behaviour); other
  // companies get "<short name> ERP". Vendored SCM pages that set their own
  // document.title win afterwards — this only runs when the company flips.
  useEffect(() => {
    document.title =
      companyCode === HOUZS_COMPANY_CODE
        ? "Houzs Century ERP"
        : `${shortCompanyName(branding.companyName)} ERP`;
  }, [companyCode, branding.companyName]);

  return { ...branding, companyCode };
}

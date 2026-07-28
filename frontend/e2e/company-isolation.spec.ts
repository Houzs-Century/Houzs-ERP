import { test, expect } from "@playwright/test";
import type { Request } from "@playwright/test";
import {
  apiLogin,
  seedAuth,
  credsConfigured,
  isSkippableStagingError,
  companyHeaderOf,
  readCompanies,
  readSoDocPrefixes,
  STAGING_API_URL,
  missingCredentialsMaySkip,
  stagingProofRequired,
} from "./fixtures";

// The product-catalog list request (vendor authed-fetch ->
// `${API_URL}/mfg-products`, API_URL ends in /api/scm). This is the payload
// PR #856's Vary fix protects: after a company switch it must be re-fetched
// fresh for the new company, never served from the previous company's cache.
const PRODUCT_LIST_URL = /\/mfg-products(\?|$)/;

function isProductListGet(r: Request): boolean {
  return PRODUCT_LIST_URL.test(r.url()) && r.method() === "GET";
}

test.describe("company isolation", () => {
  test.beforeEach(() => {
    test.skip(
      missingCredentialsMaySkip(credsConfigured, stagingProofRequired),
      "Staging credentials not configured — set STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD.",
    );
  });

  test("a company switch refetches product data fresh with the new X-Company-Id", async ({
    page,
    context,
    request,
  }) => {
    let token: string;
    try {
      token = await apiLogin(request);
    } catch (e) {
      if (isSkippableStagingError(e)) {
        test.skip(true, e.message);
        return;
      }
      throw e;
    }
    await seedAuth(context, token);

    // Record every product-list request the app fires, with its company header.
    const productReqs: Array<{ url: string; company: string | null }> = [];
    page.on("request", (r) => {
      if (isProductListGet(r)) {
        productReqs.push({ url: r.url(), company: companyHeaderOf(r.headers()) });
      }
    });

    // Sign in (seeded) and confirm the authed shell on an EXPLICIT page —
    // /scm/products, not "/": the shell restores users.last_path from "/",
    // which can navigate mid-`page.evaluate` and destroy the execution
    // context. Account-menu trigger, not the Breadcrumb nav — see
    // auth.spec.ts: the 2b top-chrome redesign left no always-rendered
    // breadcrumb landmark.
    await page.goto("/scm/products");
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

    const companies = await readCompanies(page, STAGING_API_URL);
    const multiCompany = companies.length >= 2;

    // The two company ids to move BETWEEN. Real ids when staging exposes them;
    // when staging is single-/zero-company we still exercise the switch
    // MECHANICS with a distinct second id. That is legitimate here because the
    // behaviour under test lives in the CLIENT: activeCompany.ts writes the id
    // to localStorage and vendor authed-fetch stamps X-Company-Id from it and
    // re-fetches. The mechanical proof (a fresh, newly-scoped request fires)
    // does not require the second company to exist on the backend.
    const c1 = companies.length > 0 ? companies[0].id : 1;
    const c2 = multiCompany ? companies[1].id : c1 + 1;

    // ── Company 1: land with the ?company= boot seed, expect a c1 request ───
    // Since the per-window rework (#1102) the original origin-wide
    // localStorage key is purged as legacy on auth — writing it is worse than
    // a no-op. The supported pre-auth hand-off is the `?company=<id>` URL
    // seed (consumeCompanyUrlSeed, the switcher's own "Open in new window"
    // path): it writes THIS TAB's sessionStorage pick pre-React, so the very
    // first authed request already carries the right X-Company-Id header.
    const req1 = page.waitForRequest(
      (r) => isProductListGet(r) && companyHeaderOf(r.headers()) === String(c1),
      { timeout: 45_000 },
    );
    await page.goto(`/scm/products?company=${c1}`);
    await req1;

    expect(
      productReqs.some((p) => p.company === String(c1)),
      `a product-list request scoped to company ${c1} should have fired`,
    ).toBe(true);

    const prefixesC1 = multiCompany ? await readSoDocPrefixes(page, STAGING_API_URL, c1) : [];

    // ── Switch to Company 2, expect a FRESH request scoped to c2 ────────────
    // The URL seed again: it overwrites this tab's sessionStorage pick
    // pre-React on a full document load, which is exactly what the in-place
    // switcher produces (setActiveCompanyId + window.location.reload()).
    const countBeforeSwitch = productReqs.length;
    const req2 = page.waitForRequest(
      (r) => isProductListGet(r) && companyHeaderOf(r.headers()) === String(c2),
      { timeout: 45_000 },
    );
    await page.goto(`/scm/products?company=${c2}`);
    await req2;

    // The switch produced a REAL, freshly-scoped network request — not a
    // cache-only hit. If the app had served the previous company's catalog from
    // its in-memory cache, NO new product-list request event would have fired
    // after the switch. We assert one did, AND that it carried the NEW company
    // header (this is the #856 pin at the request-event level).
    const freshC2 = productReqs
      .slice(countBeforeSwitch)
      .filter((p) => p.company === String(c2));
    expect(
      freshC2.length,
      `a fresh product-list request scoped to company ${c2} should have fired AFTER the switch`,
    ).toBeGreaterThan(0);

    // ── Concrete cross-company proof (multi-company staging only) ───────────
    if (multiCompany) {
      const prefixesC2 = await readSoDocPrefixes(page, STAGING_API_URL, c2);
      expect(prefixesC1.length, `company ${c1} should have SOs to compare`).toBeGreaterThan(0);
      expect(prefixesC2.length, `company ${c2} should have SOs to compare`).toBeGreaterThan(0);
      // Each company's document-number prefixes must be disjoint from the
      // other's — the SO list changed consistently with the company.
      const overlap = prefixesC1.filter((p) => prefixesC2.includes(p));
      expect(
        overlap,
        `SO doc-no prefixes must not overlap across companies (c${c1}=${prefixesC1.join(",")} c${c2}=${prefixesC2.join(",")})`,
      ).toHaveLength(0);
    } else {
      test.info().annotations.push({
        type: "isolation-scope",
        description:
          `Staging exposed ${companies.length} company/companies (< 2), so the concrete ` +
          `cross-company SO doc-no assertion could not run against real data. Asserted the ` +
          `switch MECHANICS instead: switching the active company fires a FRESH ` +
          `/mfg-products request carrying the new X-Company-Id (pins #856 — a switch must ` +
          `not serve the previous company's cached catalog). Re-run against multi-company ` +
          `staging for the concrete doc-no proof.`,
      });
    }
  });
});

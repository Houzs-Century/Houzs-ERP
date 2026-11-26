import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  canonicalRedirectUrl,
  CANONICAL_PROD_ORIGIN,
  LEGACY_PROD_HOST,
} from "./canonicalHost";

describe("canonicalRedirectUrl", () => {
  describe("redirects the production Pages host", () => {
    it("sends the bare root to the canonical origin", () => {
      expect(canonicalRedirectUrl(`https://${LEGACY_PROD_HOST}/`)).toBe(
        `${CANONICAL_PROD_ORIGIN}/`,
      );
    });

    it("preserves the path — the owner's reported /assistant hit", () => {
      expect(canonicalRedirectUrl(`https://${LEGACY_PROD_HOST}/assistant`)).toBe(
        `${CANONICAL_PROD_ORIGIN}/assistant`,
      );
    });

    it("preserves a deep document link so bookmarks survive", () => {
      expect(
        canonicalRedirectUrl(
          `https://${LEGACY_PROD_HOST}/scm/sales-orders/SO-2607-015`,
        ),
      ).toBe(`${CANONICAL_PROD_ORIGIN}/scm/sales-orders/SO-2607-015`);
    });

    it("preserves the query string", () => {
      expect(
        canonicalRedirectUrl(`https://${LEGACY_PROD_HOST}/settings?tab=email`),
      ).toBe(`${CANONICAL_PROD_ORIGIN}/settings?tab=email`);
    });

    it("preserves the hash (the #login-as hand-off relies on it)", () => {
      expect(
        canonicalRedirectUrl(`https://${LEGACY_PROD_HOST}/#login-as=abc123`),
      ).toBe(`${CANONICAL_PROD_ORIGIN}/#login-as=abc123`);
    });

    it("preserves query and hash together", () => {
      expect(
        canonicalRedirectUrl(
          `https://${LEGACY_PROD_HOST}/team?tab=members#top`,
        ),
      ).toBe(`${CANONICAL_PROD_ORIGIN}/team?tab=members#top`);
    });

    it("matches the host case-insensitively", () => {
      expect(canonicalRedirectUrl(`https://HOUZS-ERP.PAGES.DEV/assr`)).toBe(
        `${CANONICAL_PROD_ORIGIN}/assr`,
      );
    });
  });

  describe("leaves every other origin alone", () => {
    it("does NOT touch staging — it is a different Pages project on a different Supabase database", () => {
      expect(
        canonicalRedirectUrl("https://houzs-erp-staging.pages.dev/assr"),
      ).toBeNull();
    });

    it("does NOT touch erp.2990shome.com — hostname decides the default company", () => {
      expect(
        canonicalRedirectUrl("https://erp.2990shome.com/scm/sales-orders"),
      ).toBeNull();
    });

    it("does NOT touch preview deploys under the prod project", () => {
      expect(
        canonicalRedirectUrl("https://a1b2c3d4.houzs-erp.pages.dev/assr"),
      ).toBeNull();
    });

    it("does NOT touch preview deploys under the staging project", () => {
      expect(
        canonicalRedirectUrl(
          "https://a1b2c3d4.houzs-erp-staging.pages.dev/assr",
        ),
      ).toBeNull();
    });

    it("does not redirect the canonical domain to itself (no loop)", () => {
      expect(
        canonicalRedirectUrl(`${CANONICAL_PROD_ORIGIN}/assistant`),
      ).toBeNull();
    });

    it("leaves localhost dev alone", () => {
      expect(canonicalRedirectUrl("http://localhost:5173/assr")).toBeNull();
    });

    it("leaves the wrangler dev port alone", () => {
      expect(canonicalRedirectUrl("http://localhost:8787/assr")).toBeNull();
    });

    it("does not match a lookalike host that merely contains the name", () => {
      expect(
        canonicalRedirectUrl("https://houzs-erp.pages.dev.evil.example/assr"),
      ).toBeNull();
    });
  });

  describe("is total — never throws", () => {
    it("returns null for a malformed URL rather than throwing", () => {
      expect(canonicalRedirectUrl("not-a-url")).toBeNull();
      expect(canonicalRedirectUrl("")).toBeNull();
    });
  });

  describe("redirect target is self-consistent", () => {
    it("the canonical origin is itself a no-op (applying twice is stable)", () => {
      const once = canonicalRedirectUrl(`https://${LEGACY_PROD_HOST}/assr`);
      expect(once).not.toBeNull();
      expect(canonicalRedirectUrl(once!)).toBeNull();
    });

    it("targets the same origin the backend uses for email links", () => {
      expect(CANONICAL_PROD_ORIGIN).toBe("https://erp.houzscentury.com");
    });
  });

  describe("Pages Function copy stays in sync", () => {
    const fnSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../functions/[[path]].ts",
      ),
      "utf8",
    );

    it("uses the same legacy host constant", () => {
      expect(fnSource).toContain(`const LEGACY_PROD_HOST = "${LEGACY_PROD_HOST}"`);
    });

    it("uses the same canonical origin constant", () => {
      expect(fnSource).toContain(
        `const CANONICAL_PROD_ORIGIN = "${CANONICAL_PROD_ORIGIN}"`,
      );
    });

    it("redirects temporarily (302), never permanently (301)", () => {
      expect(fnSource).toContain("status: 302");
      expect(fnSource).not.toContain("status: 301");
    });

    it("still matches the host EXACTLY — no endsWith/includes creep", () => {
      expect(fnSource).toContain(
        "url.hostname.toLowerCase() !== LEGACY_PROD_HOST",
      );
    });

    it("redirects ONLY document navigations, so /sw.js + assets are never 302'd", () => {
      expect(fnSource).toContain("isDocumentNavigation");
      expect(fnSource).toContain("Sec-Fetch-Dest");
      expect(fnSource).toContain(
        "canonical && isDocumentNavigation(request, url)",
      );
    });
  });
});

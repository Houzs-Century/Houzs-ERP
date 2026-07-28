import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────────────
// Environment / targets
// ──────────────────────────────────────────────────────────────────────────
// `||` (not `??`) throughout: an unset CI secret/variable arrives as an empty
// string, and an empty string must fall back to the default — not be taken as
// a real (blank) value.
export const STAGING_BASE_URL =
  process.env.STAGING_BASE_URL || "https://houzs-erp-staging.pages.dev";
export const STAGING_API_URL =
  process.env.STAGING_API_URL ||
  "https://autocount-sync-api-staging.houzs-erp.workers.dev";

// ──────────────────────────────────────────────────────────────────────────
// Credentials
// ──────────────────────────────────────────────────────────────────────────
// Precedence:
//   1. CI secrets  STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD   (override)
//   2. the in-repo staging-seed fixture account                (fallback)
//
// The fallback is the PUBLIC staging owner account the team seeds so the
// baseline app is login-testable on staging — see
// backend/scripts/staging-seed-account.mjs (run via the "Staging Seed
// (one-off)" workflow). Staging is an isolated, disposable Supabase (its own
// Worker + DB, IMPERSONATION_ENABLED, no crons, no prod data), so this pair is
// a TEST FIXTURE, not a production secret; the same pair already lives in
// staging-seed-account.mjs, _staging-setup.mjs and seed-user-management.mjs.
//
// To run secrets-only: set the two secrets and clear these fallbacks. When both
// resolve empty, `credsConfigured` is false. Optional local runs skip with a
// clear annotation; automated required-proof runs fail closed.
export const E2E_EMAIL = process.env.STAGING_E2E_EMAIL || "hello@houzscentury.com";
export const E2E_PASSWORD = process.env.STAGING_E2E_PASSWORD || "houzs1234";
export const credsConfigured = E2E_EMAIL.length > 0 && E2E_PASSWORD.length > 0;

// True when BOTH credentials came from explicit secrets/env (not the in-repo
// fallback). This decides how a 401 is classified: owner-supplied credentials
// always fail red; fallback failure becomes the typed setup error below, whose
// disposition is controlled by the required-proof policy.
export const credsFromSecret =
  (process.env.STAGING_E2E_EMAIL || "").length > 0 &&
  (process.env.STAGING_E2E_PASSWORD || "").length > 0;

// Automated post-deploy/nightly runs set this to true. In that mode an
// unavailable environment or an unprovisioned fixture is a failed proof, not
// a passing run with the important tests skipped. Local exploratory runs keep
// the historical skip behavior unless the operator opts in explicitly.
export const stagingProofRequired =
  (process.env.STAGING_E2E_REQUIRE_PROOF || "").toLowerCase() === "true";

// ──────────────────────────────────────────────────────────────────────────
// localStorage keys the frontend reads. Duplicated here (not imported from
// src/) so this e2e package stays self-contained. Keep in sync with:
//   - the auth token store            → "auth:token"
// (There is deliberately NO active-company key here any more: since the
// per-window rework, src/lib/activeCompany.ts purges the old origin-wide
// `houzs.activeCompanyId` as legacy on auth, and the supported pre-auth
// hand-off is the `?company=<id>` URL seed — see company-isolation.spec.ts.)
// ──────────────────────────────────────────────────────────────────────────
export const AUTH_TOKEN_KEY = "auth:token";

// Raised when staging answers with a transient/unavailable status (a paused
// free-tier Supabase, a cold Worker, a 5xx). Optional local runs may skip it;
// an automated required proof fails because staging availability is evidence.
export class StagingUnavailableError extends Error {}

// Raised when the IN-REPO FALLBACK account (no owner-supplied secret) is not
// provisioned on this staging DB — i.e. login returns 401/403 with the
// fallback fixture. That is a setup gap (run the "Staging Seed (one-off)"
// workflow, or set STAGING_E2E_* secrets). Optional local runs may skip it;
// automated required proofs fail. A 401 with OWNER-SUPPLIED secrets is NOT
// wrapped: the owner asserted those are valid, so their failure surfaces red.
export class StagingAuthUnprovisionedError extends Error {}

// Both are skippable only for optional local exploration. Automated proofs
// set proofRequired=true and therefore fail closed.
export function isSkippableStagingErrorForPolicy(
  e: unknown,
  proofRequired: boolean,
): e is Error {
  return (
    !proofRequired &&
    (e instanceof StagingUnavailableError ||
      e instanceof StagingAuthUnprovisionedError)
  );
}

export function isSkippableStagingError(e: unknown): e is Error {
  return isSkippableStagingErrorForPolicy(e, stagingProofRequired);
}

export function missingCredentialsMaySkip(
  configured: boolean,
  proofRequired: boolean,
): boolean {
  if (configured) return false;
  if (proofRequired) {
    throw new Error(
      "Required staging proof has no usable credentials. Configure STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD or provision the documented staging fixture.",
    );
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// API login — fast path used to seed a session for the non-login specs.
// Returns the bearer token the frontend expects in localStorage["auth:token"].
// ──────────────────────────────────────────────────────────────────────────
export async function apiLogin(request: APIRequestContext): Promise<string> {
  let res;
  try {
    res = await request.post(`${STAGING_API_URL}/api/auth/login`, {
      data: { email: E2E_EMAIL, password: E2E_PASSWORD },
      timeout: 30_000,
    });
  } catch (e) {
    throw new StagingUnavailableError(
      `Staging API unreachable at ${STAGING_API_URL}: ${(e as Error).message}`,
    );
  }
  const status = res.status();
  if (status >= 500) {
    throw new StagingUnavailableError(
      `Staging API returned ${status} (likely a paused free-tier DB / cold Worker): ${await res.text()}`,
    );
  }
  if (status === 401 || status === 403) {
    const detail = await res.text();
    if (!credsFromSecret) {
      throw new StagingAuthUnprovisionedError(
        `The in-repo staging-seed account (${E2E_EMAIL}) is not valid on this staging DB (${status}: ${detail}). ` +
          `Run the "Staging Seed (one-off)" workflow to provision it as password "houzs1234", ` +
          `or set STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD to a known-good staging account.`,
      );
    }
    throw new Error(`Staging login failed with the supplied credentials: ${status} ${detail}`);
  }
  if (!res.ok()) {
    throw new Error(`Staging login failed: ${status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    token?: string;
    totp_required?: boolean;
  };
  if (body.totp_required === true) {
    throw new Error(
      "Staging test account has two-factor enabled — cannot seed a session headlessly. Use a non-TOTP staging account via STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD.",
    );
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("Staging login response contained no token.");
  }
  return body.token;
}

// Inject the bearer token into localStorage before any page script runs, so the
// app boots already authenticated. addInitScript re-runs on every navigation
// and reload in this context.
export async function seedAuth(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable — the spec's own assertions will surface it */
      }
    },
    [AUTH_TOKEN_KEY, token] as const,
  );
}

// Read a request's X-Company-Id header (Playwright lowercases header names).
// Returns null when absent rather than undefined so comparisons are explicit.
export function companyHeaderOf(headers: Record<string, string>): string | null {
  const v = headers["x-company-id"];
  return typeof v === "string" ? v : null;
}

// Fetch the SO summary list for a specific company (X-Company-Id stamped
// explicitly) from inside the page, and reduce doc numbers to their leading
// alpha prefix (e.g. "SO-2607-0001" -> "SO"). Used by the concrete
// cross-company isolation assertion. Returns a de-duplicated, sorted array;
// an empty array means "no comparable data" (the caller decides what that means).
export async function readSoDocPrefixes(
  page: Page,
  apiBase: string,
  companyId: number,
): Promise<string[]> {
  return page.evaluate(
    async ({ apiBase, companyId, tokenKey }) => {
      const token = window.localStorage.getItem(tokenKey);
      if (token === null) return [];
      const res = await fetch(`${apiBase}/api/scm/mfg-sales-orders?summary=1`, {
        headers: {
          authorization: `Bearer ${token}`,
          "X-Company-Id": String(companyId),
        },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { salesOrders?: Array<{ doc_no?: string }> };
      const rows = Array.isArray(body.salesOrders) ? body.salesOrders : [];
      const prefixes = new Set<string>();
      for (const row of rows) {
        const docNo = typeof row.doc_no === "string" ? row.doc_no : "";
        const m = docNo.match(/^[A-Za-z]+/);
        if (m) prefixes.add(m[0].toUpperCase());
      }
      return Array.from(prefixes).sort();
    },
    { apiBase, companyId, tokenKey: AUTH_TOKEN_KEY },
  );
}

// Fetch the companies this session can see (drives the switcher). Returns [] on
// any non-OK response — a single-company / not-yet-activated staging answers
// with an empty or single-entry list, which the isolation spec handles.
export async function readCompanies(
  page: Page,
  apiBase: string,
): Promise<Array<{ id: number; code: string; name: string }>> {
  return page.evaluate(
    async ({ apiBase, tokenKey }) => {
      const token = window.localStorage.getItem(tokenKey);
      if (token === null) return [];
      const res = await fetch(`${apiBase}/api/companies`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        companies?: Array<{ id: number; code: string; name: string }>;
      };
      return Array.isArray(body.companies) ? body.companies : [];
    },
    { apiBase, tokenKey: AUTH_TOKEN_KEY },
  );
}

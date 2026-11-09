// Staging sign-in hint, shared by the desktop and mobile login screens.
//
// The prod -> staging data copy (.github/workflows/staging-refresh-data.yml)
// destroys every production password hash, session and TOTP secret, so a
// tester's production password no longer opens staging. The only password that
// works there is the seeded staging test account; everyone else is reached
// through Team -> "Log in as" (IMPERSONATION_ENABLED on the staging Worker).
// Without this note a tester just sees "wrong password".

export const STAGING_PAGES_HOST = "houzs-erp-staging.pages.dev";
export const STAGING_TEST_ACCOUNT = "hello@houzscentury.com";

/** True on the staging Pages project and its preview subdomains, never on
 *  production (`erp.houzscentury.com`, `houzs-erp.pages.dev`). */
export function isStagingHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === STAGING_PAGES_HOST || h.endsWith(`.${STAGING_PAGES_HOST}`);
}

export const STAGING_SIGN_IN_TITLE = "Staging test site";

export const STAGING_SIGN_IN_TEXT =
  `Production passwords do not work here. Sign in with the staging test account ` +
  `${STAGING_TEST_ACCOUNT} (ask IT for its password), then use Team > "Log in as" ` +
  `to act as any other member.`;

export function currentHostIsStaging(): boolean {
  return typeof window !== "undefined" && isStagingHost(window.location.hostname);
}

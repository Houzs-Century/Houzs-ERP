import { test, expect } from "@playwright/test";
import {
  E2E_EMAIL,
  E2E_PASSWORD,
  credsConfigured,
  AUTH_TOKEN_KEY,
  apiLogin,
  isSkippableStagingError,
  missingCredentialsMaySkip,
  stagingProofRequired,
} from "./fixtures";

// PR #854's target copy, verbatim. The login screen deliberately does NOT
// reveal whether the email exists (anti-enumeration), so the same message
// covers a wrong password AND an unknown email.
const EXPECTED_BAD_CREDS_MESSAGE = "Email or password is incorrect.";

// Stable selectors against the real form (frontend/src/auth/AuthScreens.tsx):
//   email    -> <input type="email" ...>
//   password -> <input autocomplete="current-password" ...>  (PasswordInput)
//   submit   -> <button>Sign In</button>
const emailInput = 'input[type="email"]';
const passwordInput = 'input[autocomplete="current-password"]';

test.describe("auth", () => {
  test.beforeEach(() => {
    // Both tests need a well-formed email to get past the form's own
    // required/type=email validation; skip cleanly when no credential resolves.
    test.skip(
      missingCredentialsMaySkip(credsConfigured, stagingProofRequired),
      "Staging credentials not configured — set STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD (or the in-repo staging-seed fallback).",
    );
  });

  test("wrong password shows the exact plain-language error", async ({ page }) => {
    // CONCRETE assertion, intentionally ahead of the deploy: this pins PR #854.
    // Until #854 reaches staging the screen still reads "Password incorrect."
    // and this test is RED BY DESIGN — it is the executable spec for #854, not
    // a regression of today's staging. The workflow is non-required, so a red
    // here informs without blocking any merge.
    await page.goto("/");

    // The unauthenticated root renders the LoginScreen.
    await expect(page.locator(emailInput)).toBeVisible();

    await page.locator(emailInput).fill(E2E_EMAIL);
    await page.locator(passwordInput).fill(`wrong-${E2E_PASSWORD}-x`);
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(
      page.getByText(EXPECTED_BAD_CREDS_MESSAGE, { exact: true }),
    ).toBeVisible();

    // And we must NOT have been let in.
    const token = await page.evaluate((k) => window.localStorage.getItem(k), AUTH_TOKEN_KEY);
    expect(token).toBeNull();
  });

  test("valid login reaches the app shell", async ({ page, request }) => {
    // Settle credential validity up front via the API: a UI login cannot tell
    // "fallback fixture not provisioned on this staging DB" apart from "auth is
    // broken". When the fallback can't authenticate (or staging is asleep) we
    // skip; owner-supplied secrets that fail surface red from apiLogin.
    try {
      await apiLogin(request);
    } catch (e) {
      if (isSkippableStagingError(e)) {
        test.skip(true, e.message);
        return;
      }
      throw e;
    }

    await page.goto("/");
    await expect(page.locator(emailInput)).toBeVisible();

    await page.locator(emailInput).fill(E2E_EMAIL);
    await page.locator(passwordInput).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();

    // Reached the authed shell:
    //  1. the session token is now set (login actually succeeded), and
    //  2. the login form is gone, and
    //  3. the desktop TopNavbar rendered — its Account-menu trigger is part of
    //     the authed chrome on every page. NOT the Breadcrumb nav: since the
    //     2b top-chrome redesign the TopNavbar only pushes crumbs to context
    //     ("nothing renders them here today"), and Breadcrumbs.tsx returns
    //     null until a page sets crumbs — which the landing dashboard never
    //     does, so that assertion only ever passed by landing somewhere else.
    await expect
      .poll(async () => page.evaluate((k) => window.localStorage.getItem(k), AUTH_TOKEN_KEY), {
        message: "auth token should be set after a successful login",
        timeout: 15_000,
      })
      .not.toBeNull();
    await expect(page.locator(emailInput)).toBeHidden();
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  });
});

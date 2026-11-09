import { describe, expect, it } from "vitest";
import { STAGING_SIGN_IN_TEXT, STAGING_TEST_ACCOUNT, isStagingHost } from "./stagingSignIn";

describe("isStagingHost", () => {
  it("is true on the staging Pages host and its preview subdomains", () => {
    expect(isStagingHost("houzs-erp-staging.pages.dev")).toBe(true);
    expect(isStagingHost("HOUZS-ERP-STAGING.pages.dev")).toBe(true);
    expect(isStagingHost("a1b2c3d4.houzs-erp-staging.pages.dev")).toBe(true);
  });

  it("is false on production and on look-alike hosts", () => {
    expect(isStagingHost("erp.houzscentury.com")).toBe(false);
    expect(isStagingHost("houzs-erp.pages.dev")).toBe(false);
    expect(isStagingHost("localhost")).toBe(false);
    expect(isStagingHost("houzs-erp-staging.pages.dev.evil.example")).toBe(false);
    expect(isStagingHost("xhouzs-erp-staging.pages.dev")).toBe(false);
  });
});

describe("staging sign-in text", () => {
  it("names the test account and the Log in as route, and never a password", () => {
    expect(STAGING_SIGN_IN_TEXT).toContain(STAGING_TEST_ACCOUNT);
    expect(STAGING_SIGN_IN_TEXT).toContain('"Log in as"');
    expect(STAGING_SIGN_IN_TEXT).not.toMatch(/houzs1234/);
  });
});

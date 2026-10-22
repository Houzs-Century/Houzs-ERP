import { describe, expect, test } from "vitest";
import { publicUrl } from "../src/services/email";

// erp.2990shome.com is the old 2990 system's own site, not this app: an invite
// sent there opened a sign-in form instead of the set-password page.
describe("publicUrl for a 2990 email", () => {
  test("invite and reset links open this app, not erp.2990shome.com", () => {
    const env = { PUBLIC_APP_URL: "https://erp.houzscentury.com" } as any;
    expect(publicUrl(env, "/invite/abc", "2990")).toBe("https://erp.houzscentury.com/invite/abc");
    expect(publicUrl(env, "/reset/abc", "2990")).toBe("https://erp.houzscentury.com/reset/abc");
    expect(publicUrl({} as any, "/invite/abc", "2990")).toBe("https://erp.houzscentury.com/invite/abc");
  });
});

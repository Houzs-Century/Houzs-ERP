import { describe, it, expect } from "vitest";
import { HIDDEN_LINK, maskLoginLinks } from "./mail-outbox-mask";

describe("auto-sent log hides one-time sign-in links from non-admins", () => {
  it("masks invite and reset links, absolute or relative, in text and HTML", () => {
    const html = `<a href="https://erp.houzscentury.com/reset/xxxxxxxxxxxxxxxx">Reset</a> or /invite/yyyyyyyyyyyy`;
    const out = maskLoginLinks(html);
    expect(out).not.toMatch(/x{16}|y{12}/);
    expect(out.split(HIDDEN_LINK).length - 1).toBe(2);
  });

  it("masks the ?token= forms too (reset-password / accept-invite)", () => {
    const t = "Choose a new password: https://erp.example.com/reset-password?token=zzzzzzzzzzzzzzzz then /accept-invite?token=wwwwwwwwwwww";
    const out = maskLoginLinks(t);
    expect(out).not.toMatch(/z{16}|w{12}/);
  });

  it("leaves ordinary links and text alone", () => {
    const t = "Your delivery order DO-2611-001: https://erp.houzscentury.com/scm/delivery-orders/123 — survey /survey/abc";
    expect(maskLoginLinks(t)).toBe(t);
  });

  it("handles empty bodies", () => {
    expect(maskLoginLinks(null)).toBe("");
    expect(maskLoginLinks("")).toBe("");
  });
});

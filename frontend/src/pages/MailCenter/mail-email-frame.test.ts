import { describe, expect, it } from "vitest";
import { EMAIL_FRAME_SANDBOX, EMAIL_FRAME_SANDBOX_MEASURABLE, emailSrcDoc } from "./mail-email-frame";

describe("emailSrcDoc", () => {
  it("puts the new-tab base inside an existing head, after the doctype", () => {
    const out = emailSrcDoc('<!doctype html><html><head lang="en"><title>t</title></head><body>x</body></html>', "<style>a{}</style>");
    expect(out).toBe('<!doctype html><html><head lang="en"><base target="_blank"><meta charset="utf-8"><style>a{}</style><title>t</title></head><body>x</body></html>');
  });

  it("adds a head to an html element that has none", () => {
    expect(emailSrcDoc("<html><body>x</body></html>")).toBe('<html><head><base target="_blank"><meta charset="utf-8"></head><body>x</body></html>');
  });

  it("wraps a bare fragment in a whole document", () => {
    expect(emailSrcDoc("<p>x</p>")).toBe('<!doctype html><html><head><base target="_blank"><meta charset="utf-8"></head><body><p>x</p></body></html>');
  });

  it("never grants scripts", () => {
    expect(EMAIL_FRAME_SANDBOX).not.toContain("allow-scripts");
    expect(EMAIL_FRAME_SANDBOX_MEASURABLE).not.toContain("allow-scripts");
  });
});

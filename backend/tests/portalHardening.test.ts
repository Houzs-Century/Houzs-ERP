import { describe, expect, test } from "vitest";
import { timingSafeEqualStr } from "../src/services/auth";

// P0-1 portal hardening — the shared-secret comparison must be
// constant-time and strict. (The rate-limit brakes added alongside are
// covered by tests/rateLimit.test.ts's checkRateLimit suite.)

describe("timingSafeEqualStr", () => {
  test("equal strings match", () => {
    expect(timingSafeEqualStr("GUnpe8k1m5vp", "GUnpe8k1m5vp")).toBe(true);
  });

  test("differing content and differing length both fail", () => {
    expect(timingSafeEqualStr("secret-a", "secret-b")).toBe(false);
    expect(timingSafeEqualStr("secret", "secret-longer")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });

  test("empty vs empty matches (callers must reject empty expected first)", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  test("multibyte input compares by bytes, not code units", () => {
    expect(timingSafeEqualStr("密钥🔑", "密钥🔑")).toBe(true);
    expect(timingSafeEqualStr("密钥🔑", "密钥🔒")).toBe(false);
  });
});

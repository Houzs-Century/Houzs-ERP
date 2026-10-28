import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { checkRateLimit, clearRateLimit } from "../src/middleware/rateLimit";

// Login brute-force limiter (KV-backed). The vitest config now binds an
// isolated SESSION_CACHE KV so this exercises the real path, not fail-open.

async function login(email: string, password = "wrong") {
  const res = await SELF.fetch("https://test.local/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
    body: JSON.stringify({ email, password }),
  });
  return res.status;
}

describe("rate limiting", () => {
  beforeEach(async () => {
    // Clear any KV state from a previous test (keys are email:ip).
    await clearRateLimit({ env } as any, "login", "lockme@test.local:1.2.3.4");
  });

  test("login locks out after 10 attempts from the same email+IP", async () => {
    const email = "lockme@test.local";
    // 10 attempts: each is 401 (no such user) but counts toward the limit.
    for (let i = 0; i < 10; i++) {
      expect(await login(email)).toBe(401);
    }
    // 11th: over the cap → 429.
    expect(await login(email)).toBe(429);
  });

  test("a different IP has its own bucket", async () => {
    const email = "lockme@test.local";
    for (let i = 0; i < 10; i++) await login(email); // exhaust 1.2.3.4
    // Same email, different IP → still allowed (401, not 429).
    const res = await SELF.fetch("https://test.local/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
      body: JSON.stringify({ email, password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  test("checkRateLimit returns null (fail-open) when KV is absent", async () => {
    const noKv = { env: {} } as any;
    expect(await checkRateLimit(noKv, "x", "y")).toBeNull();
  });
});

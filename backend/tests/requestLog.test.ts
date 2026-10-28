import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

describe("request log / X-Request-Id", () => {
  test("responses carry a generated X-Request-Id", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status");
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect(id!.length).toBeGreaterThanOrEqual(8);
  });

  test("a client-provided X-Request-Id is echoed back", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status", {
      headers: { "X-Request-Id": "abcd1234" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("abcd1234");
  });

  test("unsafe or cardinality-amplifying request ids are replaced", async () => {
    const unsafe = ["has spaces", "x".repeat(65), "../trace", "short"];
    for (const candidate of unsafe) {
      const res = await SELF.fetch("https://test.local/api/auth/status", {
        headers: { "X-Request-Id": candidate },
      });
      const actual = res.headers.get("X-Request-Id");
      expect(actual).toMatch(/^[a-f0-9]{32}$/);
      expect(actual).not.toBe(candidate);
    }
  });

  test("CORS exposes the correlation id to browser clients", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status", {
      headers: { Origin: "https://erp.example.test" },
    });
    expect(res.headers.get("Access-Control-Expose-Headers"))
      .toContain("X-Request-Id");
  });

  test("CORS preflight permits the client correlation header", async () => {
    const res = await SELF.fetch("https://test.local/api/auth/status", {
      method: "OPTIONS",
      headers: {
        Origin: "https://erp.example.test",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-request-id",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")?.toLowerCase())
      .toContain("x-request-id");
  });
});

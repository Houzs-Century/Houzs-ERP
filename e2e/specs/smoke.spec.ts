import { test, expect, request } from "@playwright/test";
import { CFG, requireEnv, loginStaff, apiFor, apiJson } from "../lib/helpers";

// Light smoke tests — fast (<10s), no UI. Run these per commit as a
// canary before firing the full lifecycle.

test.describe("Smoke", () => {
  test.describe.configure({ mode: "serial" });

  test("public survey + portal endpoints reject unauth", async () => {
    const ctx = await request.newContext({ baseURL: CFG.API_URL });

    // Portal must require auth
    let r = await ctx.get("/portal/api/case");
    expect(r.status()).toBe(401);

    // Random token must be rejected
    r = await ctx.get("/portal/api/case", {
      headers: { Authorization: "Bearer fake-token" },
    });
    expect(r.status()).toBe(401);

    // /track with empty body → 400
    r = await ctx.post("/track", { data: {} });
    expect([400, 404]).toContain(r.status());

    await ctx.dispose();
  });

  test("staff auth works and common routes are reachable", async () => {
    requireEnv();
    const token = await loginStaff();
    const api = await apiFor(token);

    // /api/auth/me — should return the user
    const me = await apiJson<any>(api, "GET", "/api/auth/me");
    expect(me).toBeTruthy();

    // Core read endpoints all 2xx
    for (const path of [
      "/api/assr/summary",
      "/api/assr/metrics?since_days=30",
      "/api/suppliers",
    ]) {
      const r = await api.get(path);
      expect(r.ok(), `GET ${path} → ${r.status()}`).toBeTruthy();
    }

    await api.dispose();
  });
});

import { describe, it, expect } from "vitest";
import { classifyPath, leakCheckPaths, moduleCatalog, readablePaths, redactSecrets } from "./mcp-access";
import { consentAppLabel, pkceS256, validRedirectUri } from "./mcp-store";
import { publicOrigin } from "../routes/mcp";
import { isMcpInner, mcpInnerSecret } from "./mcp-inner";

describe("AI Connector access rules", () => {
  it("blocks sign-in, mail, sync and the connector itself; allows ERP modules", () => {
    for (const p of ["/api/auth/me", "/api/mail-center/threads", "/api/sync/pull", "/api/mcp", "/api/mcp-admin/admin/overview", "/api/totp", "/api/public/do-scan/x"]) {
      expect(classifyPath(p).ok).toBe(false);
    }
    expect(classifyPath("/api/scm/sales-orders")).toEqual({ ok: true, path: "/api/scm/sales-orders" });
    expect(classifyPath("/api/scm/../auth").ok).toBe(false);
    expect(classifyPath("/api/x%2f..").ok).toBe(false);
    expect(classifyPath("scm/sales-orders").ok).toBe(false);
  });

  it("strips credential-shaped fields at any depth and keeps business fields", () => {
    const { value, removed } = redactSecrets({ rows: [{ name: "A", password_hash: "x", nested: { api_key: "k", total: 5 } }], session_pass: "p" });
    expect(value).toEqual({ rows: [{ name: "A", nested: { total: 5 } }] });
    expect([...removed].sort()).toEqual(["api_key", "password_hash", "session_pass"]);
  });

  it("lists readable GET routes and groups /api/scm one level deeper", () => {
    const routes = [
      { method: "GET", path: "/api/scm/sales-orders" },
      { method: "GET", path: "/api/scm/sales-orders/:id" },
      { method: "POST", path: "/api/scm/sales-orders" },
      { method: "GET", path: "/api/auth/me" },
      { method: "GET", path: "/api/projects/*" },
      { method: "GET", path: "/api/projects" },
    ];
    expect(readablePaths(routes, "/api/scm/sales-orders")).toEqual(["/api/scm/sales-orders", "/api/scm/sales-orders/:id"]);
    expect(moduleCatalog(routes)).toEqual([
      { prefix: "/api/projects", endpoints: 1 },
      { prefix: "/api/scm/sales-orders", endpoints: 2 },
    ]);
    expect(leakCheckPaths(routes)).toEqual(["/api/projects", "/api/scm/sales-orders"]);
  });

  it("trusts only company hosts for the public address", () => {
    expect(publicOrigin("erp.houzscentury.com", "https://fallback")).toBe("https://erp.houzscentury.com");
    expect(publicOrigin("erp.2990shome.com", "https://fallback")).toBe("https://erp.2990shome.com");
    expect(publicOrigin("evil.example.com", "https://fallback")).toBe("https://fallback");
    expect(publicOrigin(undefined, "https://fallback")).toBe("https://fallback");
  });

  it("PKCE S256 matches RFC 7636 appendix B", async () => {
    expect(await pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("redirect URIs: https to claude.ai, claude.com or chatgpt.com, or loopback only (R&D 2026-11-27 #1)", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(validRedirectUri("http://localhost:6274/cb")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:33418/cb")).toBe(true);
    expect(validRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(validRedirectUri("https://evil.example.com/cb")).toBe(false);
    expect(validRedirectUri("https://claude.ai.evil.example/cb")).toBe(false);
    expect(validRedirectUri("http://claude.ai/cb")).toBe(false);
    expect(validRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("the consent page names the app by where it returns, not by the name it registered", () => {
    expect(consentAppLabel("Claude", "https://claude.ai/api/mcp/auth_callback")).toBe("Claude");
    expect(consentAppLabel("anything", "https://chatgpt.com/connector_platform_oauth_redirect")).toBe("ChatGPT");
    expect(consentAppLabel("Claude Official", "https://evil.example.com/cb")).toBe("AI app");
    expect(consentAppLabel("Claude Code", "http://localhost:6274/cb")).toBe("Claude Code (an app on this computer)");
  });

  it("the inner marker matches only this isolate's secret", () => {
    expect(isMcpInner(undefined)).toBe(false);
    const sec = mcpInnerSecret();
    expect(isMcpInner(sec)).toBe(true);
    expect(isMcpInner("0".repeat(sec.length))).toBe(false);
  });
});

describe("money fields by the ERP's own cohorts", () => {
  it("hides margin / profit / any cost from a non-finance, non-purchasing person", async () => {
    const { redactMoney } = await import("./mcp-access");
    const body = { rows: [{ soNo: "SO-1", totalSen: 100, unitCostSen: 60, marginPct: 40, contractor_cost: 5, cost_notes: "x" }] };
    const { value, removed } = redactMoney(body, { finance: false, productCost: false });
    expect(value).toEqual({ rows: [{ soNo: "SO-1", totalSen: 100 }] });
    expect([...removed].sort()).toEqual(["contractor_cost", "cost_notes", "marginPct", "unitCostSen"]);
  });

  it("Purchasing (product cost) sees unit cost but not margin or project cost", async () => {
    const { redactMoney } = await import("./mcp-access");
    const { value } = redactMoney({ unitCostSen: 60, costPriceSen: 50, grossProfitSen: 9, fin_total_cost: 3 }, { finance: false, productCost: true });
    expect(value).toEqual({ unitCostSen: 60, costPriceSen: 50 });
  });

  it("the finance cohort sees everything unchanged", async () => {
    const { redactMoney } = await import("./mcp-access");
    const body = { unitCostSen: 60, marginPct: 40 };
    expect(redactMoney(body, { finance: true, productCost: true }).value).toBe(body);
  });
});

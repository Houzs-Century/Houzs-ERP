import { describe, it, expect } from "vitest";
import { classifyPath, leakCheckPaths, moduleCatalog, readablePaths, redactSecrets } from "./mcp-access";
import { pkceS256, validRedirectUri } from "./mcp-store";
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

  it("redirect URIs: https, or http on loopback only", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("http://localhost:6274/cb")).toBe(true);
    expect(validRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(validRedirectUri("https://x.example/cb#frag")).toBe(false);
  });

  it("the inner marker matches only this isolate's secret", () => {
    expect(isMcpInner(undefined)).toBe(false);
    const sec = mcpInnerSecret();
    expect(isMcpInner(sec)).toBe(true);
    expect(isMcpInner("0".repeat(sec.length))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import type { AuthUser } from "./auth";
import { parseErpPath, runScreenTool, screenForPath, screensForLabels, SCREEN_PROMPTS, screenPromptText, SCREEN_TOOLS, whereIs } from "./mcp-screen";
import { NO_GUIDE_NOTE } from "./mcp-howto";
import { NO_PERMISSION_NOTE } from "./mcp-howto-types";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../routes/mcp";

function user(perms: string[], pageAccess: Record<string, string> = {}): AuthUser {
  return { id: 9, name: "Staff", status: "active", position_name: "Storekeeper", department_name: "Operations", permissions: perms, permissions_set: new Set(perms), page_access: pageAccess, scm_l2_configured: true } as unknown as AuthUser;
}
const owner = user(["*"]);
const ctx = (u: AuthUser) => ({ user: u, origin: "https://erp.test" });
const run = (u: AuthUser, name: string, args: Record<string, unknown>) => {
  const o = runScreenTool(ctx(u), name, args);
  return { ...o, body: JSON.parse(o.result.content[0].text) as Record<string, unknown> };
};

describe("explain_screen", () => {
  it("finds the page from a URL, a path, a detail id and a query variant", () => {
    expect(parseErpPath("https://erp.houzscentury.com/scm/grns/123?x=1")?.path).toBe("/scm/grns/123");
    expect(screenForPath("https://erp.test/scm/purchase-orders/new")?.path).toBe("/scm/purchase-orders/new");
    expect(screenForPath("/scm/grns/123")?.path).toBe("/scm/grns/:id");
    expect(screenForPath("/scm/sales-orders/new")?.path).toBe("/scm/sales-orders/new");
    expect(screenForPath("/nowhere")).toBeNull();
  });

  it("finds the page from screenshot labels", () => {
    const po = screenForPath("/scm/purchase-orders");
    expect(po).not.toBeNull();
    if (!po) return;
    const labels = [po.title, ...po.tabs.slice(0, 2), ...po.actions.slice(0, 3).map((a) => a.label)];
    expect(screensForLabels(labels)[0].screen.path).toBe("/scm/purchase-orders");
  });

  it("returns every button with canDo and a highlight link", () => {
    const o = run(owner, "explain_screen", { path: "/scm/purchase-orders" });
    const s = o.body.screen as { canOpen: boolean; actions: { canDo: boolean; link?: string }[] };
    expect(s.canOpen).toBe(true);
    expect(s.actions.length).toBeGreaterThan(3);
    expect(s.actions.every((a) => a.canDo)).toBe(true);
    expect(s.actions[0].link).toContain("highlight=");
  });

  it("canDo follows the person's ERP permissions", () => {
    const o = run(user([]), "explain_screen", { path: "/scm/purchase-orders" });
    const s = o.body.screen as { canOpen: boolean; note: string; actions: { canDo: boolean }[] };
    expect(s.canOpen).toBe(false);
    expect(s.note).toBe(NO_PERMISSION_NOTE);
    expect(s.actions.some((a) => a.canDo)).toBe(false);
    const buyer = run(user([], { "scm.procurement.po": "full" }), "explain_screen", { path: "/scm/purchase-orders" }).body.screen as { canOpen: boolean };
    expect(buyer.canOpen).toBe(true);
  });

  it("unknown screen logs a no-guide note", () => {
    expect(run(owner, "explain_screen", { visible_text: ["qqzz", "xxyy"] }).note).toBe(NO_GUIDE_NOTE);
  });
});

describe("where_is", () => {
  it("answers where to open common things, with the button to press", () => {
    expect(whereIs("new sales order")[0].screen.path.startsWith("/scm/sales-orders")).toBe(true);
    const m = whereIs("SO maintenance")[0];
    expect(m.screen.path === "/scm/sales-orders/maintenance" || m.action?.label === "SO Maintenance").toBe(true);
    expect(whereIs("where to open service case")[0].screen.path.startsWith("/assr")).toBe(true);
    expect(whereIs("purchase order")[0].screen.path.startsWith("/scm/purchase-orders")).toBe(true);
    const o = run(owner, "where_is", { thing: "new sales order" });
    const p = (o.body.places as { link: string; sidebar: string }[])[0];
    expect(p.link).toContain("https://erp.test/scm/sales-orders");
    expect(p.sidebar.length).toBeGreaterThan(0);
  });

  it("no match logs a no-guide note", () => {
    expect(run(owner, "where_is", { thing: "zzqqx blorp" }).note).toBe(NO_GUIDE_NOTE);
  });
});

describe("wiring", () => {
  it("tools, prompts and the screenshot instruction are registered", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const t of SCREEN_TOOLS) expect(names).toContain(t.name);
    expect(MCP_INSTRUCTIONS).toContain("explain_screen");
    for (const p of SCREEN_PROMPTS) expect(screenPromptText(p.name, { thing: "x", url: "/scm" })).toBeTruthy();
  });
});

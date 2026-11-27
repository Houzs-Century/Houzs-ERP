import { describe, it, expect } from "vitest";
import type { AuthUser } from "./auth";
import { HOWTO_PROMPTS, HOWTO_TOOLS, howtoPromptText, isHowtoTool, matchErrors, NO_GUIDE_NOTE, rank, redactQuestion, runHowtoTool } from "./mcp-howto";
import { HOWTO_GUIDES } from "./mcp-howto-guides";
import { canOpenPage, erpLink, gatePasses, gateForPage, NO_PERMISSION_NOTE } from "./mcp-howto-types";
import { readRepoFile } from "../../scripts/lib/frontend-honesty.mjs";
import { ROUTE_GUARDS_JSON, routeGuardsJson } from "../../scripts/lib/route-guards.mjs";
import { MCP_TOOLS } from "../routes/mcp";

function user(perms: string[], pageAccess: Record<string, string> = {}, position = "Storekeeper"): AuthUser {
  return { id: 9, name: "Staff", status: "active", position_name: position, department_name: "Operations", permissions: perms, permissions_set: new Set(perms), page_access: pageAccess, scm_l2_configured: true } as unknown as AuthUser;
}
const owner = user(["*"], {}, "Owner");
const nobody = user([], {}, "Driver");
const ctx = (u: AuthUser) => ({ user: u, origin: "https://erp.test" });
const run = (u: AuthUser, name: string, args: Record<string, unknown>) => {
  const o = runHowtoTool(ctx(u), name, args);
  return { ...o, body: JSON.parse(o.result.content[0].text) as Record<string, unknown> };
};
const topId = (q: string) => rank(HOWTO_GUIDES, q)[0]?.item.id;

describe("how_to ranking", () => {
  it("finds the right guide in English, Chinese and Malay", () => {
    expect(topId("how to open service case")).toBe("case-open");
    expect(topId("开PO")).toBe("po-create");
    expect(topId("terima barang GRN")).toBe("grn-receive");
    expect(topId("how do I create a sales order")).toBe("so-create");
    expect(topId("transfer stock to another warehouse")).toBe("stock-transfer");
    expect(topId("reply to an email in Mail Center")).toBe("mail-reply-assign");
  });

  it("returns 1-3 full guides with links that highlight the button", () => {
    const o = run(owner, "how_to", { question: "how to open service case" });
    const guides = o.body.guides as { id: string; link: string; canDo: boolean; steps: { link?: string }[] }[];
    expect(guides.length).toBeGreaterThanOrEqual(1);
    expect(guides.length).toBeLessThanOrEqual(3);
    expect(guides[0].id).toBe("case-open");
    expect(guides[0].canDo).toBe(true);
    expect(guides[0].link.startsWith("https://erp.test/")).toBe(true);
    expect(guides[0].steps.some((s) => (s.link ?? "").includes("highlight="))).toBe(true);
    expect(o.note).toBe("");
  });

  it("topic = id returns that guide", () => {
    const o = run(owner, "how_to", { topic: "flow-purchasing" });
    expect((o.body.guides as { id: string }[])[0].id).toBe("flow-purchasing");
  });

  it("no match lists the guide titles and logs a no-guide note without personal data", () => {
    const o = run(owner, "how_to", { question: "zzqx blorp for jane@x.com 0123456789" });
    expect(o.body.matched).toBe(false);
    expect((o.body.guides as unknown[]).length).toBe(HOWTO_GUIDES.length);
    expect(o.note).toBe(NO_GUIDE_NOTE);
    expect(o.target).not.toContain("jane@x.com");
    expect(o.target).not.toContain("0123456789");
  });
});

describe("canDo follows the ERP's own gates", () => {
  it("owner can do everything; a person with no access can do nothing gated", () => {
    for (const g of HOWTO_GUIDES) expect(canOpenPage(g.page, owner), g.id).toBe(true);
    const po = run(nobody, "how_to", { topic: "po-create" }).body.guides as { canDo: boolean; note?: string }[];
    expect(po[0].canDo).toBe(false);
    expect(po[0].note).toBe(NO_PERMISSION_NOTE);
  });

  it("an scm page grant opens exactly its area", () => {
    const buyer = user([], { "scm.procurement.po": "full" });
    expect(gatePasses({ kind: "scm", area: "scm.procurement.po" }, buyer)).toBe(true);
    expect(gatePasses({ kind: "scm", area: "scm.procurement.grn" }, buyer)).toBe(false);
  });

  it("flat permissions and page access gates", () => {
    expect(gatePasses({ kind: "perm", any: ["mail_center.read"] }, user(["mail_center.read"]))).toBe(true);
    expect(gatePasses({ kind: "perm", any: ["mail_center.read"] }, nobody)).toBe(false);
    expect(gatePasses({ kind: "page", page: "service_cases" }, user([], { service_cases: "partial" }))).toBe(true);
    expect(gatePasses({ kind: "page", page: "settings", minLevel: "full" }, user([], { settings: "partial" }))).toBe(false);
    expect(gatePasses({ kind: "open" }, nobody)).toBe(true);
  });
});

describe("route guards come from App.tsx", () => {
  it("mcp-route-guards.json is current (npm --prefix backend run gen:route-guards)", () => {
    expect(readRepoFile(ROUTE_GUARDS_JSON)).toBe(routeGuardsJson());
  });

  it("reads the guards the way App.tsx writes them", () => {
    expect(gateForPage("/scm/purchase-orders/new")).toEqual({ kind: "scm", area: "scm.procurement.po" });
    expect(gateForPage("/scm/sales-orders/HC-SO-1")).toEqual({ kind: "scm", area: "scm.sales.orders", allowSales: true });
    expect(gateForPage("/settings")).toEqual({ kind: "page", page: "settings", minLevel: "full" });
    expect(gateForPage("/mail-center?x=1")).toEqual({ kind: "perm", any: ["mail_center.read"] });
    expect(gateForPage("/no/such/page")).toEqual({ kind: "perm", any: ["*"] });
  });
});

describe("module_overview, glossary, explain_error, onboarding", () => {
  it("module_overview lists every module, and one module returns its pages", () => {
    const list = run(owner, "module_overview", {}).body.modules as unknown[];
    expect(list.length).toBeGreaterThan(10);
    const one = run(owner, "module_overview", { module: "Procurement" }).body.modules as { keyPages: unknown[] }[];
    expect(one.length).toBeGreaterThan(0);
    expect(one[0].keyPages.length).toBeGreaterThan(0);
  });

  it("glossary defines GRN and matches Chinese", () => {
    const t = run(owner, "glossary", { term: "GRN" }).body.terms as { term: string }[];
    expect(t[0].term).toBe("GRN");
    expect(run(owner, "glossary", { term: "nothingterm" }).note).toBe(NO_GUIDE_NOTE);
  });

  it("explain_error maps the backend's own text", () => {
    expect(matchErrors("Error: You don't have permission to do that.")[0]?.id).toBe("no-permission");
    const o = run(owner, "explain_error", { text: "qwerty uiop" });
    expect(o.note).toBe(NO_GUIDE_NOTE);
  });

  it("onboarding has the seven roles", () => {
    const roles = (run(owner, "onboarding", {}).body.roles as { role: string }[]).map((r) => r.role);
    expect(roles).toEqual(expect.arrayContaining(["outlet-sales", "2990s", "purchasing", "warehouse", "finance", "after-sales", "admin"]));
    const p = run(owner, "onboarding", { role: "purchasing" }).body;
    expect(p.role).toBe("purchasing");
  });
});

describe("wiring", () => {
  it("tools are registered and prompts render", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const t of HOWTO_TOOLS) {
      expect(names).toContain(t.name);
      expect(isHowtoTool(t.name)).toBe(true);
    }
    for (const p of HOWTO_PROMPTS) expect(howtoPromptText(p.name, { task: "open a service case", module: "Finance", term: "GRN", error: "x", role: "finance" })).toBeTruthy();
    expect(howtoPromptText("nope", {})).toBeNull();
  });

  it("links merge highlight into the query and skip :param pages", () => {
    expect(erpLink("https://e", "/assr?view=cases", "New Case")).toBe("https://e/assr?view=cases&highlight=New%20Case");
    expect(erpLink("https://e", "/scm/grns/:id", null)).toBeNull();
    expect(redactQuestion("call 012-345 6789 now")).toBe("call [number] now");
  });
});

import { describe, it, expect } from "vitest";
import type { AuthUser } from "./auth";
import { actionRoute, admitMcpWrite, armAction } from "./mcp-inner";
import { cacheTtlFor, HEAVY_CACHE_TTL_MS, ANSWER_CACHE_TTL_MS, TtlCache } from "./mcp-ratelimit";
import { ALL_OFF, type ActionSwitches } from "./mcp-store";
import { caseIdFrom, caseIdFromList, kindAllowed, kindOffText, pickThread, proposeMailReply, proposeNote, WRITE_TOOLS, writeOutcome } from "./mcp-write-actions";
import { outputSchemaFor, ROLE_PROMPTS, rolePromptText, toolVisible, visibleRolePrompts, visibleTools, withOutputSchemas, withStructured } from "./mcp-round4c";
import { MCP_TOOLS } from "../routes/mcp";

const ON: ActionSwitches = { master: true, mail_reply: true, note: true };

const thread = {
  thread: { id: "t-1", mailboxAddress: "sales@houzs.test", subject: "Quote for sofa", counterpartyEmail: "ann@cust.test", counterpartyName: "Ann", lastDirection: "inbound" },
  messages: [
    { id: "m1", direction: "outbound", fromAddress: "sales@houzs.test", createdAt: "2026-11-20T01:00:00Z" },
    { id: "m2", direction: "inbound", fromAddress: "ann@cust.test", fromName: "Ann", toAddresses: ["sales@houzs.test", "bob@cust.test"], ccAddresses: ["me@houzs.test", "Bob@cust.test"], textBody: "Can you deliver on Friday?", createdAt: "2026-11-26T02:00:00Z" },
  ],
};

function user(perms: string[], pageAccess: Record<string, string> = {}, l2 = true): AuthUser {
  return { id: 9, name: "Staff", status: "active", position_name: "Sales Executive", permissions: perms, permissions_set: new Set(perms), page_access: pageAccess, scm_l2_configured: l2 } as unknown as AuthUser;
}

describe("round 4b: propose_mail_reply", () => {
  it("replies only to people on the thread, the company or the person (R&D 2026-11-27 #2)", () => {
    expect(proposeMailReply({ body: "x", to: ["attacker@evil.test"] }, thread, [], "me@houzs.test")).toMatchObject({ ok: false });
    expect(proposeMailReply({ body: "x", cc: ["attacker@evil.test"] }, thread, [], "me@houzs.test")).toMatchObject({ ok: false });
    expect(proposeMailReply({ body: "x", to: ["BOB@cust.test"], cc: ["boss@houzscentury.com"] }, thread, [], "me@houzs.test")).toMatchObject({ ok: true });
  });

  it("replies to the last sender, shows thread, recipients and the draft, and guards against a reply sent since", () => {
    const p = proposeMailReply({ body: "Yes, Friday works." }, thread, ["sales@houzs.test", "me@houzs.test"], "me@houzs.test");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.path).toBe("/api/mail-center/threads/t-1/reply");
    expect(p.payload).toEqual({ text: "Yes, Friday works.", to: ["ann@cust.test"], cc: [], afterMessageId: "m2" });
    expect(p.summary).toContain('Thread: "Quote for sofa" with Ann <ann@cust.test>');
    expect(p.summary).toContain("From mailbox: sales@houzs.test");
    expect(p.summary).toContain("To: ann@cust.test");
    expect(p.summary).toContain("Subject: Re: Quote for sofa");
    expect(p.summary).toContain("Yes, Friday works.");
  });

  it("reply_all copies the others once, never our own mailboxes", () => {
    const p = proposeMailReply({ body: "Noted", reply_all: true }, thread, ["me@houzs.test"], "me@houzs.test");
    expect(p.ok && p.payload.cc).toEqual(["bob@cust.test"]);
  });

  it("refuses an empty reply and a bad address", () => {
    expect(proposeMailReply({ body: "  " }, thread, [], "me@houzs.test")).toMatchObject({ ok: false });
    expect(proposeMailReply({ body: "x", to: ["not-an-email"] }, thread, [], "me@houzs.test")).toMatchObject({ ok: false, error: "Not a valid email address: not-an-email" });
  });

  it("thread_search picks the one match, else lists the candidates", () => {
    expect(pickThread({ threads: [{ id: "t-1", subject: "Quote" }] }, "quote")).toEqual({ ok: true, id: "t-1" });
    const many = pickThread({ threads: [{ id: "t-1", subject: "Quote A" }, { id: "t-2", subject: "Quote B" }] }, "quote");
    expect(many.ok).toBe(false);
    expect(!many.ok && many.error).toContain("thread_id t-2");
    expect(pickThread({ threads: [] }, "x")).toMatchObject({ ok: false });
  });
});

describe("round 4b: propose_note (service case)", () => {
  it("builds the case-page note body and a readable summary", () => {
    const p = proposeNote({ note: "Customer called, asked for ETA", category: "customer" }, { case: { id: 42, assr_no: "ASSR-0042", customer_name: "Ann", stage: "qc" } });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.path).toBe("/api/assr/42/notes");
    expect(p.payload).toEqual({ note: "Customer called, asked for ETA", category: "customer" });
    expect(p.summary).toContain("service case ASSR-0042 (Ann, stage qc)");
  });

  it("refuses an empty note and an unknown category", () => {
    expect(proposeNote({ note: "" }, { case: { id: 1 } })).toMatchObject({ ok: false });
    expect(proposeNote({ note: "x", category: "money" }, { case: { id: 1 } })).toMatchObject({ ok: false });
  });

  it("reads a case id, a search id or a case number", () => {
    expect(caseIdFrom("42")).toEqual({ id: "42" });
    expect(caseIdFrom("assr_case:42")).toEqual({ id: "42" });
    expect(caseIdFrom("ASSR-0042")).toEqual({ number: "ASSR-0042" });
    expect(caseIdFrom("")).toBeNull();
    expect(caseIdFromList({ data: [{ id: 7, assr_no: "ASSR-0042X" }, { id: 8, assr_no: "assr-0042" }] }, "ASSR-0042")).toBe("8");
  });
});

describe("round 4b: switches, route fence and outcomes", () => {
  it("every new action defaults OFF and needs both the master switch and its own", () => {
    expect(ALL_OFF).toEqual({ master: false, mail_reply: false, note: false });
    expect(kindAllowed("mail_reply", ALL_OFF)).toBe(false);
    expect(kindAllowed("mail_reply", { master: true, mail_reply: false, note: true })).toBe(false);
    expect(kindAllowed("note", { master: false, mail_reply: true, note: true })).toBe(false);
    expect(kindAllowed("note", ON)).toBe(true);
    expect(kindAllowed("meeting", { master: true, mail_reply: false, note: false })).toBe(true);
    expect(kindOffText("note", { master: true, mail_reply: false, note: false })).toMatch(/notes to service cases .* switched off/);
  });

  it("the concrete path must fit the kind's route; ids that do not fit are refused", () => {
    expect(actionRoute("note", "42")).toEqual({ method: "POST", path: "/api/assr/42/notes" });
    expect(actionRoute("note", "42/../../payments")).toBeNull();
    expect(actionRoute("mail_reply", "a/b")).toBeNull();
    expect(actionRoute("note", null)).toBeNull();
    expect(actionRoute("payment", "1")).toBeNull();
    armAction("mcpx_n", "note", "tok", "/api/assr/42/notes", 0);
    expect(admitMcpWrite({ method: "POST", path: "/api/assr/43/notes", actionId: "mcpx_n", tokenId: "tok", now: 1 })).toBe(false);
  });

  it("the ERP's answer becomes one sentence", () => {
    expect(writeOutcome("note", 200, { ok: true })).toEqual({ ok: true, text: "Done: the note is on the service case timeline." });
    expect(writeOutcome("mail_reply", 200, { ok: true, queued: true }).text).toContain("queued");
    expect(writeOutcome("mail_reply", 409, { error: "Lee already replied." })).toMatchObject({ ok: false });
    expect(writeOutcome("note", 403, { error: "Forbidden" }).text).toMatch(/may not do this \(Forbidden\)/);
    expect(writeOutcome("mail_reply", 404, { error: "Thread not found" }).ok).toBe(false);
  });

  it("the action tools ask for confirmation and are not read-only", () => {
    for (const t of WRITE_TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(false);
      expect(t.description).toContain("Only call confirm_action after they explicitly say yes.");
    }
  });
});

describe("round 4c: role-aware tools/list", () => {
  const names = (u: AuthUser, sw: ActionSwitches) => visibleTools(MCP_TOOLS, u, sw).map((t) => t.name);

  it("a low-privilege salesperson does not see finance, HR, POS or inventory tools; the generic readers stay", () => {
    const rep = user(["service_cases.read"], { "scm.sales.orders": "view" });
    const list = names(rep, ALL_OFF);
    for (const hidden of ["payables_summary", "receivables_summary", "uninvoiced_deliveries", "attendance_today", "pos_sales", "inventory_summary", "stock_check", "po_overdue"]) expect(list).not.toContain(hidden);
    for (const kept of ["search", "fetch", "erp_get", "daily_brief", "so_overdue", "after_sales_sla", "company_report"]) expect(list).toContain(kept);
  });

  it("company_report is hidden when the role can read none of its sources", () => {
    expect(toolVisible("company_report", user([], { "scm.sales.orders": "view" }), ALL_OFF)).toBe(false);
    expect(toolVisible("company_report", user([], { "scm.finance.accounting": "view" }), ALL_OFF)).toBe(true);
  });

  it("the owner sees every read tool; action tools follow their switches", () => {
    const owner = user(["*"]);
    expect(names(owner, ALL_OFF).filter((n) => n.startsWith("propose_") || n.endsWith("_action"))).toEqual([]);
    expect(names(owner, { master: true, mail_reply: false, note: false })).toEqual(expect.arrayContaining(["propose_meeting", "propose_email", "confirm_action"]));
    expect(names(owner, { master: true, mail_reply: false, note: false })).not.toContain("propose_mail_reply");
    expect(names(owner, ON)).toEqual(expect.arrayContaining(["propose_mail_reply", "propose_note"]));
    expect(names(owner, ON)).toHaveLength(MCP_TOOLS.length);
  });

  it("propose_note is listed only for a role that may write service cases", () => {
    expect(toolVisible("propose_note", user(["service_cases.read"]), ON)).toBe(false);
    expect(toolVisible("propose_note", user(["service_cases.create"]), ON)).toBe(true);
  });
});

describe("round 4c: prompts, structured output, cache", () => {
  it("one prompt per role, each naming its tools, and only roles with a usable tool see it", () => {
    expect(ROLE_PROMPTS.map((p) => p.name)).toEqual(["owner_morning_report", "finance_review", "purchasing_review", "outlet_manager_review", "after_sales_review", "hr_today"]);
    for (const p of ROLE_PROMPTS) {
      const t = rolePromptText(p.name, { period: "last_month", company: "2990", outlet: "PJ" })!;
      for (const tool of p.tools) expect(t).toContain(tool);
    }
    expect(rolePromptText("nope", {})).toBeNull();
    expect(visibleRolePrompts(user(["*"]), ALL_OFF)).toHaveLength(6);
    expect(visibleRolePrompts(user([], { "scm.sales.orders": "view" }), ALL_OFF).map((p) => p.name)).not.toContain("finance_review");
  });

  it("quick answers carry an outputSchema and their JSON as structuredContent; the text stays", () => {
    const listed = withOutputSchemas(MCP_TOOLS);
    for (const n of ["sales_summary", "outlet_sales", "company_report", "inventory_summary", "after_sales_sla", "daily_brief"]) expect(listed.find((t) => t.name === n)?.outputSchema).toBeTruthy();
    expect(listed.find((t) => t.name === "erp_get")?.outputSchema).toBeUndefined();
    const r = withStructured("outlet_sales", { content: [{ type: "text" as const, text: '{"totals":{"salesRm":1}}' }] });
    expect(r.structuredContent).toEqual({ totals: { salesRm: 1 } });
    expect(r.content[0].text).toBe('{"totals":{"salesRm":1}}');
    expect(withStructured("outlet_sales", { content: [{ type: "text" as const, text: "no access" }], isError: true }).structuredContent).toBeUndefined();
    expect(withStructured("erp_get", { content: [{ type: "text" as const, text: "{}" }] }).structuredContent).toBeUndefined();
    expect(outputSchemaFor("company_report")).toMatchObject({ type: "object", additionalProperties: true });
    expect(JSON.stringify(outputSchemaFor("company_report"))).not.toContain("required");
  });

  it("heavy summaries are cached 60 s, the rest 30 s, per entry", () => {
    expect(cacheTtlFor("company_report")).toBe(HEAVY_CACHE_TTL_MS);
    expect(cacheTtlFor("so_overdue")).toBe(ANSWER_CACHE_TTL_MS);
    const c = new TtlCache<number>(60_000, 10);
    c.set("heavy", 1, 0, 60_000);
    c.set("light", 2, 0, 30_000);
    expect(c.get("light", 30_000)).toBeUndefined();
    expect(c.get("heavy", 59_999)).toBe(1);
  });
});

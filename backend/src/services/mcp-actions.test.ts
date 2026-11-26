import { describe, it, expect } from "vitest";
import { actionOutcome, exportAlive, flowAnchorFromId, flowAnchorFromSearch, myRange, parseWhen, pdfKind, pickDateAmount, proposeEmail, proposeMeeting, shapeFlow, type MeetingBootstrap } from "./mcp-actions";
import { admitMcpWrite, armAction, ARMED_TTL_MS } from "./mcp-inner";

const NOW = Date.parse("2026-11-26T02:00:00Z"); // 10:00 Malaysia time
const boot: MeetingBootstrap = {
  me: "u1",
  people: [
    { key: "u1", name: "Owner Tan", email: "owner@houzs.test" },
    { key: "u2", name: "Adrian Lee", email: "adrian@houzs.test" },
    { key: "u3", name: "Mei Ling", email: "meiling@houzs.test" },
    { key: "u4", name: "Mei Wong", email: "meiwong@houzs.test" },
  ],
  rooms: [
    { id: 1, name: "Board Room", active: true },
    { id: 2, name: "Small Room", active: true },
    { id: 3, name: "Old Room", active: false },
  ],
};

describe("propose_meeting", () => {
  it("reads Malaysia local time and builds the hub body", () => {
    const p = proposeMeeting({ title: "Supplier review", start: "2026-11-27T15:00", attendees: ["Adrian", "meiling@houzs.test", "guest@outside.test"], room: "board" }, boot, NOW);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.payload).toMatchObject({ title: "Supplier review", start: "2026-11-27T07:00:00.000Z", end: "2026-11-27T08:00:00.000Z", roomId: 1, organizer: "u1", attendees: ["u2", "u3"], guestEmails: ["guest@outside.test"], repeat: "none" });
    expect(p.summary).toContain("2026/11/27 15:00 to 16:00");
    expect(p.summary).toContain("Board Room");
    expect(p.summary).toContain("Outside guests");
  });

  it("refuses an ambiguous name, an unknown name, a past time and a bad room", () => {
    expect(proposeMeeting({ title: "x", start: "2026-11-27T15:00", attendees: ["Mei"] }, boot, NOW)).toMatchObject({ ok: false });
    expect(proposeMeeting({ title: "x", start: "2026-11-27T15:00", attendees: ["Nobody"] }, boot, NOW)).toMatchObject({ ok: false });
    expect(proposeMeeting({ title: "x", start: "2026-11-25T15:00" }, boot, NOW)).toMatchObject({ ok: false });
    expect(proposeMeeting({ title: "x", start: "2026-11-27T15:00", room: "Old Room" }, boot, NOW)).toMatchObject({ ok: false });
    expect(proposeMeeting({ title: "x", start: "2026-11-27T15:00", end: "2026-11-27T14:00" }, boot, NOW)).toMatchObject({ ok: false });
    expect(proposeMeeting({ title: "", start: "2026-11-27T15:00" }, boot, NOW)).toMatchObject({ ok: false });
  });

  it("parses offsets and rejects free text", () => {
    expect(parseWhen("2026-11-27T15:00+08:00")).toBe(Date.parse("2026-11-27T07:00:00Z"));
    expect(parseWhen("tomorrow 3pm")).toBeNull();
    expect(myRange(Date.parse("2026-11-27T07:30:00Z"), Date.parse("2026-11-27T09:00:00Z"))).toBe("2026/11/27 15:30 to 17:00");
  });
});

describe("propose_email", () => {
  const args = { to: ["buyer@client.test"], cc: ["boss@houzs.test"], subject: "Quotation", body: "Dear Sir,\nPlease find..." };

  it("uses the only mailbox, and never puts the body in the log line", () => {
    const p = proposeEmail(args, ["sales@houzs.test"]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.payload).toEqual({ fromAddress: "sales@houzs.test", to: ["buyer@client.test"], cc: ["boss@houzs.test"], subject: "Quotation", text: "Dear Sir,\nPlease find..." });
    expect(p.summary).toContain("Please find");
    expect(p.logLine).not.toContain("Please find");
    expect(p.logLine).toContain("+1");
  });

  it("refuses a mailbox the person may not use and asks when there are several", () => {
    expect(proposeEmail({ ...args, from_mailbox: "ceo@houzs.test" }, ["sales@houzs.test"])).toMatchObject({ ok: false });
    expect(proposeEmail(args, ["a@houzs.test", "b@houzs.test"])).toMatchObject({ ok: false });
    expect(proposeEmail({ ...args, from_mailbox: "B@houzs.test" }, ["a@houzs.test", "b@houzs.test"])).toMatchObject({ ok: true });
    expect(proposeEmail(args, [])).toMatchObject({ ok: false });
  });

  it("validates every address, the subject and the body", () => {
    expect(proposeEmail({ ...args, to: ["not-an-email"] }, ["s@h.test"])).toMatchObject({ ok: false });
    expect(proposeEmail({ ...args, subject: " " }, ["s@h.test"])).toMatchObject({ ok: false });
    expect(proposeEmail({ ...args, body: "" }, ["s@h.test"])).toMatchObject({ ok: false });
    expect(proposeEmail({ ...args, to: Array.from({ length: 21 }, (_, i) => `p${i}@x.test`) }, ["s@h.test"])).toMatchObject({ ok: false });
  });
});

describe("confirmed-action outcome and fence", () => {
  it("words the ERP's answer", () => {
    expect(actionOutcome("meeting", 201, { ids: [55], created: 1 })).toMatchObject({ ok: true });
    expect(actionOutcome("meeting", 409, { error: "Adrian is busy" }).text).toContain("clashes");
    expect(actionOutcome("email", 403, { error: "not allowed to send from x" })).toMatchObject({ ok: false });
    expect(actionOutcome("email", 201, { ok: true, queued: true }).text).toContain("queued");
  });

  it("an armed action expires and is single use", () => {
    const t = Date.now();
    armAction("mcpx_exp", "email", "tok", t);
    expect(admitMcpWrite({ method: "POST", path: "/api/mail-center/compose", actionId: "mcpx_exp", tokenId: "tok", now: t + ARMED_TTL_MS + 1 })).toBe(false);
    armAction("mcpx_once", "email", "tok", t);
    expect(admitMcpWrite({ method: "POST", path: "/api/mail-center/compose/", actionId: "mcpx_once", tokenId: "tok", now: t })).toBe(true);
    expect(admitMcpWrite({ method: "POST", path: "/api/mail-center/compose", actionId: "mcpx_once", tokenId: "tok", now: t })).toBe(false);
    armAction("mcpx_put", "email", "tok", t);
    expect(admitMcpWrite({ method: "PUT", path: "/api/mail-center/compose", actionId: "mcpx_put", tokenId: "tok", now: t })).toBe(false);
  });
});

describe("document_flow shaping", () => {
  it("resolves ids and search hits to a map anchor", () => {
    expect(flowAnchorFromId("sales_order:HC-SO-013402")).toEqual({ type: "so", id: "HC-SO-013402" });
    expect(flowAnchorFromId("grn:abc-1")).toEqual({ type: "grn", id: "abc-1" });
    expect(flowAnchorFromId("customer:12")).toBeNull();
    expect(flowAnchorFromId("HC-SO-013402")).toBeNull();
    const hits = { hits: [{ type: "customer", id: "9", title: "HC-DO-1 Sdn Bhd" }, { type: "sales_order", id: "HC-SO-2", title: "HC-SO-2" }, { type: "delivery_order", id: "d1", title: "HC-DO-1" }] };
    expect(flowAnchorFromSearch(hits, "hc-do-1")).toEqual({ type: "do", id: "d1", title: "HC-DO-1" });
    expect(flowAnchorFromSearch(hits, "zzz")).toEqual({ type: "so", id: "HC-SO-2", title: "HC-SO-2" });
  });

  it("picks date and amount from a detail reply, header nested or not", () => {
    expect(pickDateAmount({ do_number: "X", do_date: "2026-11-02T00:00:00Z", total_sen: 123456 })).toEqual({ date: "2026-11-02", amountRM: 1234.56 });
    expect(pickDateAmount({ header: { soDate: "2026-10-01", grandTotalSen: "5000" }, items: [] })).toEqual({ date: "2026-10-01", amountRM: 50 });
    expect(pickDateAmount({ items: [] })).toEqual({ date: null, amountRM: null });
  });

  it("orders links along the chain and words the steps", () => {
    const body = {
      nodes: [
        { key: "si:i1", type: "si", id: "i1", label: "HC-INV-9", status: "PAID", isAnchor: false },
        { key: "so:HC-SO-1", type: "so", id: "HC-SO-1", label: "HC-SO-1", status: "CLOSED", isAnchor: true },
        { key: "do:d1", type: "do", id: "d1", label: "HC-DO-5", status: "DELIVERED", isAnchor: false },
        { key: "payment:p1", type: "payment", id: "p1", label: "Cash RM100.00", status: null, isAnchor: false },
      ],
      edges: [
        { from: "so:HC-SO-1", to: "do:d1", kind: "full" },
        { from: "do:d1", to: "si:i1", kind: "partial" },
        { from: "si:i1", to: "payment:p1", kind: "payment" },
      ],
      degraded: ["dr"],
    };
    const out = shapeFlow(body, "https://erp.test", new Map([["do:d1", { date: "2026-11-03", amountRM: 100 }]]));
    expect(out.links.map((l) => l.number)).toEqual(["HC-SO-1", "HC-DO-5", "HC-INV-9", "Cash RM100.00"]);
    expect(out.links[0]).toMatchObject({ type: "Sales order", isAnchor: true, url: "https://erp.test/scm/sales-orders/HC-SO-1" });
    expect(out.links[1]).toMatchObject({ date: "2026-11-03", amountRM: 100 });
    expect(out.links[3].url).toBeNull();
    expect(out.steps).toEqual(["Sales order HC-SO-1 -> Delivery order HC-DO-5 (full transfer)", "Delivery order HC-DO-5 -> Sales invoice HC-INV-9 (partial transfer)", "Sales invoice HC-INV-9 -> Customer payment Cash RM100.00 (payment)"]);
    expect(out.incomplete).toEqual(["dr"]);
  });
});

describe("get_pdf plan", () => {
  it("prints server-side only where the ERP has a server print route", () => {
    expect(pdfKind("sales_order")?.print).toBeNull();
    expect(pdfKind("assr_case")?.print?.("12")).toBe("/api/assr-print/12?variant=customer");
    expect(pdfKind("project")).toMatchObject({ financeOnly: true });
    expect(pdfKind("customer")).toBeNull();
    expect(pdfKind("__proto__")).toBeNull();
  });

  it("export links die at their expiry", () => {
    expect(exportAlive(new Date(NOW + 1000).toISOString(), NOW)).toBe(true);
    expect(exportAlive(new Date(NOW - 1).toISOString(), NOW)).toBe(false);
    expect(exportAlive(undefined, NOW)).toBe(false);
  });
});

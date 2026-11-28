import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { auth, requireAnyPermission } from "./auth";
import { writeOutcome } from "../services/mcp-write-actions";
import { ACTION_ALLOWLIST, MCP_ACTION_HEADER, MCP_INNER_HEADER, armAction, mcpInnerSecret, rememberVerified } from "../services/mcp-inner";

const TOKEN = "hzmcp_test_token_write_fence";
const OTHER = "hzmcp_test_token_other";
const WRITER = "hzmcp_test_token_writer";
const user = { id: 7, name: "Tester", status: "active", permissions_set: new Set<string>() };

let writes = 0;
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/*", auth);
  app.post("/api/mail-center/threads/:id/reply", (c) => {
    writes += 1;
    return c.json({ ok: true, messageId: "m1", queued: false });
  });
  app.post("/api/assr/:id/notes", requireAnyPermission(["service_cases.write", "service_cases.create", "service_cases.manage"]), (c) => {
    writes += 1;
    return c.json({ ok: true });
  });
  app.post("/api/meetings/meetings", (c) => c.json({ reached: true }));
  app.post("/api/mail-center/compose", (c) => c.json({ reached: true }));
  app.post("/api/scm/mfg-sales-orders", (c) => c.json({ reached: true }));
  app.get("/api/scm/mfg-sales-orders", (c) => c.json({ reached: true }));
  return app;
}

const call = (app: Hono<{ Bindings: Env }>, method: string, path: string, headers: Record<string, string>) =>
  app.fetch(new Request(`https://erp.test${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } }), {} as Env);

describe("AI Connector write fence (middleware/auth.ts)", () => {
  rememberVerified(TOKEN, { tokenId: "mcpt_a", clientId: "c", user }, Date.now());
  rememberVerified(OTHER, { tokenId: "mcpt_b", clientId: "c", user }, Date.now());

  it("refuses a plain MCP token POST (no inner secret)", async () => {
    const res = await call(makeApp(), "POST", "/api/meetings/meetings", {});
    expect(res.status).toBe(403);
  });

  it("refuses an inner POST that carries no confirmed action", async () => {
    const res = await call(makeApp(), "POST", "/api/meetings/meetings", { [MCP_INNER_HEADER]: mcpInnerSecret() });
    expect(res.status).toBe(403);
  });

  it("refuses an action id that was never armed", async () => {
    const res = await call(makeApp(), "POST", "/api/meetings/meetings", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_never" });
    expect(res.status).toBe(403);
  });

  it("admits the armed action once, on its own allowlisted route", async () => {
    const app = makeApp();
    armAction("mcpx_ok", "meeting", "mcpt_a", "/api/meetings/meetings", Date.now());
    const h = { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_ok" };
    const first = await call(app, "POST", "/api/meetings/meetings", h);
    expect(first.status).toBe(200);
    const replay = await call(app, "POST", "/api/meetings/meetings", h);
    expect(replay.status).toBe(403);
  });

  it("refuses an armed action on a route outside the allowlist or of another kind", async () => {
    const app = makeApp();
    armAction("mcpx_so", "meeting", "mcpt_a", "/api/meetings/meetings", Date.now());
    expect((await call(app, "POST", "/api/scm/mfg-sales-orders", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_so" })).status).toBe(403);
    armAction("mcpx_kind", "meeting", "mcpt_a", "/api/meetings/meetings", Date.now());
    expect((await call(app, "POST", "/api/mail-center/compose", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_kind" })).status).toBe(403);
  });

  it("refuses an action armed for another connection", async () => {
    armAction("mcpx_other", "email", "mcpt_b", "/api/mail-center/compose", Date.now());
    const res = await call(makeApp(), "POST", "/api/mail-center/compose", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_other" });
    expect(res.status).toBe(403);
  });

  it("still serves inner reads", async () => {
    const res = await call(makeApp(), "GET", "/api/scm/mfg-sales-orders", { [MCP_INNER_HEADER]: mcpInnerSecret() });
    expect(res.status).toBe(200);
  });

  it("allowlists exactly the meeting, email, Mail Center reply and service-case note routes", () => {
    expect(ACTION_ALLOWLIST.map((r) => `${r.kind} ${r.method} ${r.path}`)).toEqual([
      "meeting POST /api/meetings/meetings",
      "email POST /api/mail-center/compose",
      "mail_reply POST /api/mail-center/threads/:id/reply",
      "note POST /api/assr/:id/notes",
    ]);
  });

  it("a proposal alone never writes: an unarmed reply is refused before the ERP route runs", async () => {
    writes = 0;
    const res = await call(makeApp(), "POST", "/api/mail-center/threads/t-1/reply", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_proposed_only" });
    expect(res.status).toBe(403);
    expect(writes).toBe(0);
  });

  it("a confirmed reply writes exactly once, only to the thread it was armed for", async () => {
    writes = 0;
    const app = makeApp();
    const h = { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_reply" };
    armAction("mcpx_reply", "mail_reply", "mcpt_a", "/api/mail-center/threads/t-1/reply", Date.now());
    expect((await call(app, "POST", "/api/mail-center/threads/t-2/reply", h)).status).toBe(403);
    armAction("mcpx_reply", "mail_reply", "mcpt_a", "/api/mail-center/threads/t-1/reply", Date.now());
    expect((await call(app, "POST", "/api/mail-center/threads/t-1/reply", h)).status).toBe(200);
    expect((await call(app, "POST", "/api/mail-center/threads/t-1/reply", h)).status).toBe(403);
    expect(writes).toBe(1);
  });

  it("a person without the ERP permission gets the ERP's own refusal on a confirmed note", async () => {
    writes = 0;
    armAction("mcpx_note", "note", "mcpt_a", "/api/assr/42/notes", Date.now());
    const res = await call(makeApp(), "POST", "/api/assr/42/notes", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_note" });
    expect(res.status).toBe(403);
    expect(writes).toBe(0);
    const out = writeOutcome("note", res.status, await res.json());
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Not done: the ERP says you may not do this/);
  });

  it("a person with the ERP permission adds the note once", async () => {
    writes = 0;
    rememberVerified(WRITER, { tokenId: "mcpt_w", clientId: "c", user: { ...user, id: 8, permissions_set: new Set(["service_cases.write"]) } }, Date.now());
    armAction("mcpx_note_ok", "note", "mcpt_w", "/api/assr/42/notes", Date.now());
    const res = await makeApp().fetch(new Request("https://erp.test/api/assr/42/notes", { method: "POST", headers: { authorization: `Bearer ${WRITER}`, [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_note_ok" } }), {} as Env);
    expect(res.status).toBe(200);
    expect(writes).toBe(1);
  });
});

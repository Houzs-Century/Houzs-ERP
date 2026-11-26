import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Env } from "../types";
import { auth } from "./auth";
import { ACTION_ALLOWLIST, MCP_ACTION_HEADER, MCP_INNER_HEADER, armAction, mcpInnerSecret, rememberVerified } from "../services/mcp-inner";

// The AI Connector's write fence at the auth gate: an hzmcp_ token reaches a
// non-GET route ONLY as the confirmed-action call (services/mcp-inner.ts).
const TOKEN = "hzmcp_test_token_write_fence";
const OTHER = "hzmcp_test_token_other";
const user = { id: 7, name: "Tester", status: "active", permissions_set: new Set<string>() };

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/*", auth);
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
    armAction("mcpx_ok", "meeting", "mcpt_a", Date.now());
    const h = { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_ok" };
    const first = await call(app, "POST", "/api/meetings/meetings", h);
    expect(first.status).toBe(200);
    const replay = await call(app, "POST", "/api/meetings/meetings", h);
    expect(replay.status).toBe(403);
  });

  it("refuses an armed action on a route outside the allowlist or of another kind", async () => {
    const app = makeApp();
    armAction("mcpx_so", "meeting", "mcpt_a", Date.now());
    expect((await call(app, "POST", "/api/scm/mfg-sales-orders", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_so" })).status).toBe(403);
    armAction("mcpx_kind", "meeting", "mcpt_a", Date.now());
    expect((await call(app, "POST", "/api/mail-center/compose", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_kind" })).status).toBe(403);
  });

  it("refuses an action armed for another connection", async () => {
    armAction("mcpx_other", "email", "mcpt_b", Date.now());
    const res = await call(makeApp(), "POST", "/api/mail-center/compose", { [MCP_INNER_HEADER]: mcpInnerSecret(), [MCP_ACTION_HEADER]: "mcpx_other" });
    expect(res.status).toBe(403);
  });

  it("still serves inner reads", async () => {
    const res = await call(makeApp(), "GET", "/api/scm/mfg-sales-orders", { [MCP_INNER_HEADER]: mcpInnerSecret() });
    expect(res.status).toBe(200);
  });

  it("allowlists exactly the meeting-create and email-send routes", () => {
    expect(ACTION_ALLOWLIST.map((r) => `${r.kind} ${r.method} ${r.path}`)).toEqual(["meeting POST /api/meetings/meetings", "email POST /api/mail-center/compose"]);
  });
});

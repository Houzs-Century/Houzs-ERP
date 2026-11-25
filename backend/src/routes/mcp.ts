// ---------------------------------------------------------------------------
// /api/mcp — the AI Connector (MCP server). Owner 2026-11-25 「把全部系统的mcp都complete掉」.
// Mounted ABOVE the auth gate in index.ts: every handler here does its own auth.
//
//   POST /api/mcp                    MCP Streamable HTTP (JSON-RPC, stateless), Bearer hzmcp_…
//   POST /api/mcp/oauth/register     OAuth dynamic client registration (public clients).
//   GET  /api/mcp/oauth/authorize    → the SPA's /ai-connect "Allow?" screen (routes/mcpAdmin.ts consent).
//   POST /api/mcp/oauth/token        authorization_code (PKCE S256) / refresh_token (rotating).
//   GET  /.well-known/oauth-*        discovery (wellKnown, mounted at the root; Pages forwards it).
//
// READ-ONLY and OWN-PERMISSIONS by construction: a tool call re-enters the
// whole app as a GET carrying the person's MCP token. middleware/auth.ts
// accepts an hzmcp_ token ONLY on that in-process call (a per-isolate secret
// header nobody outside can know) and ONLY for GET/HEAD, then runs every route
// as the real person — their permissions, page access and company scope.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { getUserById, type AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { MCP_INNER_HEADER, mcpInnerSecret } from "../services/mcp-inner";
import { classifyPath, moduleCatalog, readablePaths, redactSecrets, type RouteInfo } from "../services/mcp-access";
import {
  consumeCode,
  createAuthRequest,
  getClient,
  hasMcpAccess,
  issueTokens,
  logCall,
  MCP_ADMIN_PERMISSION,
  pkceS256,
  refreshTokens,
  registerClient,
  resolveAccessToken,
  validRedirectUri,
} from "../services/mcp-store";

type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// The whole app, for in-process tool calls; set by index.ts (importing it here would be circular).
type FetchApp = { fetch: (req: Request, env: Env, ctx?: unknown) => Response | Promise<Response>; routes: RouteInfo[] };
let appRef: FetchApp | null = null;
export function setMcpApp(a: FetchApp): void {
  appRef = a;
}
export function mcpAppRoutes(): RouteInfo[] {
  return appRef?.routes ?? [];
}

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_RESULT_CHARS = 60_000;
const SERVER_INFO = { name: "houzs-erp", title: "Houzs ERP", version: "1.0.0" };

/**
 * The address people use (erp.houzscentury.com / erp.2990shome.com). The Pages
 * proxy forwards /api/* to this Worker and stamps X-Forwarded-Host; only company
 * hosts are believed, anything else falls back to MCP_PUBLIC_ORIGIN.
 */
export function publicOrigin(forwardedHost: string | undefined, fallback: string): string {
  const h = (forwardedHost ?? "").toLowerCase().trim();
  const ok =
    h === "houzscentury.com" ||
    h.endsWith(".houzscentury.com") ||
    h === "2990shome.com" ||
    h.endsWith(".2990shome.com") ||
    /^([a-z0-9-]+\.)?houzs-erp(-staging)?\.pages\.dev$/.test(h);
  return ok ? `https://${h}` : fallback;
}
const originOf = (c: Context<HonoEnv>): string =>
  publicOrigin(c.req.header("x-forwarded-host"), (c.env as Env & { MCP_PUBLIC_ORIGIN?: string }).MCP_PUBLIC_ORIGIN || new URL(c.req.url).origin);

export const isMcpAdmin = (u: AuthUser): boolean => hasPermission(u.permissions_set, MCP_ADMIN_PERMISSION);

// ── discovery ───────────────────────────────────────────────────────────────

export function protectedResourceMetadata(origin: string) {
  return { resource: `${origin}/api/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: ["erp.read"], resource_name: "Houzs ERP" };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["erp.read"],
  };
}

export const mcpWellKnown = new Hono<HonoEnv>();
mcpWellKnown.get("/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(originOf(c))));
mcpWellKnown.get("/oauth-protected-resource/*", (c) => c.json(protectedResourceMetadata(originOf(c))));
mcpWellKnown.get("/oauth-authorization-server", (c) => c.json(authorizationServerMetadata(originOf(c))));
mcpWellKnown.get("/oauth-authorization-server/*", (c) => c.json(authorizationServerMetadata(originOf(c))));

// ── OAuth ───────────────────────────────────────────────────────────────────

app.post("/oauth/register", async (c) => {
  let body: { client_name?: unknown; redirect_uris?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "JSON body required" }, 400);
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (uris.length === 0 || uris.length > 5 || uris.some((u) => u.length > 500 || !validRedirectUri(u))) {
    return c.json({ error: "invalid_redirect_uri", error_description: "1-5 https redirect URIs required" }, 400);
  }
  const cl = await registerClient(c.env.DB, typeof body.client_name === "string" ? body.client_name : "AI app", uris);
  return c.json(
    {
      client_id: cl.clientId,
      client_name: cl.clientName,
      redirect_uris: cl.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

const plain = (msg: string, status: 400 | 403 = 400) =>
  new Response(`${msg}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

app.get("/oauth/authorize", async (c) => {
  const q = (k: string) => c.req.query(k) ?? "";
  const clientId = q("client_id");
  const redirectUri = q("redirect_uri");
  if (!clientId || !redirectUri) return plain("Invalid request: missing client or redirect address.");
  const cl = await getClient(c.env.DB, clientId);
  if (!cl) return plain("This AI app is not registered. Remove the connector and add it again.");
  if (!cl.redirectUris.includes(redirectUri)) return plain("Invalid request: the return address does not match this app.");
  if (q("response_type") !== "code") return plain("Only response_type=code is supported.");
  if (!q("code_challenge") || q("code_challenge_method") !== "S256") return plain("This app must use PKCE (S256).");
  const id = await createAuthRequest(c.env.DB, { clientId, redirectUri, state: q("state"), codeChallenge: q("code_challenge") });
  // The SPA signs the person in (or uses their session) and shows Allow / Cancel.
  return c.redirect(`${originOf(c)}/ai-connect?request=${encodeURIComponent(id)}`, 302);
});

app.post("/oauth/token", async (c) => {
  const ct = c.req.header("content-type") ?? "";
  let f: Record<string, string | undefined> = {};
  try {
    const b = ct.includes("application/json") ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
    for (const [k, v] of Object.entries(b)) if (typeof v === "string") f[k] = v;
  } catch {
    f = {};
  }
  const err = (error: string, desc: string, status: 400 | 401 = 400) => c.json({ error, error_description: desc }, status, { "Cache-Control": "no-store" });
  const clientId = f.client_id || "";
  if (!clientId || !(await getClient(c.env.DB, clientId))) return err("invalid_client", "Unknown client", 401);

  let userId: number;
  let issued: Awaited<ReturnType<typeof issueTokens>>;
  if (f.grant_type === "authorization_code") {
    if (!f.code || !f.code_verifier) return err("invalid_request", "code and code_verifier are required");
    const rec = await consumeCode(c.env.DB, f.code);
    if (!rec || rec.clientId !== clientId) return err("invalid_grant", "Code is invalid, used or expired");
    if (f.redirect_uri && f.redirect_uri !== rec.redirectUri) return err("invalid_grant", "redirect_uri mismatch");
    if ((await pkceS256(f.code_verifier)) !== rec.codeChallenge) return err("invalid_grant", "PKCE check failed");
    userId = rec.userId;
    issued = await issueTokens(c.env.DB, userId, clientId);
  } else if (f.grant_type === "refresh_token") {
    if (!f.refresh_token) return err("invalid_request", "refresh_token is required");
    const r = await refreshTokens(c.env.DB, f.refresh_token, clientId);
    if (!r) return err("invalid_grant", "Refresh token is invalid, revoked or expired");
    userId = r.userId;
    issued = r;
  } else {
    return err("unsupported_grant_type", "Use authorization_code or refresh_token");
  }
  const u = await getUserById(c.env, userId);
  if (!u || u.status !== "active" || !(await hasMcpAccess(c.env.DB, userId, isMcpAdmin(u)))) {
    return err("invalid_grant", "This account may not use the AI connector");
  }
  return c.json(
    { access_token: issued.accessToken, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refreshToken, scope: "erp.read" },
    200,
    { "Cache-Control": "no-store", Pragma: "no-cache" },
  );
});

// ── MCP endpoint ────────────────────────────────────────────────────────────

type Identity = { tokenId: string; clientId: string; user: AuthUser };
type RpcReq = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const INSTRUCTIONS = `You are connected to Houzs ERP (Houzs Century furniture retail + the 2990's POS: sales orders, projects / exhibitions, service cases (ASSR), purchasing, delivery, warehouse, accounting, HR, fleet) as the signed-in staff member.
Everything is READ-ONLY and limited to what this person may see in the ERP. Never guess figures a call did not return.
Start with list_modules, then list_endpoints for a module, then erp_get. Most of the trading ERP is under /api/scm/... (e.g. /api/scm/sales-orders, /api/scm/purchase-orders, /api/scm/delivery-orders). Use query parameters (dates YYYY-MM-DD, page/limit, search, status) to keep answers small.
Two companies share the ERP: HOUZS (default) and 2990 (the 2990's POS). Pass company "2990" to erp_get for 2990 data, if this person may see it.
If a call says "not available to your role" or "You don't have permission", tell the person they do not have permission for that data.`;

const TOOLS = [
  { name: "whoami", title: "Who am I connected as", description: "The ERP account this connection uses and its position.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "list_modules", title: "List ERP modules", description: "The ERP modules (API path prefixes) with how many read endpoints each has. Start here.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  {
    name: "list_endpoints",
    title: "List read endpoints",
    description: "Every readable GET endpoint under a module prefix (e.g. /api/scm/sales-orders), with :id style placeholders.",
    inputSchema: { type: "object", properties: { prefix: { type: "string", description: "Module prefix from list_modules" } }, required: ["prefix"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "erp_get",
    title: "Read from the ERP",
    description: "Read one ERP endpoint as the signed-in person (GET only) and return its JSON. Large replies are cut; narrow them with query parameters.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Endpoint path without query string, with real ids in place of :id, e.g. /api/scm/sales-orders" },
        query: { type: "object", description: "Query parameters, e.g. {\"from\":\"2026-11-01\",\"to\":\"2026-11-30\"}", additionalProperties: { type: ["string", "number", "boolean"] } },
        company: { type: "string", enum: ["HOUZS", "2990"], description: "Which company's data (default HOUZS)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

async function innerGet(c: Context<HonoEnv>, token: string, pathWithQuery: string, company: string | null): Promise<Response> {
  if (!appRef) throw new Error("MCP app not initialised");
  let ctx: unknown;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, [MCP_INNER_HEADER]: mcpInnerSecret(), accept: "application/json" };
  if (company) headers["X-Company-Id"] = company;
  return appRef.fetch(new Request(originOf(c) + pathWithQuery, { method: "GET", headers }), c.env, ctx);
}

/** Read one endpoint as the person; shared with the leak check (routes/mcpAdmin.ts). */
export async function readEndpoint(
  c: Context<HonoEnv>,
  token: string,
  rawPath: string,
  query: Record<string, unknown> | undefined,
  company: string | null,
): Promise<{ result: ToolResult; status: number; note: string; target: string; body: unknown; removed: string[] }> {
  const d = classifyPath(rawPath);
  if (!d.ok) return { result: text(d.reason, true), status: 400, note: "blocked path", target: rawPath, body: null, removed: [] };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || typeof v === "object") continue;
    qs.set(k, String(v));
  }
  const target = d.path + (qs.toString() ? `?${qs.toString()}` : "");
  const res = await innerGet(c, token, target, company);
  const ctype = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403) {
    return { result: text("Not available to your role: you do not have permission for this in the ERP.", true), status: res.status, note: "no permission", target, body: null, removed: [] };
  }
  if (!ctype.includes("json")) {
    return { result: text(`This endpoint returns a file (${ctype || "unknown type"}), not data. Open it in the ERP instead.`, true), status: res.status, note: "non-json", target, body: null, removed: [] };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { result: text(`The ERP sent a reply that could not be read (HTTP ${res.status}).`, true), status: 502, note: `unreadable reply: ${why}`.slice(0, 120), target, body: null, removed: [] };
  }
  if (res.status >= 400) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    return { result: text(`The ERP answered: ${msg}`, true), status: res.status, note: msg.slice(0, 120), target, body: null, removed: [] };
  }
  const { value, removed } = redactSecrets(body);
  let out = JSON.stringify(value);
  let cut = false;
  if (out.length > MAX_RESULT_CHARS) {
    out = out.slice(0, MAX_RESULT_CHARS);
    cut = true;
  }
  const notes: string[] = [];
  if (removed.size) notes.push(`Credential fields removed: ${[...removed].join(", ")}.`);
  if (cut) notes.push(`Reply cut at ${MAX_RESULT_CHARS} characters — narrow it with query parameters (dates, page/limit, search).`);
  return { result: text((notes.length ? notes.join(" ") + "\n" : "") + out), status: res.status, note: "", target, body: value, removed: [...removed] };
}

async function callTool(c: Context<HonoEnv>, id: Identity, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  let status = 200;
  let note = "";
  let target = "";
  let result: ToolResult;
  try {
    if (name === "whoami") {
      result = text(JSON.stringify({ name: id.user.name, email: id.user.email, position: id.user.position_name, department: id.user.department_name, readOnly: true }));
    } else if (name === "list_modules") {
      result = text(JSON.stringify({ readOnly: true, modules: moduleCatalog(mcpAppRoutes()), tip: "Call list_endpoints with a prefix, then erp_get. A module you may not open answers 'not available to your role'." }));
    } else if (name === "list_endpoints") {
      const prefix = String(args.prefix ?? "");
      target = prefix;
      const d = classifyPath(prefix);
      if (!d.ok) {
        result = text(d.reason, true);
        status = 400;
      } else {
        result = text(JSON.stringify({ prefix: d.path, endpoints: readablePaths(mcpAppRoutes(), d.path).slice(0, 300) }));
      }
    } else if (name === "erp_get") {
      // Passed through as the X-Company-Id pick; companyContext admits only a company this person holds.
      const company = typeof args.company === "string" && /^[A-Za-z0-9]{1,12}$/.test(args.company) ? args.company : null;
      const r = await readEndpoint(c, token, String(args.path ?? ""), (args.query as Record<string, unknown> | undefined) ?? undefined, company);
      result = r.result;
      status = r.status;
      note = r.note;
      target = (company ? `[${company}] ` : "") + r.target;
    } else {
      result = text(`Unknown tool: ${name}`, true);
      status = 400;
    }
  } catch (e) {
    result = text(`Failed: ${e instanceof Error ? e.message : String(e)}`, true);
    status = 500;
  }
  const done = logCall(c.env.DB, { tokenId: id.tokenId, userId: id.user.id, clientId: id.clientId, tool: name, target, status, ok: !result.isError, note, ms: Date.now() - t0 });
  try {
    c.executionCtx.waitUntil(done);
  } catch {
    await done;
  }
  return result;
}

async function handleRpc(c: Context<HonoEnv>, id: Identity, token: string, m: RpcReq): Promise<unknown> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      return reply(await callTool(c, id, token, String(m.params?.name ?? ""), (m.params?.arguments as Record<string, unknown> | undefined) ?? {}));
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      if (m.id === undefined || m.id === null || (m.method ?? "").startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method ?? ""}` } };
  }
}

/** The person behind a connector token, or null (unknown / revoked / inactive / access removed). */
export async function mcpIdentity(env: Env, token: string): Promise<Identity | null> {
  const row = await resolveAccessToken(env.DB, token);
  if (!row) return null;
  const user = await getUserById(env, row.userId);
  if (!user || user.status !== "active") return null;
  if (!(await hasMcpAccess(env.DB, user.id, isMcpAdmin(user)))) return null;
  return { tokenId: row.tokenId, clientId: row.clientId, user };
}

app.post("/", async (c) => {
  const token = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const id = token ? await mcpIdentity(c.env, token) : null;
  if (!id) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, 401, {
      "WWW-Authenticate": `Bearer realm="houzs-erp", resource_metadata="${originOf(c)}/.well-known/oauth-protected-resource/api/mcp"${token ? ', error="invalid_token"' : ""}`,
    });
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const msgs = Array.isArray(body) ? (body as RpcReq[]) : [body as RpcReq];
  const out: unknown[] = [];
  for (const m of msgs) {
    const r = await handleRpc(c, id, token, m);
    if (r) out.push(r);
  }
  if (out.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? out : out[0]);
});

// Stateless server: no server-initiated stream.
app.get("/", (c) => c.json({ error: "Use POST (MCP Streamable HTTP)." }, 405, { Allow: "POST" }));
app.delete("/", (c) => c.body(null, 405, { Allow: "POST" }));

export default app;

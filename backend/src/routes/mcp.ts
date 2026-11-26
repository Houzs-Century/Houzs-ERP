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
// OWN-PERMISSIONS by construction: a tool call re-enters the whole app as a GET
// carrying the person's MCP token. middleware/auth.ts accepts an hzmcp_ token
// ONLY on that in-process call (a per-isolate secret header nobody outside can
// know) and ONLY for GET/HEAD, then runs every route as the real person — their
// permissions, page access and company scope. The one exception is a confirmed
// action (book a meeting, send an email): propose_* stores it, the person says
// yes, confirm_action claims it once and makes ONE allowlisted POST
// (services/mcp-inner.ts ACTION_ALLOWLIST). Off unless an admin turns it on.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { getUserById, type AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { actionRoute, armAction, disarmAction, MCP_ACTION_HEADER, MCP_INNER_HEADER, mcpInnerSecret, recallVerified, rememberVerified } from "../services/mcp-inner";
import {
  ACTIONS_OFF,
  actionOutcome,
  EXPORT_KEY_RE,
  EXPORT_PREFIX,
  EXPORT_TTL_MS,
  exportAlive,
  flowAnchorFromId,
  flowAnchorFromSearch,
  MAX_CONFIRMED_PER_DAY,
  PENDING_TTL_MS,
  pdfKind,
  flowSpec,
  pickDateAmount,
  proposeEmail,
  proposeMeeting,
  readBootstrap,
  shapeFlow,
  type ActionKind,
  type Proposal,
} from "../services/mcp-actions";
import { isFinanceViewer, isProductCostViewer } from "../services/pmsAccess";
import { docTitle, fetchKind, myToday, parseFetchId, pickFields, PROMPTS, promptText, resolveWindow, searchResults, singleMonth, summariseDelivery, summariseSales, type Window } from "../services/mcp-quick";
import { classifyPath, moduleCatalog, readablePaths, redactMoney, redactSecrets, type RouteInfo } from "../services/mcp-access";
import {
  actionsEnabled,
  claimPendingAction,
  confirmedLastDay,
  consumeCode,
  createAuthRequest,
  createPendingAction,
  finishPendingAction,
  getClient,
  hasMcpAccess,
  issueTokens,
  logCall,
  MCP_ADMIN_PERMISSION,
  pkceS256,
  randomToken,
  refreshTokens,
  registerClient,
  resolveAccessToken,
  validRedirectUri,
} from "../services/mcp-store";

type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

type FetchApp = { fetch: (req: Request, env: Env, ctx?: unknown) => Response | Promise<Response>; routes: RouteInfo[] };
let appRef: FetchApp | null = null;
export function setMcpApp(a: FetchApp): void {
  appRef = a;
}
export function mcpAppRoutes(): RouteInfo[] {
  return appRef?.routes ?? [];
}

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_RESULT_CHARS = 30_000;
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


export type McpIdentity = { tokenId: string; clientId: string; user: AuthUser };
type Identity = McpIdentity;
type RpcReq = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export const MCP_INSTRUCTIONS = `You are connected to Houzs ERP (Houzs Century furniture retail + the 2990's POS: sales orders, projects / exhibitions, service cases (ASSR), purchasing, delivery, warehouse, accounting, HR, fleet) as the signed-in staff member.
Everything is limited to what this person may see and do in the ERP. Reading is the default; never guess figures a call did not return.
ANSWER FAST: use a quick answer first. It is one call and already summarised.
- Sales (a month, quarter or year; vs the same days of the previous period; by showroom, brand, salesperson, state; daily; top models; trend): sales_summary {period: "YYYY-MM" | "YYYY-Qn" | "YYYY"} or {from, to}.
- Deliveries (delivery orders and amount; vs the same days of the previous period; by region and lorry; daily; open process gaps such as delivery orders not closed or delivered but still owing): delivery_summary {period} or {from, to}.
- One document, customer or supplier by number or name, or the status of an order: search {query}, then fetch {id} for the full record.
- The chain of a document (sales order -> delivery orders -> invoices -> payments, and purchase orders -> goods received -> purchase invoices, or backwards from any of them): document_flow {number_or_id}.
- A document's PDF / printout: get_pdf {type, id} (ids from search).
Only when no quick answer fits: list_modules, then list_endpoints for a module, then erp_get. Most of the trading ERP is under /api/scm/... With erp_get pass "fields" (only the keys you need) and query parameters (dates YYYY-MM-DD, page/limit, search, status) to keep replies small.
Two companies share the ERP: HOUZS (default) and 2990 (the 2990's POS). Pass company "2990" to sales_summary, delivery_summary, search, fetch or erp_get for 2990 data, if this person may see it.
Money in the ERP is integer sen (RM x 100) unless a field says RM. Dates are Malaysia time.
If a call says "not available to your role" or "You don't have permission", tell the person they do not have permission for that data.
ACTIONS (only booking a meeting and sending an email; never orders, money, stock, approvals or deletes): call propose_meeting or propose_email, show the person the summary it returns word for word, and ask them to confirm. Only call confirm_action after they explicitly say yes in their own reply. If they want changes, propose again. If a tool says AI actions are switched off, tell them their admin has not turned actions on.`;

const readOnly = { readOnlyHint: true, openWorldHint: false };
const actionHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CONFIRM_RULE = "Show this summary to the person and ask them to confirm. Only call confirm_action after they explicitly say yes.";
const COMPANY_PARAM = { type: "string", enum: ["HOUZS", "2990"], description: "Which company's data (default HOUZS)" };
const PERIOD_PROPS = {
  period: { type: "string", description: "YYYY-MM, YYYY-Qn or YYYY. Default: this month (to today)." },
  from: { type: "string", description: "YYYY-MM-DD; with to, instead of period." },
  to: { type: "string", description: "YYYY-MM-DD; with from, instead of period." },
  company: COMPANY_PARAM,
};

export const MCP_TOOLS = [
  {
    name: "sales_summary",
    title: "Sales summary (quick answer)",
    description:
      "Sales for a month, quarter, year or date range in ONE call: orders and sales (RM), change vs the same days of the previous period, by showroom, brand, salesperson and state, daily figures, top models and a 6-month trend. Same numbers as the Sales Report.",
    inputSchema: { type: "object", properties: PERIOD_PROPS, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "delivery_summary",
    title: "Delivery summary (quick answer)",
    description:
      "Deliveries for a month, quarter, year or date range in ONE call: delivery orders and amount (RM), change vs the same days of the previous period, by region and lorry, daily figures, a 6-month trend and today's process gaps (not closed, no cost, delivered but still owing). Same numbers as the Logistic Overview.",
    inputSchema: { type: "object", properties: PERIOD_PROPS, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "search",
    title: "Search the ERP",
    description: "Find sales orders, delivery orders, invoices, purchase orders, GRNs, customers, suppliers, service cases, projects and more by number or name. Returns ids to open with fetch.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "A document number, customer, supplier, product or project name" }, company: COMPANY_PARAM }, required: ["query"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "fetch",
    title: "Open a search result",
    description: "The full record for an id returned by search (e.g. \"sales_order:HC-SO-013402\"): a sales order with its lines and status, an invoice, a customer, a service case...",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "An id from search" }, company: COMPANY_PARAM }, required: ["id"], additionalProperties: false },
    annotations: readOnly,
  },
  { name: "whoami", title: "Who am I connected as", description: "The ERP account this connection uses and its position.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: readOnly },
  { name: "list_modules", title: "List ERP modules", description: "The ERP modules (API path prefixes) with how many read endpoints each has. Use when no quick answer fits.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: readOnly },
  {
    name: "list_endpoints",
    title: "List read endpoints",
    description: "Every readable GET endpoint under a module prefix (e.g. /api/scm/sales-orders), with :id style placeholders.",
    inputSchema: { type: "object", properties: { prefix: { type: "string", description: "Module prefix from list_modules" } }, required: ["prefix"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "erp_get",
    title: "Read from the ERP",
    description: "Read one ERP endpoint as the signed-in person (GET only) and return its JSON. Large replies are cut; pass fields and narrow them with query parameters.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Endpoint path without query string, with real ids in place of :id, e.g. /api/scm/sales-orders" },
        query: { type: "object", description: "Query parameters, e.g. {\"from\":\"2026-11-01\",\"to\":\"2026-11-30\"}", additionalProperties: { type: ["string", "number", "boolean"] } },
        fields: { type: "array", items: { type: "string" }, description: "Only keep these keys (at any depth), e.g. [\"doc_no\",\"status\",\"total_sen\"]. Makes big replies small and fast." },
        company: COMPANY_PARAM,
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "document_flow",
    title: "Document flow (sales order to payment, purchase order to purchase invoice)",
    description:
      "The whole chain around one document, forwards and backwards: sales order -> delivery orders -> invoices -> customer payments, and purchase orders -> goods received -> purchase invoices, with returns. Each link has its type, number, status, date, amount (RM) and ERP link. Give a document number (e.g. HC-SO-013402) or an id from search.",
    inputSchema: { type: "object", properties: { number_or_id: { type: "string", description: "A document number, or an id from search such as sales_order:HC-SO-013402" }, company: COMPANY_PARAM }, required: ["number_or_id"], additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_pdf",
    title: "PDF / printout of a document",
    description:
      "A document's printout. A service case (customer copy) or a project debrief comes back as a download link valid for 15 minutes (open it, then print or save as PDF). Sales orders, delivery orders, invoices, purchase orders and the other trading documents make their PDF in the browser: you get the ERP page link, and the person presses Print / PDF there.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["sales_order", "delivery_order", "sales_invoice", "purchase_order", "grn", "purchase_invoice", "credit_note", "delivery_return", "payment_voucher", "assr_case", "project"],
          description: "The kind of document (the part before ':' in a search id)",
        },
        id: { type: "string", description: "The id (the part after ':' in a search id)" },
        company: COMPANY_PARAM,
      },
      required: ["type", "id"],
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "propose_meeting",
    title: "Propose a meeting (the person confirms)",
    description: `Prepare a meeting in the ERP calendar for the signed-in person (they are the organiser). Nothing is booked yet: it returns a summary and a confirmationId. ${CONFIRM_RULE} start / end: "YYYY-MM-DDTHH:MM" in Malaysia time (end defaults to one hour later). attendees: staff names or emails; an email that is not a staff member becomes an outside guest who gets an invitation email.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "YYYY-MM-DDTHH:MM, Malaysia time" },
        end: { type: "string", description: "YYYY-MM-DDTHH:MM, Malaysia time (default: one hour after start)" },
        attendees: { type: "array", items: { type: "string" }, description: "Staff names or emails; outside emails become guests" },
        room: { type: "string", description: "Meeting room name (optional)" },
        notes: { type: "string" },
        company: COMPANY_PARAM,
      },
      required: ["title", "start"],
      additionalProperties: false,
    },
    annotations: actionHint,
  },
  {
    name: "propose_email",
    title: "Propose an email (the person confirms)",
    description: `Prepare an email from one of the person's own Mail Center mailboxes. Nothing is sent yet: it returns a summary and a confirmationId. ${CONFIRM_RULE} Once confirmed the email leaves the company. Plain text, no attachments.`,
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text" },
        from_mailbox: { type: "string", description: "Which of the person's mailboxes to send from (needed when they have more than one)" },
        company: COMPANY_PARAM,
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    annotations: actionHint,
  },
  {
    name: "confirm_action",
    title: "Do a confirmed action",
    description: "Book the meeting or send the email prepared by propose_meeting / propose_email. ONLY after the person has seen the summary and explicitly said yes. Each confirmationId works once, within 10 minutes.",
    inputSchema: { type: "object", properties: { confirmationId: { type: "string" } }, required: ["confirmationId"], additionalProperties: false },
    annotations: actionHint,
  },
  {
    name: "cancel_action",
    title: "Cancel a proposed action",
    description: "Throw away a proposal the person does not want.",
    inputSchema: { type: "object", properties: { confirmationId: { type: "string" } }, required: ["confirmationId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

async function innerCall(c: Context<HonoEnv>, token: string, pathWithQuery: string, company: string | null, write: { actionId: string; method: string; body: unknown } | null): Promise<Response> {
  if (!appRef) throw new Error("MCP app not initialised");
  let ctx: unknown;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, [MCP_INNER_HEADER]: mcpInnerSecret(), accept: "application/json" };
  if (company) headers["X-Company-Id"] = company;
  if (!write) return appRef.fetch(new Request(originOf(c) + pathWithQuery, { method: "GET", headers }), c.env, ctx);
  headers[MCP_ACTION_HEADER] = write.actionId;
  headers["content-type"] = "application/json";
  return appRef.fetch(new Request(originOf(c) + pathWithQuery, { method: write.method, headers, body: JSON.stringify(write.body) }), c.env, ctx);
}
const innerGet = (c: Context<HonoEnv>, token: string, pathWithQuery: string, company: string | null) => innerCall(c, token, pathWithQuery, company, null);

type ReadValue =
  | { ok: true; status: number; value: unknown; removed: string[]; target: string }
  | { ok: false; status: number; message: string; note: string; target: string };

async function readValue(c: Context<HonoEnv>, token: string, rawPath: string, query: Record<string, unknown> | undefined, company: string | null): Promise<ReadValue> {
  const d = classifyPath(rawPath);
  if (!d.ok) return { ok: false, status: 400, message: d.reason, note: "blocked path", target: rawPath };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || typeof v === "object") continue;
    qs.set(k, String(v));
  }
  const target = d.path + (qs.toString() ? `?${qs.toString()}` : "");
  const res = await innerGet(c, token, target, company);
  const ctype = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, message: "Not available to your role: you do not have permission for this in the ERP.", note: "no permission", target };
  }
  if (!ctype.includes("json")) {
    return { ok: false, status: res.status, message: `This endpoint returns a file (${ctype || "unknown type"}), not data. Open it in the ERP instead.`, note: "non-json", target };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `The ERP sent a reply that could not be read (HTTP ${res.status}).`, note: `unreadable reply: ${why}`.slice(0, 120), target };
  }
  if (res.status >= 400) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    return { ok: false, status: res.status, message: `The ERP answered: ${msg}`, note: msg.slice(0, 120), target };
  }
  const { value: noSecrets, removed } = redactSecrets(body);
  const who = recallVerified<McpIdentity>(token, Date.now())?.user ?? (await mcpIdentity(c.env, token))?.user ?? null;
  const sight = { finance: !!who && isFinanceViewer(who), productCost: !!who && isProductCostViewer(who) };
  const money = redactMoney(noSecrets, sight);
  for (const k of money.removed) removed.add(k);
  return { ok: true, status: res.status, value: money.value, removed: [...removed], target };
}

/** Read one endpoint as the person, as tool text; shared with the leak check (routes/mcpAdmin.ts). */
export async function readEndpoint(
  c: Context<HonoEnv>,
  token: string,
  rawPath: string,
  query: Record<string, unknown> | undefined,
  company: string | null,
  fields: readonly string[],
): Promise<{ result: ToolResult; status: number; note: string; target: string; body: unknown; removed: string[] }> {
  const r = await readValue(c, token, rawPath, query, company);
  if (!r.ok) return { result: text(r.message, true), status: r.status, note: r.note, target: r.target, body: null, removed: [] };
  let out = JSON.stringify(pickFields(r.value, fields));
  let cut = false;
  if (out.length > MAX_RESULT_CHARS) {
    out = out.slice(0, MAX_RESULT_CHARS);
    cut = true;
  }
  const notes: string[] = [];
  if (r.removed.length) notes.push(`Credential fields removed: ${r.removed.join(", ")}.`);
  if (cut) notes.push(`Reply cut at ${MAX_RESULT_CHARS} characters. Pass "fields" and narrow it with query parameters (dates, page/limit, search), or use a quick answer.`);
  return { result: text((notes.length ? notes.join(" ") + "\n" : "") + out), status: r.status, note: "", target: r.target, body: r.value, removed: r.removed };
}

const companyArg = (args: Record<string, unknown>): string | null =>
  typeof args.company === "string" && /^[A-Za-z0-9]{1,12}$/.test(args.company) ? args.company : null;

type Outcome = { result: ToolResult; status: number; note: string; target: string };

function quick(target: string, main: ReadValue, summary: () => unknown): Outcome {
  if (!main.ok) return { result: text(main.message, true), status: main.status, note: main.note, target };
  return { result: text(JSON.stringify(summary())), status: 200, note: "", target };
}

const valueOf = (r: ReadValue): unknown => (r.ok ? r.value : null);
const BAD_WINDOW = "Give period as YYYY-MM, YYYY-Qn or YYYY (not in the future), or from and to as YYYY-MM-DD (from before to, at most 400 days).";

async function salesSummary(c: Context<HonoEnv>, token: string, w: Window, company: string | null): Promise<Outcome> {
  const fair = (r: { from: string; to: string }) => readValue(c, token, "/api/scm/reports/fair-report", { stage: "so", date_from: r.from, date_to: r.to }, company);
  const month = singleMonth(w);
  const [cur, prev, analysis] = await Promise.all([fair(w), fair(w.prev), readValue(c, token, "/api/scm/sales-analysis", { period: month ?? w.to.slice(0, 7) }, company)]);
  const a = valueOf(analysis);
  const trendOnly = { monthly: (a as { monthly?: unknown } | null)?.monthly };
  return quick(`sales:${w.from}..${w.to}`, cur, () => summariseSales(w, valueOf(cur), valueOf(prev), month ? a : trendOnly, w.to.slice(0, 7)));
}

async function deliverySummary(c: Context<HonoEnv>, token: string, w: Window, company: string | null): Promise<Outcome> {
  const [cur, prev] = await Promise.all([
    readValue(c, token, "/api/scm/logistic-overview", { from: w.from, to: w.to }, company),
    readValue(c, token, "/api/scm/logistic-overview", { from: w.prev.from, to: w.prev.to }, company),
  ]);
  return quick(`delivery:${w.from}..${w.to}`, cur, () => summariseDelivery(w, valueOf(cur), valueOf(prev)));
}

async function searchTool(c: Context<HonoEnv>, token: string, query: string, company: string | null): Promise<Outcome> {
  const target = `search:${query}`.slice(0, 200);
  if (!query) return { result: text("Give something to search for: a document number or a name.", true), status: 400, note: "", target };
  const r = await readValue(c, token, "/api/search", { q: query }, company);
  if (!r.ok) return { result: text(r.message, true), status: r.status, note: r.note, target };
  const degraded = (r.value as { degraded?: unknown }).degraded;
  const out: Record<string, unknown> = { results: searchResults(r.value, originOf(c), 20) };
  if (Array.isArray(degraded) && degraded.length) out.couldNotSearch = degraded;
  return { result: text(JSON.stringify(out)), status: 200, note: "", target };
}

async function fetchTool(c: Context<HonoEnv>, token: string, rawId: unknown, company: string | null): Promise<Outcome> {
  const f = parseFetchId(rawId);
  const target = `fetch:${String(rawId ?? "")}`.slice(0, 200);
  if (!f) return { result: text("Give an id from search, e.g. sales_order:HC-SO-013402.", true), status: 400, note: "", target };
  const spec = fetchKind(f.kind);
  if (!spec) return { result: text(`A ${f.kind.replace(/_/g, " ")} has no record to open here; use its link from search.`, true), status: 400, note: "", target };
  const r = await readValue(c, token, spec.api(f.rowId), undefined, company);
  if (!r.ok) return { result: text(r.message, true), status: r.status, note: r.note, target };
  let body = JSON.stringify(r.value);
  const cut = body.length > MAX_RESULT_CHARS;
  if (cut) body = body.slice(0, MAX_RESULT_CHARS);
  const doc = {
    id: `${f.kind}:${f.rowId}`,
    title: docTitle(f.kind, f.rowId, r.value),
    text: body,
    url: originOf(c) + spec.page(f.rowId),
    metadata: { kind: f.kind, ...(cut ? { cutAtChars: MAX_RESULT_CHARS } : {}), ...(r.removed.length ? { credentialFieldsRemoved: r.removed } : {}) },
  };
  return { result: text(JSON.stringify(doc)), status: 200, note: "", target };
}


const FLOW_ENRICH_MAX = 15;
const FLOW_ENRICH_PARALLEL = 5;

async function documentFlowTool(c: Context<HonoEnv>, token: string, q: string, company: string | null): Promise<Outcome> {
  const target = `flow:${q}`.slice(0, 200);
  if (!q) return { result: text("Give a document number (e.g. HC-SO-013402) or an id from search.", true), status: 400, note: "", target };
  let anchor = flowAnchorFromId(q);
  if (!anchor) {
    const found = await readValue(c, token, "/api/search", { q }, company);
    if (!found.ok) return { result: text(found.message, true), status: found.status, note: found.note, target };
    anchor = flowAnchorFromSearch(found.value, q);
    if (!anchor) return { result: text(`No sales order, delivery order, invoice, purchase order, GRN or return matches "${q}".`, true), status: 404, note: "not found", target };
  }
  const r = await readValue(c, token, `/api/scm/document-flow/${anchor.type}/${encodeURIComponent(anchor.id)}`, undefined, company);
  if (!r.ok) return { result: text(r.message, true), status: r.status, note: r.note, target };

  const nodes = (Array.isArray((r.value as { nodes?: unknown }).nodes) ? (r.value as { nodes: Record<string, unknown>[] }).nodes : []).filter((n) => {
    const spec = flowSpec(String(n.type));
    return !!spec?.fetch && typeof n.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(n.id);
  });
  const extra = new Map<string, { date: string | null; amountRM: number | null }>();
  const todo = nodes.slice(0, FLOW_ENRICH_MAX);
  for (let i = 0; i < todo.length; i += FLOW_ENRICH_PARALLEL) {
    // eslint-disable-next-line no-await-in-loop -- bounded fan-out: 5 in-process reads at a time, at most 15 in all
    await Promise.all(
      todo.slice(i, i + FLOW_ENRICH_PARALLEL).map(async (n) => {
        const kind = fetchKind(String(flowSpec(String(n.type))?.fetch ?? ""));
        if (!kind) return;
        const d = await readValue(c, token, kind.api(String(n.id)), undefined, company);
        if (d.ok) extra.set(String(n.key ?? `${String(n.type)}:${String(n.id)}`), pickDateAmount(d.value));
      }),
    );
  }
  const shaped = shapeFlow(r.value, originOf(c), extra);
  const out: Record<string, unknown> = { anchor: `${flowSpec(anchor.type)?.word ?? anchor.type} ${anchor.id}`, links: shaped.links.map(({ nodeType: _t, id: _i, ...l }) => l), steps: shaped.steps };
  if (nodes.length > FLOW_ENRICH_MAX) out.note = `Dates and amounts filled for the first ${FLOW_ENRICH_MAX} of ${nodes.length} documents; open the others with fetch.`;
  if (shaped.incomplete.length) out.couldNotRead = shaped.incomplete;
  return { result: text(JSON.stringify(out).slice(0, MAX_RESULT_CHARS)), status: 200, note: "", target };
}


async function getPdfTool(c: Context<HonoEnv>, id: Identity, token: string, type: string, docId: string, company: string | null): Promise<Outcome> {
  const target = `pdf:${type}:${docId}`.slice(0, 200);
  const spec = pdfKind(type);
  const kind = fetchKind(type);
  if (!spec || !kind) return { result: text(`get_pdf does not know "${type}". Use a type from search, e.g. sales_order, delivery_order, sales_invoice, purchase_order, assr_case, project.`, true), status: 400, note: "", target };
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(docId)) return { result: text("Give the document id from search.", true), status: 400, note: "", target };
  const seen = await readValue(c, token, kind.api(docId), undefined, company);
  if (!seen.ok) return { result: text(seen.message, true), status: seen.status, note: seen.note, target };
  const page = originOf(c) + kind.page(docId);
  const browserOnly = (why: string) => ({
    result: text(JSON.stringify({ page, serverPdf: false, howTo: `${why} Open the page and press Print / PDF there.` })),
    status: 200,
    note: "",
    target,
  });
  if (!spec.print) return browserOnly("This document's PDF is made in the browser by the ERP page, not on the server.");
  if (spec.financeOnly && !isFinanceViewer(id.user)) return browserOnly("This printout carries cost and profit, which the AI connector shows only to finance.");
  const res = await innerGet(c, token, spec.print(docId), company);
  const ctype = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403) return { result: text("Not available to your role: you do not have permission for this in the ERP.", true), status: res.status, note: "no permission", target };
  if (!res.ok || !ctype.includes("text/html")) return browserOnly(`The printout could not be made here (HTTP ${res.status}).`);
  const key = randomToken(32);
  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS).toISOString();
  await c.env.POD_BUCKET.put(`${EXPORT_PREFIX}${key}.html`, await res.text(), {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { expiresAt, userId: String(id.user.id), doc: `${type}:${docId}` },
  });
  return {
    result: text(JSON.stringify({ download: `${originOf(c)}/api/mcp/export/${key}`, expiresAt, page, howTo: "The link opens the ERP's own printout and works for 15 minutes. Open it, then print or save as PDF." })),
    status: 200,
    note: "",
    target,
  };
}


async function proposeTool(c: Context<HonoEnv>, id: Identity, token: string, kind: ActionKind, args: Record<string, unknown>, company: string | null): Promise<Outcome> {
  let target = `propose ${kind}`;
  if (!(await actionsEnabled(c.env.DB))) return { result: text(ACTIONS_OFF, true), status: 403, note: "actions off", target };
  let p: Proposal;
  if (kind === "meeting") {
    const boot = await readValue(c, token, "/api/meetings/bootstrap", undefined, company);
    if (!boot.ok) return { result: text(boot.message, true), status: boot.status, note: boot.note, target };
    p = proposeMeeting(args, readBootstrap(boot.value), Date.now());
  } else {
    const res = await innerGet(c, token, "/api/mail-center/compose/senders", company);
    if (res.status === 401 || res.status === 403) return { result: text("Not available to your role: you may not send email from the Mail Center.", true), status: res.status, note: "no permission", target };
    const body = (await jsonOrNull(res, "senders")) as { senders?: unknown } | null;
    if (!res.ok || !body || !Array.isArray(body.senders)) return { result: text(`Your mailboxes could not be read (HTTP ${res.status}). Try again in a moment.`, true), status: 502, note: "senders unreadable", target };
    p = proposeEmail(args, body.senders.map(String));
  }
  if (!p.ok) return { result: text(p.error, true), status: 400, note: p.error.slice(0, 120), target };
  const confirmationId = await createPendingAction(c.env.DB, { tokenId: id.tokenId, userId: id.user.id, kind, payload: { company, body: p.payload }, summary: p.logLine, ttlMs: PENDING_TTL_MS });
  target = `propose ${p.logLine}`;
  return {
    result: text(JSON.stringify({ confirmationId, expiresInMinutes: PENDING_TTL_MS / 60_000, summary: p.summary, next: "Show this summary to the person and ask them to confirm. Only call confirm_action after they explicitly say yes." })),
    status: 200,
    note: "",
    target,
  };
}

async function jsonOrNull(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    console.warn(`[mcp] ${what}: HTTP ${res.status} reply is not JSON:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

const UNKNOWN_CONFIRMATION = "That confirmation is unknown, expired (10 minutes), already used, or belongs to another connection. Propose it again.";

async function confirmTool(c: Context<HonoEnv>, id: Identity, token: string, confirmationId: string): Promise<Outcome> {
  let target = "confirm";
  if (!confirmationId) return { result: text("Give the confirmationId from propose_meeting or propose_email.", true), status: 400, note: "", target };
  if (!(await actionsEnabled(c.env.DB))) return { result: text(ACTIONS_OFF, true), status: 403, note: "actions off", target };
  if ((await confirmedLastDay(c.env.DB, id.user.id)) >= MAX_CONFIRMED_PER_DAY) {
    return { result: text(`You have reached the limit of ${MAX_CONFIRMED_PER_DAY} AI actions in 24 hours. Do this one in the ERP.`, true), status: 429, note: "daily limit", target };
  }
  const row = await claimPendingAction(c.env.DB, confirmationId, id.tokenId, id.user.id, "confirmed");
  if (!row) return { result: text(UNKNOWN_CONFIRMATION, true), status: 404, note: "unknown or used", target };
  target = `confirm ${row.summary}`;
  const route = actionRoute(row.kind);
  const kind = row.kind === "meeting" || row.kind === "email" ? row.kind : null;
  if (!route || !kind) {
    await finishPendingAction(c.env.DB, row.id, "failed", "unknown kind");
    return { result: text("That action cannot be done.", true), status: 400, note: "unknown kind", target };
  }
  const company = typeof row.payload.company === "string" ? row.payload.company : null;
  armAction(row.id, kind, id.tokenId, Date.now());
  let res: Response;
  try {
    res = await innerCall(c, token, route.path, company, { actionId: row.id, method: route.method, body: row.payload.body });
  } finally {
    disarmAction(row.id);
  }
  const body: unknown = await jsonOrNull(res, `confirm ${kind}`);
  const out = actionOutcome(kind, res.status, body);
  await finishPendingAction(c.env.DB, row.id, out.ok ? "done" : "failed", out.ok ? `HTTP ${res.status}` : out.text);
  return { result: text(out.text, !out.ok), status: res.status, note: out.ok ? "" : out.text.slice(0, 120), target };
}

async function cancelTool(c: Context<HonoEnv>, id: Identity, confirmationId: string): Promise<Outcome> {
  const row = confirmationId ? await claimPendingAction(c.env.DB, confirmationId, id.tokenId, id.user.id, "cancelled") : null;
  if (!row) return { result: text(UNKNOWN_CONFIRMATION, true), status: 404, note: "unknown or used", target: "cancel" };
  return { result: text("Cancelled. Nothing was booked or sent."), status: 200, note: "", target: `cancel ${row.summary}` };
}

async function callTool(c: Context<HonoEnv>, id: Identity, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const t0 = Date.now();
  let status = 200;
  let note = "";
  let target = "";
  let result: ToolResult;
  const company = companyArg(args);
  const tag = company ? `[${company}] ` : "";
  try {
    if (name === "sales_summary" || name === "delivery_summary") {
      const w = resolveWindow(args, myToday());
      if (!w) {
        result = text(BAD_WINDOW, true);
        status = 400;
      } else {
        const o = name === "sales_summary" ? await salesSummary(c, token, w, company) : await deliverySummary(c, token, w, company);
        ({ result, status, note } = o);
        target = tag + o.target;
      }
    } else if (name === "search" || name === "fetch") {
      const o = name === "search" ? await searchTool(c, token, String(args.query ?? args.q ?? "").trim(), company) : await fetchTool(c, token, args.id, company);
      ({ result, status, note } = o);
      target = tag + o.target;
    } else if (name === "document_flow" || name === "get_pdf") {
      const o = name === "document_flow" ? await documentFlowTool(c, token, String(args.number_or_id ?? "").trim(), company) : await getPdfTool(c, id, token, String(args.type ?? ""), String(args.id ?? "").trim(), company);
      ({ result, status, note } = o);
      target = tag + o.target;
    } else if (name === "propose_meeting" || name === "propose_email") {
      const o = await proposeTool(c, id, token, name === "propose_meeting" ? "meeting" : "email", args, company);
      ({ result, status, note } = o);
      target = tag + o.target;
    } else if (name === "confirm_action" || name === "cancel_action") {
      const o = name === "confirm_action" ? await confirmTool(c, id, token, String(args.confirmationId ?? "").trim()) : await cancelTool(c, id, String(args.confirmationId ?? "").trim());
      ({ result, status, note } = o);
      target = o.target;
    } else if (name === "whoami") {
      result = text(JSON.stringify({ name: id.user.name, email: id.user.email, position: id.user.position_name, department: id.user.department_name, actionsAllowed: await actionsEnabled(c.env.DB) }));
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
      const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).map(String).filter(Boolean).slice(0, 40) : [];
      const r = await readEndpoint(c, token, String(args.path ?? ""), (args.query as Record<string, unknown> | undefined) ?? undefined, company, fields);
      result = r.result;
      status = r.status;
      note = r.note;
      target = tag + r.target;
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
      return reply({ protocolVersion, capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: MCP_INSTRUCTIONS });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call":
      return reply(await callTool(c, id, token, String(m.params?.name ?? ""), (m.params?.arguments as Record<string, unknown> | undefined) ?? {}));
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: PROMPTS });
    case "prompts/get": {
      const pname = String(m.params?.name ?? "");
      const ptext = promptText(pname, (m.params?.arguments as Record<string, unknown> | undefined) ?? {});
      if (ptext === null) return { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32602, message: `Unknown prompt: ${pname}` } };
      return reply({ description: PROMPTS.find((x) => x.name === pname)?.description ?? "", messages: [{ role: "user", content: { type: "text", text: ptext } }] });
    }
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
  rememberVerified(token, id, Date.now());
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

app.get("/export/:key", async (c) => {
  const key = c.req.param("key");
  const gone = (status: 404 | 410) =>
    new Response("This printout link has expired or does not exist. Ask the AI for the PDF again.\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (!EXPORT_KEY_RE.test(key)) return gone(404);
  const objKey = `${EXPORT_PREFIX}${key}.html`;
  const obj = await c.env.POD_BUCKET.get(objKey);
  if (!obj) return gone(404);
  if (!exportAlive(obj.customMetadata?.expiresAt, Date.now())) {
    await c.env.POD_BUCKET.delete(objKey);
    return gone(410);
  }
  return new Response(obj.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-modals allow-popups",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
});

app.get("/", (c) => c.json({ error: "Use POST (MCP Streamable HTTP)." }, 405, { Allow: "POST" }));
app.delete("/", (c) => c.body(null, 405, { Allow: "POST" }));

export default app;

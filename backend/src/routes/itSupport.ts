// /api/it-support — report a problem to IT, follow it, reply, confirm the fix.
//
// The requests do not live in this database. They live in the Houzs IT Hub
// (support.houzscentury.com), the one inbox the developers work for every
// system, and this router is the only thing that talks to it, server to server:
//
//   browser --session--> /api/it-support/* --Bearer key + X-Reporter-Id--> hub
//
// Access: ANY authenticated user, no matrix permission — the same widening as
// /api/push and /api/notifications, for the same reason: every row is the
// caller's own. WHO is asking is `c.get("user").id`, never a value from the
// request; the hub returns a reporter only their own requests, keyed on that
// id, so an id read from a query string would be everyone's requests one edit
// away. The service-tier caller (id 0) is refused: it is nobody's inbox.
//
// WHICH INBOX follows the active company, like every other document here. The
// hub keeps one system per company, each with its own key, and the key is DATA:
// the secret named IT_HUB_API_KEY_<company code> (IT_HUB_API_KEY_HOUZS,
// IT_HUB_API_KEY_2990). No company is named in this file, so adding a company
// is adding a secret. A request raised while working in a company lands in that
// company's inbox and the list shows that company's requests. A company with
// no key is "not connected" — it never borrows another company's key, which
// would file its requests in the wrong inbox without anyone noticing.
//
// The hub keys never leave the Worker.
//
// "Could not ask the hub" is answered as that — 501 when this environment is
// not connected, 502 when the hub is down or refuses our key — never as an
// empty list. A hub 401 means OUR key is wrong; passing it through would read
// to the client as the user's own session having expired and sign them out.

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";

const app = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

const HUB_TIMEOUT_MS = 20_000;
const REQUEST_CODE = /^[A-Z0-9]{2,6}-\d{1,8}$/;
// A company code becomes part of a secret's NAME, so only a plain code may.
const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;
const TYPES = new Set(["bug", "development"]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
// What the browser may set on a new request. Every reporter_* field and
// user_agent are filled in here from the session and the request.
const REQUEST_FIELDS = ["title", "description", "type", "priority", "page_url", "occurred_at"] as const;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_KINDS = /^(image\/|video\/mp4$|video\/quicktime$|application\/pdf$)/;
// A .zip goes by its name: browsers label it application/zip, application/x-zip-compressed or nothing.
const isZip = (f: File) => f.name.toLowerCase().endsWith(".zip");

const NOT_CONNECTED = "IT Support is not connected on this system yet. Please tell IT directly for now.";
const UNREACHABLE = "IT Support could not be reached. Please try again in a moment.";
const NOT_FOUND = "That IT request could not be found.";

type Hub = { base: string; key: string; reporterId: string };

/** The hub settings for the signed-in caller, or the response to send instead. */
function hubFor(c: Ctx): Hub | Response {
  // Typed as possibly absent on purpose: this check is all that stands between
  // a mount mistake that skips auth and the hub being asked as "undefined".
  const user = c.get("user") as AuthUser | undefined;
  if (!user || !Number.isInteger(user.id) || user.id <= 0) {
    return c.json({ error: "IT Support is for signed-in staff accounts." }, 403);
  }
  // companyContext leaves the code unset only when the companies master could
  // not be read (a cold isolate's first read failing). Guessing a company then
  // would file one company's request under another, so the caller retries.
  const company = c.get("companyCode");
  if (!company) return c.json({ error: UNREACHABLE }, 503);
  const base = (c.env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  const secret = COMPANY_CODE.test(company) ? (c.env as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  const key = typeof secret === "string" ? secret.trim() : "";
  if (!base || !key) return c.json({ error: NOT_CONNECTED }, 501);
  return { base, key, reporterId: String(user.id) };
}

function hubFetch(hub: Hub, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${hub.key}`);
  headers.set("X-Reporter-Id", hub.reporterId);
  return fetch(`${hub.base}/api/v1/sys${path}`, { ...init, headers, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
}

/**
 * One hub call, answered to the browser. `conflict` is our sentence for the
 * hub's 409 (it refuses an action the request's state does not allow).
 */
async function relay(c: Ctx, call: Promise<Response>, conflict: string | null): Promise<Response> {
  let res: Response;
  try {
    res = await call;
  } catch (err) {
    console.warn("[it-support] hub unreachable:", err instanceof Error ? err.message : String(err));
    return c.json({ error: UNREACHABLE }, 502);
  }
  // A body that is not JSON (a gateway's HTML page) is not an answer: it stays
  // null and falls through to the 502 below, with the status logged.
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[it-support] hub sent a ${res.status} that is not JSON:`, err instanceof Error ? err.message : String(err));
  }
  if (res.ok && body) return c.json(body, res.status === 201 ? 201 : 200);
  if (res.status === 404) return c.json({ error: NOT_FOUND }, 404);
  if (res.status === 409) {
    return c.json({ error: conflict ?? "That cannot be done on this IT request as it stands. Please refresh." }, 409);
  }
  if (res.status === 400) {
    return c.json({ error: typeof body?.error === "string" ? body.error : "Some details are missing or not valid." }, 400);
  }
  console.warn(`[it-support] hub answered ${res.status}: ${typeof body?.error === "string" ? body.error : ""}`);
  return c.json({ error: UNREACHABLE }, 502);
}

/** Text fields and files off the browser's form; null when it cannot be read. */
async function readForm(c: Ctx): Promise<{ fields: Record<string, string | undefined>; files: File[] } | null> {
  const fields: Record<string, string | undefined> = {};
  const files: File[] = [];
  try {
    if ((c.req.header("Content-Type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[k] = v;
        else if (k === "files" && (v as File).size > 0) files.push(v as File);
      }
    } else {
      const body = (await c.req.json()) as Record<string, unknown> | null;
      for (const [k, v] of Object.entries(body ?? {})) if (v != null) fields[k] = String(v);
    }
  } catch {
    return null;
  }
  return { fields, files };
}

/** What is wrong with the attached files, as a sentence, or null. */
function filesRefusal(files: File[]): string | null {
  if (files.length > MAX_FILES) return `Attach at most ${MAX_FILES} files.`;
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) return `${big.name} is larger than 10 MB.`;
  const odd = files.find((f) => !isZip(f) && !FILE_KINDS.test(f.type));
  return odd ? `${odd.name} is not a picture, an MP4 or MOV video, a PDF or a ZIP.` : null;
}

// ---- Is IT Support connected in this environment? --------------------------
// The menu row is listed only where this answers true (Sidebar.tsx), so an
// environment without the hub's settings shows no row leading to a page that
// could only say "not connected". Not connected is an answer here, not an error.
app.get("/status", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub.status === 501 ? c.json({ connected: false }) : hub;
  return c.json({ connected: true });
});

// ---- My requests ----------------------------------------------------------
app.get("/tickets", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/tickets"), null);
});

// ---- How many of my requests IT answered since I last opened them ----------
// For the red count on the menu row. Answered as `{ count }`, the shape every
// other sidebar count reads (hooks/useAmendmentApprovals.ts).
app.get("/unread-count", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const res = await relay(c, hubFetch(hub, "/tickets/unread-count"), null);
  if (!res.ok) return res;
  const body = (await res.json()) as { unread?: unknown };
  const n = Number(body.unread);
  return c.json({ count: Number.isFinite(n) && n > 0 ? n : 0 });
});

// ---- One request and what IT said on it (the hub marks it seen) ------------
app.get("/tickets/:code", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const code = c.req.param("code");
  if (!REQUEST_CODE.test(code)) return c.json({ error: NOT_FOUND }, 404);
  return relay(c, hubFetch(hub, `/tickets/${code}`), null);
});

// ---- Report a problem -------------------------------------------------------
app.post("/tickets", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const input = await readForm(c);
  if (!input) return c.json({ error: "That could not be read. Please fill in the form and send it again." }, 400);
  if (!input.fields.title?.trim()) return c.json({ error: "Say in a few words what the problem is." }, 400);
  if (input.fields.type && !TYPES.has(input.fields.type)) return c.json({ error: "Choose what kind of request this is." }, 400);
  if (input.fields.priority && !PRIORITIES.has(input.fields.priority)) return c.json({ error: "Choose how urgent this is." }, 400);
  const badFiles = filesRefusal(input.files);
  if (badFiles) return c.json({ error: badFiles }, 400);

  const user = c.get("user");
  const out = new FormData();
  for (const k of REQUEST_FIELDS) {
    const v = input.fields[k]?.trim();
    if (v) out.set(k, v);
  }
  out.set("reporter_name", user.name?.trim() || user.email);
  out.set("reporter_email", user.email);
  if (user.department_name) out.set("reporter_department", user.department_name);
  const agent = c.req.header("User-Agent");
  if (agent) out.set("user_agent", agent.slice(0, 500));
  for (const f of input.files) out.append("files", f, f.name);

  return relay(c, hubFetch(hub, "/tickets", { method: "POST", body: out }), null);
});

// ---- Reply on my request ----------------------------------------------------
app.post("/tickets/:code/replies", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const code = c.req.param("code");
  if (!REQUEST_CODE.test(code)) return c.json({ error: NOT_FOUND }, 404);
  const input = await readForm(c);
  if (!input) return c.json({ error: "That could not be read. Please write your reply and send it again." }, 400);
  const body = (input.fields.body ?? "").trim();
  if (!body && input.files.length === 0) return c.json({ error: "Write a reply or attach a file." }, 400);
  const badFiles = filesRefusal(input.files);
  if (badFiles) return c.json({ error: badFiles }, 400);

  const out = new FormData();
  if (body) out.set("body", body);
  for (const f of input.files) out.append("files", f, f.name);
  return relay(
    c,
    hubFetch(hub, `/tickets/${code}/replies`, { method: "POST", body: out }),
    "This IT request is closed. Please report the problem again if it is back.",
  );
});

// ---- "Yes, it is fixed": Done -> Closed ------------------------------------
app.post("/tickets/:code/confirm", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const code = c.req.param("code");
  if (!REQUEST_CODE.test(code)) return c.json({ error: NOT_FOUND }, 404);
  return relay(
    c,
    hubFetch(hub, `/tickets/${code}/confirm`, { method: "POST" }),
    "IT has not marked this request as done yet, so there is nothing to confirm.",
  );
});

// ---- A file on my request, streamed through so the key stays here ----------
app.get("/attachments/:id", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!/^\d{1,12}$/.test(id)) return c.json({ error: "That file could not be found." }, 404);
  let res: Response;
  try {
    res = await hubFetch(hub, `/attachments/${id}`);
  } catch {
    return c.json({ error: UNREACHABLE }, 502);
  }
  if (res.status === 404) return c.json({ error: "That file could not be found." }, 404);
  if (!res.ok || !res.body) return c.json({ error: UNREACHABLE }, 502);
  const headers = new Headers();
  headers.set("Content-Type", res.headers.get("Content-Type") ?? "application/octet-stream");
  const disposition = res.headers.get("Content-Disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  return new Response(res.body, { status: 200, headers });
});

export default app;

// /api/meetings — meeting rooms shared by every company and every ERP.
//
// Rooms, meetings, guest links and the cross-ERP staff directory live in the Houzs IT
// Hub (houzs-hub routes/sysMeetings.ts), so a Hookka colleague booked from here sees it
// in Hookka ERP. This router is the only thing that talks to it, server to server, the
// same way routes/itSupport.ts does:
//
//   browser --session--> /api/meetings/* --Bearer key + X-Reporter-Id + X-Person-*--> hub
//
// Access: every signed-in staff user (the calendar is for everyone). WHO is asking is the
// session's user, never a value from the request; the hub also takes their name, email,
// company and Org Chart department from here. Adding and changing rooms needs
// "meetings.manage_rooms", decided HERE and passed as X-Can-Manage-Rooms; the hub trusts it
// because only this Worker holds the key.
//
// The hub's 409 is a booking conflict ("Adrian is busy 2-3pm; everyone is free at 3pm")
// and is relayed with its body unchanged, because the page builds the conflict dialog
// from it. Not connected is 501, hub down is 502, as in IT Support.
//
// The guest side (publicMeetings, mounted before auth at /api/public/meetings) lets a
// person with a booking link see free times and book. It is proxied as X-Reporter-Id:
// guest, which the hub only lets reach its /public routes, and is rate-limited per IP.

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";
import { hasPermission } from "../services/permissions";
import { checkRateLimit, clientIp } from "../middleware/rateLimit";
import { defaultCompanyCodeForHost } from "../middleware/companyContext";
import { sendMeetingMail } from "../services/meetingMail";

const app = new Hono<{ Bindings: Env }>();
export const publicMeetings = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

const HUB_TIMEOUT_MS = 20_000;
const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;
const ID = /^\d{1,12}$/;
const LINK_CODE = /^[a-z0-9]{1,8}-[a-f0-9]{6,32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const NOT_CONNECTED = "Meetings is not connected on this system yet. Please tell IT.";
const UNREACHABLE = "Meetings could not be reached. Please try again in a moment.";

type Hub = { base: string; key: string; headers: Record<string, string> };

/** The hub key for a company code, or "" when this environment has none. */
function keyFor(env: Env, company: string): string {
  const secret = COMPANY_CODE.test(company) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${company}`] : undefined;
  return typeof secret === "string" ? secret.trim() : "";
}
const hubBase = (env: Env) => (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");

/** Header values must be plain text: no line breaks, at most 200 characters. */
const clean = (v: string | null | undefined) => (v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);

function hubFor(c: Ctx): Hub | Response {
  const user = c.get("user") as AuthUser | undefined;
  if (!user || !Number.isInteger(user.id) || user.id <= 0) return c.json({ error: "Meetings is for signed-in staff accounts." }, 403);
  const company = c.get("companyCode");
  if (!company) return c.json({ error: UNREACHABLE }, 503);
  const base = hubBase(c.env);
  const key = keyFor(c.env, company);
  if (!base || !key) return c.json({ error: NOT_CONNECTED }, 501);
  const companyName = c.get("companies")?.find((x) => x.code === company)?.name ?? company;
  return {
    base,
    key,
    headers: {
      "X-Reporter-Id": String(user.id),
      "X-Person-Name": clean(user.name) || clean(user.email),
      "X-Person-Email": clean(user.email),
      "X-Person-Company": clean(companyName),
      "X-Person-Department": clean(user.department_name),
      "X-Can-Manage-Rooms": hasPermission(user.permissions_set, "meetings.manage_rooms") ? "1" : "0",
    },
  };
}

function hubFetch(hub: Hub, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${hub.key}`);
  for (const [k, v] of Object.entries(hub.headers)) headers.set(k, v);
  return fetch(`${hub.base}/api/v1/sys/meetings${path}`, { ...init, headers, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
}

/** One hub call answered to the browser. 400/403/404/409/413/429 carry the hub's own sentence. */
async function relay(c: Ctx, call: Promise<Response>): Promise<Response> {
  let res: Response;
  try {
    res = await call;
  } catch (err) {
    console.warn("[meetings] hub unreachable:", err instanceof Error ? err.message : String(err));
    return c.json({ error: UNREACHABLE }, 502);
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    console.warn(`[meetings] hub sent a ${res.status} that is not JSON`);
  }
  if (res.ok && body) return c.json(body, res.status === 201 ? 201 : 200);
  if (body && [400, 403, 404, 409, 413, 429].includes(res.status)) {
    // 409 is a booking conflict: the whole body goes back, the page draws the dialog from it.
    return c.json(body, res.status as 400 | 403 | 404 | 409 | 413 | 429);
  }
  // 401 means OUR key is wrong; passing it on would sign the user out.
  console.warn(`[meetings] hub answered ${res.status}: ${typeof body?.error === "string" ? body.error : ""}`);
  return c.json({ error: UNREACHABLE }, 502);
}

/** The browser's JSON body, or null when it is not JSON (the route answers 400). */
async function json(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** After a booking, change or cancellation, send the emails it made through this ERP's Mail Center
 *  (services/meetingMail.ts), once the answer has gone. The 5-minute cron sends anything left. */
async function thenMail(c: Ctx, company: string, res: Promise<Response>): Promise<Response> {
  const out = await res;
  if (out.ok) {
    const run = sendMeetingMail(c.env, company).catch((e) => console.warn("[meetings] mail:", e instanceof Error ? e.message : String(e)));
    try {
      c.executionCtx.waitUntil(run);
    } catch {
      // No execution context (tests): the run above carries on by itself.
    }
  }
  return out;
}

// ---- Connected? (the menu row is listed only where this is true) -----------
app.get("/status", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub.status === 501 ? c.json({ connected: false }) : hub;
  return c.json({ connected: true });
});

app.get("/bootstrap", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/bootstrap"));
});

app.get("/calendar", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return c.json({ error: "from and to are required" }, 400);
  return relay(c, hubFetch(hub, `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`));
});

app.get("/mine", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/mine"));
});

// For the red count on the menu row, in the { count } shape every sidebar count reads.
app.get("/unread-count", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const res = await relay(c, hubFetch(hub, "/unread"));
  if (!res.ok) return res;
  const n = Number(((await res.json()) as { unread?: unknown }).unread);
  return c.json({ count: Number.isFinite(n) && n > 0 ? n : 0 });
});

app.post("/notifications/read", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/notifications/read", { method: "POST" }));
});

// A new Google Meet link for the booking window (the hub creates it).
app.post("/meet-link", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/meet-link", { method: "POST" }));
});

app.get("/meetings/:id", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "That meeting is not there any more." }, 404);
  return relay(c, hubFetch(hub, `/meetings/${id}`));
});

app.post("/meetings", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const body = await json(c);
  if (!body) return c.json({ error: "That could not be read. Please try again." }, 400);
  return thenMail(c, c.get("companyCode") ?? "", relay(c, hubFetch(hub, "/meetings", jsonInit("POST", body))));
});

app.patch("/meetings/:id", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "That meeting is not there any more." }, 404);
  const body = await json(c);
  if (!body) return c.json({ error: "That could not be read. Please try again." }, 400);
  return thenMail(c, c.get("companyCode") ?? "", relay(c, hubFetch(hub, `/meetings/${id}`, jsonInit("PATCH", body))));
});

app.post("/meetings/:id/:act{cancel|start|end}", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "That meeting is not there any more." }, 404);
  const body = (await json(c)) ?? {};
  return thenMail(c, c.get("companyCode") ?? "", relay(c, hubFetch(hub, `/meetings/${id}/${c.req.param("act")}`, jsonInit("POST", body))));
});

app.post("/meetings/:id/files", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "That meeting is not there any more." }, 404);
  let files: File[] = [];
  try {
    const form = await c.req.formData();
    files = form.getAll("files").filter((f): f is File => typeof f !== "string" && (f as File).size > 0);
  } catch {
    return c.json({ error: "Those files could not be read. Please attach them again." }, 400);
  }
  if (!files.length) return c.json({ error: "Attach at least one file." }, 400);
  if (files.length > MAX_FILES) return c.json({ error: `Attach at most ${MAX_FILES} files at a time.` }, 400);
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) return c.json({ error: `${big.name} is larger than 25 MB.` }, 413);
  const out = new FormData();
  for (const f of files) out.append("files", f, f.name);
  return relay(c, hubFetch(hub, `/meetings/${id}/files`, { method: "POST", body: out }));
});

app.get("/meetings/:id/files/:fid", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  const fid = c.req.param("fid");
  if (!ID.test(id) || !ID.test(fid)) return c.json({ error: "That file could not be found." }, 404);
  let res: Response;
  try {
    res = await hubFetch(hub, `/meetings/${id}/files/${fid}`);
  } catch {
    return c.json({ error: UNREACHABLE }, 502);
  }
  if (res.status === 404) return c.json({ error: "That file could not be found." }, 404);
  if (!res.ok || !res.body) return c.json({ error: UNREACHABLE }, 502);
  const headers = new Headers({ "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
  const disposition = res.headers.get("Content-Disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  return new Response(res.body, { status: 200, headers });
});

app.post("/rooms", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  if (hub.headers["X-Can-Manage-Rooms"] !== "1") return c.json({ error: "You need Manage meeting rooms to add a room." }, 403);
  const body = await json(c);
  if (!body) return c.json({ error: "That could not be read. Please try again." }, 400);
  return relay(c, hubFetch(hub, "/rooms", jsonInit("POST", body)));
});

app.patch("/rooms/:id", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  if (hub.headers["X-Can-Manage-Rooms"] !== "1") return c.json({ error: "You need Manage meeting rooms to change a room." }, 403);
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "Room not found" }, 404);
  const body = await json(c);
  if (!body) return c.json({ error: "That could not be read. Please try again." }, 400);
  return relay(c, hubFetch(hub, `/rooms/${id}`, jsonInit("PATCH", body)));
});

app.get("/log", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  if (hub.headers["X-Can-Manage-Rooms"] !== "1") return c.json({ error: "You need Manage meeting rooms to see the change log." }, 403);
  return relay(c, hubFetch(hub, "/log"));
});

app.get("/links", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/links"));
});

app.post("/links", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const body = await json(c);
  if (!body) return c.json({ error: "That could not be read. Please try again." }, 400);
  return relay(c, hubFetch(hub, "/links", jsonInit("POST", body)));
});

app.patch("/links/:id", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const id = c.req.param("id");
  if (!ID.test(id)) return c.json({ error: "Link not found" }, 404);
  const body = await json(c);
  return relay(c, hubFetch(hub, `/links/${id}`, jsonInit("PATCH", body ?? {})));
});

// ---- Guests (no login) ------------------------------------------------------

/** Guests come in on this ERP's address; that address picks the company key. */
const guestCompany = (c: Ctx) => defaultCompanyCodeForHost(c.req.header("Host") ?? new URL(c.req.url).host);
function guestHub(c: Ctx): Hub | Response {
  const base = hubBase(c.env);
  const key = keyFor(c.env, guestCompany(c));
  if (!base || !key) return c.json({ error: "Booking is not available right now." }, 501);
  return { base, key, headers: { "X-Reporter-Id": "guest" } };
}

async function guestLimit(c: Ctx, bucket: string, max: number): Promise<Response | null> {
  return checkRateLimit(c, `meetings-${bucket}`, clientIp(c), max, 900);
}

publicMeetings.get("/links/:code", async (c) => {
  const code = c.req.param("code");
  if (!LINK_CODE.test(code)) return c.json({ error: "This booking link is not active." }, 404);
  const limited = await guestLimit(c, "read", 300);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, `/public/links/${code}`));
});

publicMeetings.get("/links/:code/slots", async (c) => {
  const code = c.req.param("code");
  const day = c.req.query("day") ?? "";
  if (!LINK_CODE.test(code)) return c.json({ error: "This booking link is not active." }, 404);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "Pick a day." }, 400);
  const limited = await guestLimit(c, "read", 300);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, `/public/links/${code}/slots?day=${day}`));
});

// One day of a link: each room's taken times (no titles, no people), for the guest to pick a room and time.
publicMeetings.get("/links/:code/day", async (c) => {
  const code = c.req.param("code");
  const day = c.req.query("day") ?? "";
  if (!LINK_CODE.test(code)) return c.json({ error: "This booking link is not active." }, 404);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "Pick a day." }, 400);
  const limited = await guestLimit(c, "read", 300);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, `/public/links/${code}/day?day=${day}`));
});

publicMeetings.post("/links/:code/book", async (c) => {
  const code = c.req.param("code");
  if (!LINK_CODE.test(code)) return c.json({ error: "This booking link is not active." }, 404);
  const limited = await guestLimit(c, "book", 10);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  const b = await json(c);
  if (!b) return c.json({ error: "That could not be read. Please try again." }, 400);
  // Only these fields reach the hub. roomId / end / title / people / department: the guest picks the room and time.
  const body = { start: b.start, end: b.end, roomId: b.roomId, name: b.name, phone: b.phone, email: b.email, company: b.company, department: b.department, title: b.title, people: b.people };
  return thenMail(c, guestCompany(c), relay(c, hubFetch(hub, `/public/links/${code}/book`, jsonInit("POST", body))));
});

publicMeetings.get("/bookings/:token", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ error: "Booking not found" }, 404);
  const limited = await guestLimit(c, "read", 300);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, `/public/bookings/${token}`));
});

publicMeetings.post("/bookings/:token/cancel", async (c) => {
  const token = c.req.param("token");
  if (!TOKEN.test(token)) return c.json({ error: "Booking not found" }, 404);
  const limited = await guestLimit(c, "book", 10);
  if (limited) return limited;
  const hub = guestHub(c);
  if (hub instanceof Response) return hub;
  return thenMail(c, guestCompany(c), relay(c, hubFetch(hub, `/public/bookings/${token}/cancel`, { method: "POST" })));
});

export default app;

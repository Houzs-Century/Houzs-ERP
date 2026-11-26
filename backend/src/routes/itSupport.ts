
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import type { AuthUser } from "../services/auth";

const app = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

const HUB_TIMEOUT_MS = 20_000;
const REQUEST_CODE = /^[A-Z0-9]{2,6}-\d{1,8}$/;
const COMPANY_CODE = /^[A-Z0-9]{2,12}$/;
const TYPES = new Set(["bug", "development"]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const REQUEST_FIELDS = ["title", "description", "type", "priority", "page_url", "module", "occurred_at"] as const;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_KINDS = /^(image\/|video\/mp4$|video\/quicktime$|application\/pdf$)/;
const isZip = (f: File) => f.name.toLowerCase().endsWith(".zip");

const NOT_CONNECTED = "IT Support is not connected on this system yet. Please tell IT directly for now.";
const UNREACHABLE = "IT Support could not be reached. Please try again in a moment.";
const NOT_FOUND = "That IT request could not be found.";

type Hub = { base: string; key: string; reporterId: string };

function hubFor(c: Ctx): Hub | Response {
  const user = c.get("user") as AuthUser | undefined;
  if (!user || !Number.isInteger(user.id) || user.id <= 0) {
    return c.json({ error: "IT Support is for signed-in staff accounts." }, 403);
  }
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

async function relay(c: Ctx, call: Promise<Response>, conflict: string | null): Promise<Response> {
  let res: Response;
  try {
    res = await call;
  } catch (err) {
    console.warn("[it-support] hub unreachable:", err instanceof Error ? err.message : String(err));
    return c.json({ error: UNREACHABLE }, 502);
  }
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

function filesRefusal(files: File[]): string | null {
  if (files.length > MAX_FILES) return `Attach at most ${MAX_FILES} files.`;
  const big = files.find((f) => f.size > MAX_FILE_BYTES);
  if (big) return `${big.name} is larger than 10 MB.`;
  const odd = files.find((f) => !isZip(f) && !FILE_KINDS.test(f.type));
  return odd ? `${odd.name} is not a picture, an MP4 or MOV video, a PDF or a ZIP.` : null;
}

app.get("/status", (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub.status === 501 ? c.json({ connected: false }) : hub;
  return c.json({ connected: true });
});

app.get("/tickets", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  return relay(c, hubFetch(hub, "/tickets"), null);
});

app.get("/unread-count", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const res = await relay(c, hubFetch(hub, "/tickets/unread-count"), null);
  if (!res.ok) return res;
  const body = (await res.json()) as { unread?: unknown };
  const n = Number(body.unread);
  return c.json({ count: Number.isFinite(n) && n > 0 ? n : 0 });
});

app.get("/tickets/:code", async (c) => {
  const hub = hubFor(c);
  if (hub instanceof Response) return hub;
  const code = c.req.param("code");
  if (!REQUEST_CODE.test(code)) return c.json({ error: NOT_FOUND }, 404);
  return relay(c, hubFetch(hub, `/tickets/${code}`), null);
});

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

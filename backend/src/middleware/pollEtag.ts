import type { MiddlewareHandler } from "hono";

export const POLLED_LIST_PATHS = [
  "/api/projects/:id/activity",
  "/api/announcements/banner",
  "/api/it-support/tickets",
  "/api/it-support/tickets/:code",
  "/api/scm/trips",
  "/api/scm/trips/active/locations",
  "/api/scm/trips/:id/locations/latest",
  "/api/scm/lorries/positions/latest",
  "/api/scm/lorries/km-cost",
  "/api/scm/delivery-planning/changes",
  "/api/scm/delivery-jobs/progress",
  "/api/scm/delivery-jobs/stop-photos",
  "/api/scm/delivery-jobs/:sourceType/:sourceId/:leg",
  "/api/scm/delivery-planning/do/:doRef/pod",
  "/api/scm/accounting/todo",
  "/api/branding",
] as const;

export const POLL_CACHE_CONTROL = "private, no-cache";
export const POLL_VARY = ["Authorization", "X-Company-Id"] as const;

const SESSION_PASS_HEADER = "X-Session-Pass";

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function pollEtagFor(body: ArrayBuffer, identity: string): Promise<string> {
  const prefix = new TextEncoder().encode(`${identity}\n`);
  const joined = new Uint8Array(prefix.byteLength + body.byteLength);
  joined.set(prefix, 0);
  joined.set(new Uint8Array(body), prefix.byteLength);
  return `"${hex(await crypto.subtle.digest("SHA-1", joined))}"`;
}

export function ifNoneMatchHits(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const want = strip(tag);
  return header.split(",").some((t) => strip(t) === want);
}

function appendVary(headers: Headers): void {
  const have = (headers.get("Vary") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const lower = new Set(have.map((v) => v.toLowerCase()));
  for (const v of POLL_VARY) if (!lower.has(v.toLowerCase())) have.push(v);
  headers.set("Vary", have.join(", "));
}

export const pollEtag: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method !== "GET") return;
  const res = c.res;
  if (res.status !== 200) return;
  if (!(res.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json")) return;
  if (res.headers.has("ETag") || res.headers.has("Cache-Control")) return;

  const headers = new Headers(res.headers);
  if (headers.has(SESSION_PASS_HEADER)) {
    headers.set("Cache-Control", "no-store");
    c.res = undefined;
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    return;
  }

  const body = await res.arrayBuffer();
  const user = c.get("user") as { id?: unknown } | undefined;
  const identity = `${String(user?.id ?? "")}|${String(c.get("companyId") ?? "")}|${c.req.header("X-Company-Id") ?? ""}`;
  const tag = await pollEtagFor(body, identity);
  headers.set("ETag", tag);
  headers.set("Cache-Control", POLL_CACHE_CONTROL);
  appendVary(headers);

  c.res = undefined;
  if (ifNoneMatchHits(c.req.header("If-None-Match"), tag)) {
    for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) headers.delete(h);
    c.res = new Response(null, { status: 304, headers });
    return;
  }
  c.res = new Response(body, { status: 200, statusText: res.statusText, headers });
};

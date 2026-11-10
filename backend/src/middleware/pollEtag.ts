import type { MiddlewareHandler } from "hono";

/* The GET lists the frontend re-asks for on a timer. Each entry is a Hono path
   pattern mounted with `app.use` in index.ts, BEFORE the routers that serve it,
   so the middleware wraps the handler. Who polls what, and how often:
     projects/:id/activity       ProjectChat 3s, MobileProjectChat 30s
     announcements/banner        mobile popup 30s, bell + banner 180s
     it-support/tickets(/:code)  ItSupport desktop + mobile, 30s / 60s
     scm/trips*                  dispatch map, 15s (DISPATCH_POLL_MS)
     scm/lorries/*               60s / 5 min
     scm/delivery-planning/changes, scm/delivery-jobs/progress   30s
     scm/delivery-jobs/stop-photos, scm/delivery-jobs/:type/:id/:leg,
     scm/delivery-planning/do/:ref/pod   crew stop screen open, 15s
     scm/accounting/todo         finance to-do, 60s */
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
] as const;

/* `private` keeps every shared cache (Cloudflare's edge included) from storing
   it; `no-cache` lets the browser keep a copy but makes it ask on every poll,
   so a change still shows on the very next one. */
export const POLL_CACHE_CONTROL = "private, no-cache";
/* The answer depends on who asks and for which company, so a cache must not
   serve one's copy for the other without asking. Vary alone is NOT the
   boundary: Chromium keeps one entry per URL and, after a company switch, still
   sends the other company's tag (observed 2026-11-09). The identity inside the
   tag below is what turns that into a full 200. */
export const POLL_VARY = ["Authorization", "X-Company-Id"] as const;

const SESSION_PASS_HEADER = "X-Session-Pass";

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* The tag covers the body AND the identity that produced it, so a tag offered
   from another company's or user's copy never matches, even when the two
   lists happen to be byte-identical. */
export async function pollEtagFor(body: ArrayBuffer, identity: string): Promise<string> {
  const prefix = new TextEncoder().encode(`${identity}\n`);
  const joined = new Uint8Array(prefix.byteLength + body.byteLength);
  joined.set(prefix, 0);
  joined.set(new Uint8Array(body), prefix.byteLength);
  return `"${hex(await crypto.subtle.digest("SHA-1", joined))}"`;
}

/* Cloudflare weakens a strong tag to W/"…" when it compresses the body on the
   way out, so the browser sends the weak form back. If-None-Match is a weak
   comparison by definition (RFC 9110 13.1.2). */
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
  // A route that already chose its own caching keeps it.
  if (res.headers.has("ETag") || res.headers.has("Cache-Control")) return;

  const headers = new Headers(res.headers);
  /* A renewed session pass rides on this response. A stored copy would hand
     that pass back on every later 304, overwriting a newer one, and a 304 of
     ours would drop a fresh one. So this response is neither stored nor tagged. */
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

  // Clear first: assigning c.res over an existing response merges the old
  // headers back in, which would put Content-Type/Length on a bodyless 304.
  c.res = undefined;
  if (ifNoneMatchHits(c.req.header("If-None-Match"), tag)) {
    for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) headers.delete(h);
    c.res = new Response(null, { status: 304, headers });
    return;
  }
  c.res = new Response(body, { status: 200, statusText: res.statusText, headers });
};

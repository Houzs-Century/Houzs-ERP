/* ETag + 304 on the polled lists (middleware/pollEtag.ts).
 *
 * What must hold, each pinned below:
 *   - an unchanged poll is answered with a bodyless 304 carrying the same tag;
 *   - a changed body, another company, or another user never gets that 304;
 *   - errors, a route's own caching, and a response carrying a renewed session
 *     pass are left alone (a stored pass would be handed back on later 304s);
 *   - index.ts mounts it inside auth + companyContext and above the routers,
 *     and every listed path is a real GET route. */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pollEtag, ifNoneMatchHits, POLLED_LIST_PATHS, POLL_CACHE_CONTROL } from "../src/middleware/pollEtag";

type State = { rows: unknown[]; status: number; pass: string | null; ownCache: string | null };

function app(state: State) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.header("Vary", "Origin");
    await next();
  });
  a.use("*", async (c, next) => {
    c.set("user" as never, { id: Number(c.req.header("X-Test-User") ?? 7) } as never);
    c.set("companyId" as never, (c.req.header("X-Company-Id") ?? "1") as never);
    if (state.pass) c.header("X-Session-Pass", state.pass);
    await next();
  });
  a.use("/list", pollEtag);
  a.get("/list", (c) => {
    if (state.ownCache) c.header("Cache-Control", state.ownCache);
    return state.status === 200 ? c.json({ rows: state.rows }) : c.json({ error: "no" }, state.status as 403);
  });
  a.post("/list", (c) => c.json({ rows: state.rows }));
  return a;
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: 1000 + i,
    kind: "comment",
    actor_name: "Driver Ahmad bin Ismail",
    body: `Delivered to site, customer signed, photo ${i} attached`,
    created_at: "2026-11-09T08:15:00.000Z",
  }));

const base = (): State => ({ rows: rows(3), status: 200, pass: null, ownCache: null });

describe("pollEtag", () => {
  it("tags a 200 and answers a matching poll with an empty 304", async () => {
    const a = app(base());
    const first = await a.request("/list", { headers: { "X-Company-Id": "1" } });
    expect(first.status).toBe(200);
    const tag = first.headers.get("ETag");
    expect(tag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers.get("Cache-Control")).toBe(POLL_CACHE_CONTROL);
    expect(first.headers.get("Vary")).toBe("Origin, Authorization, X-Company-Id");
    expect((await first.json()).rows).toHaveLength(3);

    const again = await a.request("/list", { headers: { "X-Company-Id": "1", "If-None-Match": tag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(tag);
    expect(again.headers.get("Cache-Control")).toBe(POLL_CACHE_CONTROL);
    expect(again.headers.get("Vary")).toContain("X-Company-Id");
    expect(again.headers.get("Content-Type")).toBeNull();
  });

  it("accepts the weak form Cloudflare sends back after compressing, and a list", async () => {
    const a = app(base());
    const tag = (await a.request("/list")).headers.get("ETag")!;
    expect((await a.request("/list", { headers: { "If-None-Match": `W/${tag}` } })).status).toBe(304);
    expect((await a.request("/list", { headers: { "If-None-Match": `"zzz", W/${tag}` } })).status).toBe(304);
  });

  it("sends the new body when the list changed", async () => {
    const s = base();
    const a = app(s);
    const tag = (await a.request("/list")).headers.get("ETag")!;
    s.rows = rows(4);
    const next = await a.request("/list", { headers: { "If-None-Match": tag } });
    expect(next.status).toBe(200);
    expect(next.headers.get("ETag")).not.toBe(tag);
    expect((await next.json()).rows).toHaveLength(4);
  });

  it("never lets one company's or one user's tag answer for another, even for an identical body", async () => {
    const a = app(base());
    const tagCo1 = (await a.request("/list", { headers: { "X-Company-Id": "1" } })).headers.get("ETag")!;
    const co2 = await a.request("/list", { headers: { "X-Company-Id": "2", "If-None-Match": tagCo1 } });
    expect(co2.status).toBe(200);
    expect(co2.headers.get("ETag")).not.toBe(tagCo1);
    const user8 = await a.request("/list", { headers: { "X-Company-Id": "1", "X-Test-User": "8", "If-None-Match": tagCo1 } });
    expect(user8.status).toBe(200);
  });

  it("leaves refusals and errors untouched", async () => {
    const s = base();
    s.status = 403;
    const r = await app(s).request("/list", { headers: { "If-None-Match": "*" } });
    expect(r.status).toBe(403);
    expect(r.headers.get("ETag")).toBeNull();
    expect(r.headers.get("Cache-Control")).toBeNull();
  });

  it("leaves a route's own Cache-Control alone", async () => {
    const s = base();
    s.ownCache = "private, max-age=300";
    const r = await app(s).request("/list");
    expect(r.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(r.headers.get("ETag")).toBeNull();
  });

  it("does not store or tag a response that carries a renewed session pass", async () => {
    const s = base();
    const tag = (await app(s).request("/list")).headers.get("ETag")!;
    s.pass = "fresh-pass";
    const r = await app(s).request("/list", { headers: { "If-None-Match": tag } });
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Session-Pass")).toBe("fresh-pass");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("ETag")).toBeNull();
    expect((await r.json()).rows).toHaveLength(3);
  });

  it("ignores writes", async () => {
    const r = await app(base()).request("/list", { method: "POST" });
    expect(r.headers.get("ETag")).toBeNull();
  });

  it("measures what an unchanged poll costs before and after", async () => {
    const a = app({ ...base(), rows: rows(200) });
    const full = await a.request("/list");
    const bodyBytes = (await full.clone().arrayBuffer()).byteLength;
    const tag = full.headers.get("ETag")!;
    const notModified = await a.request("/list", { headers: { "If-None-Match": tag } });
    const headerBytes = (h: Headers) => [...h].reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
    const before = bodyBytes + headerBytes(full.headers);
    const after = (await notModified.arrayBuffer()).byteLength + headerBytes(notModified.headers);
    process.stdout.write(`[pollEtag] 200-row list, unchanged poll: before ${before} bytes, after ${after} bytes (body ${bodyBytes} -> 0)\n`);
    expect(notModified.status).toBe(304);
    expect(after).toBeLessThan(before / 50);
  });
});

describe("ifNoneMatchHits", () => {
  it("is a weak comparison and rejects absence", () => {
    expect(ifNoneMatchHits(undefined, '"a"')).toBe(false);
    expect(ifNoneMatchHits('"b"', '"a"')).toBe(false);
    expect(ifNoneMatchHits(' W/"a" ', '"a"')).toBe(true);
  });
});

describe("wiring", () => {
  const index = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
  const mount = index.indexOf("for (const path of POLLED_LIST_PATHS) app.use(path, pollEtag);");

  it("is mounted inside auth and companyContext and above every router it wraps", () => {
    expect(mount).toBeGreaterThan(0);
    expect(index.indexOf('app.use("/api/*", auth);')).toBeLessThan(mount);
    expect(index.indexOf('app.use("/api/*", companyContext);')).toBeLessThan(mount);
    for (const r of ['app.route("/api/scm", scmApp)', 'app.route("/api/projects", projects)', 'app.route("/api/announcements", announcements)', 'app.route("/api/it-support", itSupport)']) {
      const at = index.indexOf(r);
      expect(at, r).toBeGreaterThan(mount);
    }
  });

  it("lists only paths that are real GET routes", () => {
    const matrix = readFileSync(resolve(__dirname, "../../docs/generated/route-capability-matrix.csv"), "utf8");
    const gets = new Set(matrix.split("\n").filter((l) => l.startsWith("GET,")).map((l) => l.split(",")[1]));
    for (const p of POLLED_LIST_PATHS) {
      expect(gets.has(p), p).toBe(true);
    }
  });
});

// The SPA fallback must never answer a code URL with the app shell.
//
// `public/_redirects` is a single `/*  /index.html  200`, so a file that is not
// on disk comes back as the shell with status 200. Under a hashed .js URL the
// browser fails the module import AND the CDN caches that HTML under the
// asset's own URL — the 2026-07-31 edge-poison outage. These cases pin the
// 404 that replaced it.
import { describe, expect, it } from "vitest";

import { onRequest } from "./[[path]]";

const html = (body = "<!doctype html><html></html>") =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const js = () =>
  new Response("export const a = 1;", {
    status: 200,
    headers: { "content-type": "application/javascript" },
  });

function call(path: string, nextResponse: Response, headers: Record<string, string> = {}) {
  const request = new Request(`https://erp.houzscentury.com${path}`, { headers });
  return onRequest({
    request,
    env: { ASSETS: { fetch: async () => html() } },
    next: async () => nextResponse,
  });
}

describe("SPA fallback", () => {
  it("turns an HTML answer for a missing chunk into a real 404", async () => {
    const res = await call("/assets3/index-BZR8oDnw.js", html());
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).not.toMatch(/text\/html/);
  });

  it("does the same for the other asset kinds a shell would poison", async () => {
    for (const path of [
      "/assets3/index-Bl2khED3.css",
      "/assets3/chunk.js.map",
      "/manifest.webmanifest",
      "/fonts/inter.woff2",
      "/sw.js",
    ]) {
      const res = await call(path, html());
      expect(res.status, path).toBe(404);
    }
  });

  it("passes a real asset straight through", async () => {
    const res = await call("/assets3/index-BZR8oDnw.js", js());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  it("passes a genuine 404 through unchanged rather than rewriting it", async () => {
    const missing = new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
    const res = await call("/assets3/gone.js", missing);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
  });

  it("still serves the shell for paths that are legitimately HTML", async () => {
    const res = await call("/offline.html", html());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("still serves the shell for a dotless SPA route", async () => {
    const res = await call("/scm/purchase-orders", html());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("does not 404 a SPA route that merely contains a dot in an earlier segment", async () => {
    const res = await call("/projects/2990.co/overview", html());
    expect(res.status).toBe(200);
  });

  // The regression this fix nearly shipped. Before it, a dotted LAST segment
  // fell through to the `_redirects` catch-all and the route worked. Only
  // known static extensions may become a 404; a slug that merely looks dotted
  // must keep the shell.
  it("still serves the shell for SPA routes whose last segment has a non-asset dot", async () => {
    for (const path of [
      "/customers/john.doe",
      "/projects/2990.co",
      "/scm/sales-orders/2990-SO-2607-017.A",
      "/search/acme.com",
    ]) {
      const res = await call(path, html());
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/text\/html/);
    }
  });
});

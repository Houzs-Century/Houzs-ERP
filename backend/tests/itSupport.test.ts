// /api/it-support is a proxy to the Houzs IT Hub. Driven through the REAL router
// with the hub faked, because every rule that matters here is about what leaves
// the Worker and what comes back:
//
//   1. The reporter is the SESSION's user. Nothing in the request changes whose
//      requests are read or who a new one is filed as.
//   2. The hub key goes to the hub and nowhere else.
//   3. "Could not ask the hub" is never reported as "you have no requests" —
//      asserted by STATUS, never by emptiness, since an empty list passes
//      against a working proxy, a broken one and a dead hub alike.
//   4. A hub 401 (our key is wrong) never reaches the browser as 401: the api
//      client treats 401 as an expired session and signs the user out.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import itSupport from "../src/routes/itSupport";

const ENV = { IT_HUB_URL: "https://hub.example/", IT_HUB_API_KEY_HOUZS: "hub_hc_test-key", IT_HUB_API_KEY_2990: "hub_2990_test-key" };
const AINA = { id: 42, email: "aina@houzs.test", name: "Aina", department_name: "Sales" };
const NO_NAME = { id: 43, email: "noname@houzs.test", name: null };
const SERVICE = { id: 0, email: "service@local", name: "Service" };

function appAs(user: unknown, env: Record<string, string> = ENV, companyCode: string | null = "HOUZS") {
  const app = new Hono();
  app.use("*", async (c: any, next: any) => {
    c.set("user", user);
    if (companyCode) c.set("companyCode", companyCode);
    await next();
  });
  app.route("/api/it-support", itSupport);
  return { request: (path: string, init?: RequestInit) => app.request(path, init, env) };
}

type Call = { url: string; method: string; headers: Headers; body: unknown };

function fakeHub(answer: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    return answer(String(url), init);
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/it-support", () => {
  test("my requests: asks the hub as the session's user, with the key", async () => {
    const calls = fakeHub(() => json({ tickets: [{ code: "HC-0001", unread: true }] }));
    const res = await appAs(AINA).request("/api/it-support/tickets?status=open");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [{ code: "HC-0001", unread: true }] });
    expect(calls).toHaveLength(1);
    // Nothing from the query string travels: the hub is asked for the caller's whole list.
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/tickets");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer hub_hc_test-key");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");
  });

  test("unread count: the hub's number as { count }, the shape every menu count reads", async () => {
    const calls = fakeHub(() => json({ unread: 3 }));
    const res = await appAs(AINA).request("/api/it-support/unread-count");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 3 });
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/tickets/unread-count");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");
    for (const odd of [{}, { unread: "x" }, { unread: -2 }]) {
      fakeHub(() => json(odd));
      expect(await (await appAs(AINA).request("/api/it-support/unread-count")).json()).toEqual({ count: 0 });
    }
    // Not connected stays an error, so the menu shows no count rather than a made-up 0.
    expect((await appAs(AINA, {}).request("/api/it-support/unread-count")).status).toBe(501);
  });

  test("status: connected only where both settings are present; not connected is an answer, not an error", async () => {
    const calls = fakeHub(() => json({}));
    const on = await appAs(AINA).request("/api/it-support/status");
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ connected: true });
    for (const env of [{}, { IT_HUB_URL: "https://hub.example" }, { IT_HUB_API_KEY_HOUZS: "k" }]) {
      const off = await appAs(AINA, env as Record<string, string>).request("/api/it-support/status");
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ connected: false });
    }
    expect((await appAs(SERVICE).request("/api/it-support/status")).status).toBe(403);
    // Answering it never asks the hub, and never carries the key or the address.
    expect(calls).toHaveLength(0);
    expect(await (await appAs(AINA).request("/api/it-support/status")).text()).not.toMatch(/hub_hc_test-key|hub.example/);
  });
  test("the inbox follows the active company: 2990 uses its own key, and never borrows Houzs's", async () => {
    const calls = fakeHub(() => json({ code: "2990-0001", status: "open" }, 201));
    const post = (company: string | null, env: Record<string, string> = ENV) =>
      appAs(AINA, env, company).request("/api/it-support/tickets", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Printer" }),
      });

    expect((await post("2990")).status).toBe(201);
    expect(calls[0].headers.get("Authorization")).toBe("Bearer hub_2990_test-key");
    expect((await post("HOUZS")).status).toBe(201);
    expect(calls[1].headers.get("Authorization")).toBe("Bearer hub_hc_test-key");
    await appAs(AINA, ENV, "2990").request("/api/it-support/tickets");
    expect(calls[2].headers.get("Authorization")).toBe("Bearer hub_2990_test-key");

    // 2990 with no key of its own is NOT connected. Falling back to the Houzs
    // key would file the request in the wrong inbox and report success.
    const houzsOnly = { IT_HUB_URL: "https://hub.example", IT_HUB_API_KEY_HOUZS: "hub_hc_test-key" };
    expect((await post("2990", houzsOnly)).status).toBe(501);
    const status = await appAs(AINA, houzsOnly, "2990").request("/api/it-support/status");
    expect(await status.json()).toEqual({ connected: false });
    expect(await (await appAs(AINA, houzsOnly, "HOUZS").request("/api/it-support/status")).json()).toEqual({ connected: true });
    // A code that is not a plain company code never becomes part of a secret's name.
    expect((await post("2990 X")).status).toBe(501);
    expect((await post("__proto__")).status).toBe(501);
    // The company could not be resolved: refuse and ask for a retry, never guess.
    expect((await post(null)).status).toBe(503);
    expect(calls).toHaveLength(3);
  });
  test("the reporter cannot be chosen by the request", async () => {
    const calls = fakeHub(() => json({ tickets: [] }));
    await appAs(AINA).request("/api/it-support/tickets?userId=7&reporter_id=7", { headers: { "X-Reporter-Id": "7" } });
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");
    expect(calls[0].url).not.toMatch(/[?&](userId|reporter_id)=/);
  });

  test("the service-tier caller and a missing user are refused before the hub", async () => {
    const calls = fakeHub(() => json({}));
    for (const user of [SERVICE, undefined, { id: "42", email: "x" }]) {
      for (const [path, method] of [
        ["/api/it-support/tickets", "GET"],
        ["/api/it-support/unread-count", "GET"],
        ["/api/it-support/tickets/HC-0001", "GET"],
        ["/api/it-support/tickets", "POST"],
        ["/api/it-support/tickets/HC-0001/replies", "POST"],
        ["/api/it-support/tickets/HC-0001/confirm", "POST"],
        ["/api/it-support/attachments/1", "GET"],
      ]) {
        const res = await appAs(user).request(path, { method });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect(calls).toHaveLength(0);
  });

  test("not connected: 501, not an empty list", async () => {
    const calls = fakeHub(() => json({ tickets: [] }));
    for (const env of [{}, { IT_HUB_URL: "https://hub.example" }, { IT_HUB_API_KEY_HOUZS: "k" }, { IT_HUB_URL: " ", IT_HUB_API_KEY_HOUZS: "k" }, { IT_HUB_URL: "https://hub.example", IT_HUB_API_KEY: "k" }]) {
      const res = await appAs(AINA, env as Record<string, string>).request("/api/it-support/tickets");
      expect(res.status).toBe(501);
      expect(typeof ((await res.json()) as { error?: string }).error).toBe("string");
    }
    expect(calls).toHaveLength(0);
  });

  test("hub down, or refusing our key: 502, never 401 and never a list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let mode = "throw";
    fakeHub(() => {
      if (mode === "throw") throw new Error("connect ETIMEDOUT");
      if (mode === "badkey") return json({ error: "Invalid API key" }, 401);
      if (mode === "html") return new Response("<html>502</html>", { status: 502 });
      return json({ error: "boom" }, 500);
    });
    const app = appAs(AINA);
    for (mode of ["throw", "badkey", "html", "500"]) {
      for (const path of ["/api/it-support/tickets", "/api/it-support/tickets/HC-0001", "/api/it-support/unread-count"]) {
        const res = await app.request(path);
        expect(res.status, `${mode} ${path}`).toBe(502);
        const text = await res.text();
        expect(text).not.toMatch(/Invalid API key|boom|ETIMEDOUT|hub_hc_test-key|tickets/);
      }
    }
  });

  test("the hub's refusals reach the reporter in our words", async () => {
    fakeHub((url) =>
      url.endsWith("/confirm") ? json({ error: "Only a resolved ticket can be confirmed" }, 409)
        : url.endsWith("/replies") ? json({ error: "Ticket is closed. Please open a new one." }, 409)
          : json({ error: "Not found" }, 404));
    const app = appAs(AINA);
    const confirm = await app.request("/api/it-support/tickets/HC-0002/confirm", { method: "POST" });
    expect(confirm.status).toBe(409);
    expect(((await confirm.json()) as { error: string }).error).toMatch(/not marked this request as done/);
    const reply = await app.request("/api/it-support/tickets/HC-0002/replies", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "hello" }),
    });
    expect(reply.status).toBe(409);
    expect(((await reply.json()) as { error: string }).error).toMatch(/is closed/);
    expect((await app.request("/api/it-support/tickets/HC-0999")).status).toBe(404);
  });

  test("report a problem: reporter fields come from the session, not the form", async () => {
    const calls = fakeHub(() => json({ code: "HC-0007", status: "open" }, 201));
    const form = new FormData();
    form.set("title", "  Delivery order will not save  ");
    form.set("description", "After choosing the lorry");
    form.set("type", "bug");
    form.set("priority", "high");
    form.set("page_url", "/scm/delivery-orders");
    form.set("occurred_at", "2026-10-15T02:00:00.000Z");
    form.set("reporter_name", "The Boss");
    form.set("reporter_email", "boss@houzs.test");
    form.set("reporter_department", "Board");
    form.set("user_agent", "forged");
    form.set("legacy_code", "DEV-1");
    form.append("files", new File(["png-bytes"], "shot.png", { type: "image/png" }));
    form.append("files", new File([], "empty.png", { type: "image/png" }));
    form.append("files", new File(["zip-bytes"], "logs.zip", { type: "" }));

    const res = await appAs(AINA).request("/api/it-support/tickets", {
      method: "POST", body: form, headers: { "User-Agent": "Mozilla/Test" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { code: string }).code).toBe("HC-0007");

    const sent = calls[0].body as FormData;
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/tickets");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");
    expect(sent.get("title")).toBe("Delivery order will not save");
    expect(sent.get("priority")).toBe("high");
    expect(sent.get("page_url")).toBe("/scm/delivery-orders");
    expect(sent.get("occurred_at")).toBe("2026-10-15T02:00:00.000Z");
    expect(sent.get("reporter_name")).toBe("Aina");
    expect(sent.get("reporter_email")).toBe("aina@houzs.test");
    expect(sent.get("reporter_department")).toBe("Sales");
    expect(sent.get("user_agent")).toBe("Mozilla/Test");
    expect(sent.get("legacy_code")).toBeNull();
    const files = sent.getAll("files") as File[];
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("shot.png");
    expect(await files[0].text()).toBe("png-bytes");
    expect(files[1].name).toBe("logs.zip");
  });

  test("report a problem: bad input is refused before the hub; a nameless user reports under their email", async () => {
    const calls = fakeHub(() => json({ code: "HC-0008", status: "open" }, 201));
    const post = (user: unknown, body: unknown, raw?: string) =>
      appAs(user).request("/api/it-support/tickets", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body),
      });
    expect((await post(AINA, { title: "   " })).status).toBe(400);
    expect((await post(AINA, null, "{not json")).status).toBe(400);
    expect((await post(AINA, { title: "x", priority: "asap" })).status).toBe(400);
    expect((await post(AINA, { title: "x", type: "feature" })).status).toBe(400);

    const txt = new FormData();
    txt.set("title", "x");
    txt.append("files", new File(["a"], "notes.txt", { type: "text/plain" }));
    expect((await appAs(AINA).request("/api/it-support/tickets", { method: "POST", body: txt })).status).toBe(400);

    const many = new FormData();
    many.set("title", "x");
    for (let i = 0; i < 6; i++) many.append("files", new File(["a"], `s${i}.png`, { type: "image/png" }));
    expect((await appAs(AINA).request("/api/it-support/tickets", { method: "POST", body: many })).status).toBe(400);
    expect(calls).toHaveLength(0);

    expect((await post(NO_NAME, { title: "Printer" })).status).toBe(201);
    const sent = calls[0].body as FormData;
    expect(sent.get("title")).toBe("Printer");
    expect(sent.get("reporter_name")).toBe("noname@houzs.test");
    expect(sent.get("reporter_department")).toBeNull();
  });

  test("reply: needs text or a file; forwards both", async () => {
    const calls = fakeHub(() => json({ ok: true, status: "in_progress" }, 201));
    const app = appAs(AINA);
    const empty = await app.request("/api/it-support/tickets/HC-0001/replies", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "  " }),
    });
    expect(empty.status).toBe(400);
    expect(calls).toHaveLength(0);

    const form = new FormData();
    form.set("body", "Still broken");
    form.append("files", new File(["x"], "again.png", { type: "image/png" }));
    const res = await app.request("/api/it-support/tickets/HC-0001/replies", { method: "POST", body: form });
    expect(res.status).toBe(201);
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/tickets/HC-0001/replies");
    const sent = calls[0].body as FormData;
    expect(sent.get("body")).toBe("Still broken");
    expect(sent.getAll("files")).toHaveLength(1);
  });

  test("a request code or attachment id that is not one never reaches the hub", async () => {
    const calls = fakeHub(() => json({}));
    const app = appAs(AINA);
    for (const [path, method] of [
      ["/api/it-support/tickets/..%2F..%2Fdev%2Ftickets", "GET"],
      ["/api/it-support/tickets/hc-0001", "GET"],
      ["/api/it-support/tickets/HC-0001%3Fx=1/confirm", "POST"],
      ["/api/it-support/tickets/not-a-code/replies", "POST"],
      ["/api/it-support/attachments/1%2F..%2F2", "GET"],
      ["/api/it-support/attachments/abc", "GET"],
    ]) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test("attachment: bytes and type pass through, a hub failure does not", async () => {
    let mode = "ok";
    const calls = fakeHub(() => {
      if (mode === "ok") {
        return new Response("png-bytes", {
          headers: { "Content-Type": "image/png", "Content-Disposition": 'inline; filename="shot.png"', "Set-Cookie": "x=1" },
        });
      }
      if (mode === "404") return json({ error: "Not found" }, 404);
      return json({ error: "Invalid API key" }, 401);
    });
    const app = appAs(AINA);
    const ok = await app.request("/api/it-support/attachments/12");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect(ok.headers.get("Content-Disposition")).toBe('inline; filename="shot.png"');
    expect(ok.headers.get("Set-Cookie")).toBeNull();
    expect(await ok.text()).toBe("png-bytes");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");

    mode = "404";
    expect((await app.request("/api/it-support/attachments/12")).status).toBe(404);
    mode = "badkey";
    expect((await app.request("/api/it-support/attachments/12")).status).toBe(502);
  });
});

// /api/meetings and /api/public/meetings proxy the meeting-room hub. Driven through the
// real routers with the hub faked, because what matters is what leaves the Worker:
//   1. The person is the SESSION's user, with their name, email, company and department.
//   2. "Manage meeting rooms" is decided here; without it room writes never reach the hub.
//   3. A booking conflict (409) comes back with its whole body for the dialog.
//   4. A guest call goes out as X-Reporter-Id: guest and only to /public.
//   5. A hub 401 (our key is wrong) never reaches the browser as 401.
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import meetings, { publicMeetings } from "../src/routes/meetings";
import { directoryFor } from "../src/services/meetingsDirectory";

const ENV = { IT_HUB_URL: "https://hub.example/", IT_HUB_API_KEY_HOUZS: "hub_hc_key", IT_HUB_API_KEY_2990: "hub_2990_key" };
const AINA = { id: 42, email: "aina@houzs.test", name: "Aina", department_name: "Sales", permissions: [], permissions_set: new Set<string>() };
const BOSS = { ...AINA, id: 7, name: "Lim", permissions: ["meetings.manage_rooms"], permissions_set: new Set(["meetings.manage_rooms"]) };
const COMPANIES = [{ id: 1, code: "HOUZS", name: "Houzs Century" }, { id: 2, code: "2990", name: "2990s" }];

function appAs(user: unknown, env: Record<string, string> = ENV, companyCode = "HOUZS") {
  const app = new Hono();
  app.route("/api/public/meetings", publicMeetings);
  app.use("/api/meetings/*", async (c: any, next: any) => {
    c.set("user", user);
    c.set("companyCode", companyCode);
    c.set("companies", COMPANIES);
    await next();
  });
  app.route("/api/meetings", meetings);
  return { request: (path: string, init?: RequestInit) => app.request(path, init, { ...env, RATE_LIMIT: undefined } as never) };
}

type Call = { url: string; method: string; headers: Headers; body: unknown };
function fakeHub(answer: (url: string, init: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    return answer(String(url), init);
  });
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const post = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/meetings", () => {
  test("asks the hub as the session's user, with who they are", async () => {
    const calls = fakeHub(() => json({ me: "aina@houzs.test", rooms: [], people: [] }));
    const res = await appAs(AINA).request("/api/meetings/bootstrap", { headers: { "X-Reporter-Id": "999" } });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/meetings/bootstrap");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer hub_hc_key");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("42");
    expect(calls[0].headers.get("X-Person-Name")).toBe("Aina");
    expect(calls[0].headers.get("X-Person-Company")).toBe("Houzs Century");
    expect(calls[0].headers.get("X-Person-Department")).toBe("Sales");
    expect(calls[0].headers.get("X-Can-Manage-Rooms")).toBe("0");
  });

  test("the active company picks the key", async () => {
    const calls = fakeHub(() => json({ meetings: [] }));
    await appAs(AINA, ENV, "2990").request("/api/meetings/mine");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer hub_2990_key");
    expect(calls[0].headers.get("X-Person-Company")).toBe("2990s");
  });

  test("room changes need Manage meeting rooms, decided here", async () => {
    const calls = fakeHub(() => json({ ok: true, id: 1 }, 201));
    const refused = await appAs(AINA).request("/api/meetings/rooms", post({ name: "Boardroom", seats: 12 }));
    expect(refused.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await appAs(AINA).request("/api/meetings/log")).status).toBe(403);
    const ok = await appAs(BOSS).request("/api/meetings/rooms", post({ name: "Boardroom", seats: 12 }));
    expect(ok.status).toBe(201);
    expect(calls[0].headers.get("X-Can-Manage-Rooms")).toBe("1");
  });

  test("a booking conflict comes back whole, for the dialog", async () => {
    const conflict = { error: "conflict", conflict: { room: null, people: [{ key: "adrian@houzs.test", meeting: { id: 3, title: "Supplier visit" } }], rules: [] }, suggestTime: "2026-11-24T07:00:00.000Z", suggestRooms: [] };
    fakeHub(() => json(conflict, 409));
    const res = await appAs(AINA).request("/api/meetings/meetings", post({ title: "Q4", start: "2026-11-24T06:00:00Z", end: "2026-11-24T07:00:00Z" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(conflict);
  });

  test("the hub refusing our key is 502, never 401", async () => {
    fakeHub(() => json({ error: "Invalid API key" }, 401));
    expect((await appAs(AINA).request("/api/meetings/mine")).status).toBe(502);
  });

  test("not connected is 501, and status says so without an error", async () => {
    expect((await appAs(AINA, {}).request("/api/meetings/mine")).status).toBe(501);
    const s = await appAs(AINA, {}).request("/api/meetings/status");
    expect(await s.json()).toEqual({ connected: false });
  });

  test("the service caller is not a person", async () => {
    expect((await appAs({ id: 0, email: "svc@local", permissions: [] }).request("/api/meetings/mine")).status).toBe(403);
  });

  test("a meeting file opens in place only as png, jpeg, gif, webp or pdf; anything else downloads (R&D 2026-11-27 #3)", async () => {
    const file = (type: string) => () => new Response("<script>x</script>", { headers: { "Content-Type": type, "Content-Disposition": 'inline; filename="a.html"' } });
    fakeHub(file("text/html; charset=utf-8"));
    const html = await appAs(AINA).request("/api/meetings/meetings/5/files/9");
    expect(html.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(html.headers.get("Content-Disposition")).toBe('attachment; filename="a.html"');
    expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
    fakeHub(file("image/svg+xml"));
    expect((await appAs(AINA).request("/api/meetings/meetings/5/files/9")).headers.get("Content-Type")).toBe("application/octet-stream");
    fakeHub(file("application/pdf"));
    const pdf = await appAs(AINA).request("/api/meetings/meetings/5/files/9");
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdf.headers.get("Content-Disposition")).toBe('inline; filename="a.html"');
  });

  test("unread count is { count }", async () => {
    fakeHub(() => json({ unread: 4 }));
    expect(await (await appAs(AINA).request("/api/meetings/unread-count")).json()).toEqual({ count: 4 });
  });
});

describe("/api/public/meetings (guests)", () => {
  test("a guest goes out as guest, only to /public", async () => {
    const calls = fakeHub(() => json({ slots: [] }));
    const res = await appAs(null).request("/api/public/meetings/links/hc-0123456789/slots?day=2026-11-24", { headers: { Host: "erp.houzscentury.com" } });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/meetings/public/links/hc-0123456789/slots?day=2026-11-24");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("guest");
    expect(calls[0].headers.get("X-Person-Name")).toBeNull();
  });

  test("a guest booking sends only the booking fields", async () => {
    const calls = fakeHub(() => json({ ok: true, token: "a".repeat(64) }, 201));
    await appAs(null).request("/api/public/meetings/links/hc-0123456789/book", post({
      start: "2026-11-24T06:00:00Z", end: "2026-11-24T07:00:00Z", roomId: 1, name: "Lee", phone: "1", email: "l@x.y",
      company: "ABC", department: "", title: "Intro", people: 3, organizer: "boss@x", attendees: ["x@y"], guest_token: "z",
    }));
    expect(JSON.parse(String(calls[0].body))).toEqual({
      start: "2026-11-24T06:00:00Z", end: "2026-11-24T07:00:00Z", roomId: 1, name: "Lee", phone: "1", email: "l@x.y",
      company: "ABC", department: "", title: "Intro", people: 3,
    });
  });

  test("a guest reads one day of a link: taken times per room, through /public only", async () => {
    const calls = fakeHub(() => json({ day: "2026-11-24", open: true, rooms: [] }));
    const res = await appAs(null).request("/api/public/meetings/links/hc-0123456789/day?day=2026-11-24", { headers: { Host: "erp.houzscentury.com" } });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://hub.example/api/v1/sys/meetings/public/links/hc-0123456789/day?day=2026-11-24");
    expect(calls[0].headers.get("X-Reporter-Id")).toBe("guest");
    expect((await appAs(null).request("/api/public/meetings/links/hc-0123456789/day?day=tomorrow")).status).toBe(400);
  });

  test("odd link codes and tokens never reach the hub", async () => {
    const calls = fakeHub(() => json({}));
    expect((await appAs(null).request("/api/public/meetings/links/..%2Fcalendar")).status).toBe(404);
    expect((await appAs(null).request("/api/public/meetings/bookings/abc")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("directoryFor", () => {
  const users = [
    { id: 1, name: "Lim", email: "lim@x", department: "Management", position_department: null },
    { id: 2, name: null, email: "noname@x", department: null, position_department: "Sales" },
    { id: 3, name: "Only2990", email: "o@x", department: null, position_department: null },
  ];
  const grants = [{ user_id: 3, company_id: 2 }];
  test("a user with no grant is in every company; a granted user only in theirs", () => {
    const hc = directoryFor({ id: 1, code: "HOUZS", name: "Houzs Century" }, users, grants);
    expect(hc.map((p) => p.id)).toEqual(["1", "2"]);
    expect(hc[1]).toEqual({ id: "2", name: "noname@x", email: "noname@x", company: "Houzs Century", department: "Sales" });
    expect(directoryFor({ id: 2, code: "2990", name: "2990s" }, users, grants).map((p) => p.id)).toEqual(["1", "2", "3"]);
  });
});

describe("meeting emails after a change", () => {
  test("a booking made here then collects this company's emails from the hub; a refused one does not", async () => {
    const calls = fakeHub((url) => (url.endsWith("/mail/claim") ? json({ mail: [] }) : json({ ok: true, ids: [5] }, 201)));
    const res = await appAs(AINA).request("/api/meetings/meetings", post({ title: "Weekly" }));
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith("/mail/claim"))).toBe(true));
    const claim = calls.find((c) => c.url.endsWith("/mail/claim"))!;
    expect(claim.headers.get("Authorization")).toBe("Bearer hub_hc_key");

    const refused = fakeHub(() => json({ error: "Room is busy" }, 409));
    await appAs(AINA).request("/api/meetings/meetings", post({ title: "Clash" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(refused.some((c) => c.url.endsWith("/mail/claim"))).toBe(false);
  });
});

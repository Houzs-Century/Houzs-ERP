// Production, 7 days: 57,484 of 60,644 client-error occurrences (95%) were
// "[slow ...]" notes, each one riding a POST to /api/client-errors — the
// route was the 3rd-heaviest by Worker time. Slow requests are now counted
// locally and leave as one summary batch per 10 minutes. These pin that.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sent = vi.hoisted(() => ({ bodies: [] as Array<{ events: Array<Record<string, unknown>> }> }));
vi.mock("./requestCorrelation", () => ({
  correlatedFetch: vi.fn((_url: string, init: RequestInit) => {
    sent.bodies.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response("{}"));
  }),
  requestIdFromError: () => undefined,
}));
vi.mock("./authToken", () => ({ readAuthToken: () => "tok" }));
vi.mock("../api/client", () => ({
  api: { baseUrl: "" },
  requestIdFromError: () => undefined,
  onRequestTelemetry: () => () => {},
}));

async function freshReporter() {
  vi.resetModules();
  const mod = await import("./errorReporter");
  mod.installGlobalErrorReporting();
  return mod;
}

beforeEach(() => {
  sent.bodies.length = 0;
  vi.useFakeTimers();
  vi.stubEnv("PROD", true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("slow request notes are a 10-minute summary", () => {
  test("hundreds of slow requests cost one POST per 10 minutes, with counts", async () => {
    const r = await freshReporter();
    for (let i = 0; i < 300; i++) r.reportSlowRequest("GET", `/api/mfg-sales-orders/${i}`, 1200);
    for (let i = 0; i < 40; i++) r.reportSlowRequest("GET", "/api/announcements/banner", 6000);

    vi.advanceTimersByTime(60_000);
    expect(sent.bodies).toHaveLength(0);

    vi.advanceTimersByTime(10 * 60_000);
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0].events).toEqual([
      expect.objectContaining({ message: "[slow 800ms+] GET /api/mfg-sales-orders/:id", count: 300, route: "" }),
      expect.objectContaining({ message: "[slow 5s+] GET /api/announcements/banner", count: 40, route: "" }),
    ]);

    vi.advanceTimersByTime(30 * 60_000);
    expect(sent.bodies).toHaveLength(1);
  });

  test("a summary carries at most 10 signatures and never exceeds the server's count cap", async () => {
    const r = await freshReporter();
    for (let i = 0; i < 1500; i++) r.reportSlowRequest("GET", "/api/auth/me", 900);
    // 60 more distinct endpoints: only 49 more are tracked, only 9 more are sent.
    for (let e = 0; e < 60; e++) r.reportSlowRequest("GET", `/api/endpoint-${String.fromCharCode(97 + (e % 26))}${e}`, 900);
    vi.advanceTimersByTime(10 * 60_000);
    const events = sent.bodies[0].events;
    expect(events).toHaveLength(10);
    expect(events[0]).toEqual(expect.objectContaining({ message: "[slow 800ms+] GET /api/auth/me", count: 1000 }));
  });

  test("real reports still flush on their own 60s timer and carry the slow counts along", async () => {
    const r = await freshReporter();
    r.reportSlowRequest("GET", "/api/branding", 2500);
    r.reportTimedOutRequest("POST", "/api/mfg-sales-orders/7/approve");
    vi.advanceTimersByTime(60_000);
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0].events.map((e) => e.message)).toEqual([
      "[timeout] POST /api/mfg-sales-orders/:id/approve",
      "[slow 2s+] GET /api/branding",
    ]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sent.bodies).toHaveLength(1);
  });

  test("a hidden tab does not post slow counts on their own", async () => {
    const r = await freshReporter();
    r.reportSlowRequest("GET", "/api/branding", 2500);
    window.dispatchEvent(new Event("pagehide"));
    expect(sent.bodies).toHaveLength(0);
  });
});

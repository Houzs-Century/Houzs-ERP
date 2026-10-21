import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/types";
import {
  __resetRateLimitForTest,
  buildEvent,
  captureError,
  describeErrorForLog,
  isErrorTrackingEnabled,
  parseDsn,
  parseStackFrames,
  redactText,
} from "../src/services/errorTracking";

// ---------------------------------------------------------------------------
// Error tracking (services/errorTracking.ts). Three properties, in the order
// they matter:
//
//   1. THE INERT PATH. With no SENTRY_DSN — the state EVERY environment is in
//      until the owner pastes a secret — the reporter must be indistinguishable
//      from not existing: zero outbound fetches, zero console output, no throw.
//      That is the default, so it is the path most likely to be exercised in
//      anger, and it is the only half of this feature that can be proved
//      without a real key.
//   2. PRIVACY. When it IS on, the payload must carry ids and patterns only.
//      The assertions are deliberately NEGATIVE — they name the keys an SDK
//      would have populated (headers, cookies, request body, query string,
//      email, IP address) and require their absence.
//   3. Mechanics: DSN parsing, stack frame order, the storm brake.
//
// What these tests CANNOT prove: that a real Sentry/GlitchTip project accepts
// the envelope, that alert rules fire, or that grouping is sensible. Those need
// a live DSN.
//
// `vi.stubGlobal`, not `vi.spyOn(globalThis, "fetch")`: stubGlobal assigns the
// property outright, which is the form that survives workerd's globals.
// ---------------------------------------------------------------------------

/** DSN SHAPE ONLY — no real project, no real key. The host is under .invalid
 *  (RFC 2606), which can never resolve, so a stub that failed to install could
 *  not accidentally send anything anywhere. */
const FAKE_DSN = "https://examplekey@o0.ingest.invalid/1234567";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

/** Stub global fetch with a counting spy and return it. */
function stubFetch() {
  const spy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Envelope POSTs only — the harness itself may fetch for unrelated reasons. */
function envelopeCalls(spy: ReturnType<typeof stubFetch>): unknown[][] {
  return spy.mock.calls.filter((call) => String(call[0]).includes("/envelope/"));
}

describe("error tracking — the inert path (no SENTRY_DSN)", () => {
  let fetchSpy: ReturnType<typeof stubFetch>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRateLimitForTest();
    fetchSpy = stubFetch();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetRateLimitForTest();
  });

  test("captureError makes no network call and writes nothing to the console", () => {
    captureError(envWith({ SENTRY_DSN: undefined }), new Error("boom"), {
      source: "worker",
      route: "/api/x",
      method: "GET",
      status: 500,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("a blank or malformed DSN behaves exactly like an absent one", () => {
    // A typo in the secret must look like an unset secret, not like an outage:
    // parseDsn returns null and the reporter returns before fetching.
    for (const dsn of ["", "   ", "not-a-url", "ftp://k@h/1", "https://o0.ingest.invalid/1", "https://k@h"]) {
      expect(() =>
        captureError(envWith({ SENTRY_DSN: dsn }), new Error("boom"), { source: "worker" }),
      ).not.toThrow();
      expect(isErrorTrackingEnabled(envWith({ SENTRY_DSN: dsn }))).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isErrorTrackingEnabled(envWith({ SENTRY_DSN: undefined }))).toBe(false);
  });

  test("driving the assembled app sends no envelope anywhere", async () => {
    // End-to-end rather than a unit call: proves the hook added to index.ts
    // onError inherits the inert default, and that merely mounting the module
    // does not open a connection at boot. The test env has no SENTRY_DSN, which
    // is exactly production's state today.
    await SELF.fetch("https://test.local/api/definitely-not-a-route", { method: "POST", body: "{}" });
    await SELF.fetch("https://test.local/health");
    expect(envelopeCalls(fetchSpy)).toHaveLength(0);
  });

  test("the /api/client-errors relay is inert too", async () => {
    // The browser-crash surface shares the one gate. Unauthenticated is enough
    // here: the relay sits after the session check, so a stray envelope from
    // anywhere in that route would still be caught.
    await SELF.fetch("https://test.local/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [{ message: "white screen", route: "/sales" }] }),
    });
    expect(envelopeCalls(fetchSpy)).toHaveLength(0);
  });
});

describe("error tracking — what leaves the building", () => {
  test("the event carries ids and patterns, and none of the fields an SDK would add", () => {
    const event = buildEvent({ SENTRY_ENVIRONMENT: "production" }, new Error("boom"), {
      source: "worker",
      route: "/api/scm/sales-orders/:id",
      method: "POST",
      status: 500,
      requestId: "abc123def456",
      userId: 42,
      companyId: 7,
    });
    const wire = JSON.stringify(event);

    // Present: the diagnostic minimum.
    expect(event.transaction).toBe("/api/scm/sales-orders/:id");
    expect((event.tags as Record<string, string>).request_id).toBe("abc123def456");
    expect((event.tags as Record<string, string>).company_id).toBe("7");

    // Absent: every default the official SDK would have attached. Sentry's own
    // Cloudflare quickstart ships `dataCollection` with httpBodies, cookies and
    // userInfo left ON — on this ERP that would mean customer names, phone
    // numbers, addresses and prices leaving in request bodies.
    expect(event.request).toEqual({ method: "POST", url: "/api/scm/sales-orders/:id" });
    expect(wire).not.toContain("headers");
    expect(wire).not.toContain("cookies");
    expect(wire).not.toContain("query_string");
    expect(wire).not.toContain("Authorization");

    // Identity is a number and nothing else — no name, no email, no username.
    // ip_address is present but explicitly null: an opt-OUT, not an omission,
    // so the ingest server does not infer one from the connection.
    expect(Object.keys(event.user as object).sort()).toEqual(["id", "ip_address"]);
    expect((event.user as Record<string, unknown>).id).toBe("42");
    expect((event.user as Record<string, unknown>).ip_address).toBeNull();
  });

  test("an anonymous event still opts out of IP inference", () => {
    const event = buildEvent({}, new Error("boom"), { source: "worker" });
    expect(event.user).toEqual({ ip_address: null });
  });

  test("customer data inside an error message is redacted before it is packed", () => {
    // The realistic leak: Postgres quotes the offending VALUE in a unique
    // violation, and on this schema that value is a customer's phone number.
    const pg =
      'duplicate key value violates unique constraint "customers_phone_key" ' +
      "Key (phone)=(0123456789) already exists.";
    expect(redactText(pg)).toContain("Key (phone)=([redacted])");
    expect(redactText(pg)).not.toContain("0123456789");

    expect(redactText("failed to email lim.wei.siang@houzscentury.com")).toBe("failed to email [email]");
    expect(redactText("IC 880101-14-5523 not found")).toBe("IC [number] not found");

    // Short numbers survive — they are what makes an error readable at all.
    expect(redactText("row 42 of 100 failed")).toBe("row 42 of 100 failed");

    // And it is applied on the way INTO the event, not merely available.
    expect(JSON.stringify(buildEvent({}, new Error(pg), { source: "worker" }))).not.toContain("0123456789");
  });

  test("a relayed browser crash keeps its real exception class", () => {
    // The relay reconstructs a plain `new Error(message)` from a stored string,
    // so without recovering the class from the stack every frontend issue would
    // group into one bucket called "Error".
    const event = buildEvent({}, new Error("Cannot read properties of undefined (reading 'data')"), {
      source: "browser",
      route: "/sales",
      stack: "TypeError: Cannot read properties of undefined\n    at SalesList (index-abc.js:1:2)",
    });
    const values = (event.exception as { values: Array<{ type: string }> }).values;
    expect(values[0].type).toBe("TypeError");
  });

  test("query strings are stripped from stack frame filenames", () => {
    // A frame URL can carry one, and a query string is where tokens and filter
    // values live — the same boundary routes/clientErrors.ts already enforces.
    const frames = parseStackFrames(
      "Error: x\n" +
        "    at load (https://erp.houzscentury.com/assets/index-abc.js?token=secret123:10:5)\n" +
        "    at boot (https://erp.houzscentury.com/assets/main.js:1:1)",
    );
    expect(JSON.stringify(frames)).not.toContain("secret123");
    expect(frames.map((f) => f.filename)).toEqual([
      "https://erp.houzscentury.com/assets/main.js",
      "https://erp.houzscentury.com/assets/index-abc.js",
    ]);
    // Sentry wants frames OLDEST FIRST — the reverse of how V8 prints a stack.
    // Getting this wrong groups issues badly and fails silently, so pin it.
    expect(frames[0].function).toBe("boot");
  });
});

describe("error tracking — mechanics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetRateLimitForTest();
  });

  test("parses hosted and self-hosted DSNs into the envelope endpoint", () => {
    expect(parseDsn("https://abc123@o4507.ingest.us.sentry.io/4508")).toEqual({
      publicKey: "abc123",
      envelopeUrl: "https://o4507.ingest.us.sentry.io/api/4508/envelope/",
    });
    // Self-hosted GlitchTip behind a path prefix — same protocol, different
    // host. This is what "the DSN decides who holds the data" means in code.
    expect(parseDsn("https://key@glitchtip.example.com/errors/9")).toEqual({
      publicKey: "key",
      envelopeUrl: "https://glitchtip.example.com/errors/api/9/envelope/",
    });
  });

  test("the storm brake caps a single isolate, and the cap resets", () => {
    const fetchSpy = stubFetch();
    __resetRateLimitForTest();
    const e = envWith({ SENTRY_DSN: FAKE_DSN });

    for (let i = 0; i < 100; i++) captureError(e, new Error(`boom ${i}`), { source: "worker" });
    // Ten per minute per isolate. During the 18h outage every request failed
    // identically; an alert rule needs a handful of events, not 100,000, and
    // the free plan only holds 5,000 a month.
    expect(envelopeCalls(fetchSpy)).toHaveLength(10);

    __resetRateLimitForTest();
    captureError(e, new Error("next window"), { source: "worker" });
    expect(envelopeCalls(fetchSpy)).toHaveLength(11);
  });

  test("the envelope is well formed: three lines, auth header, no body echo", () => {
    const fetchSpy = stubFetch();
    __resetRateLimitForTest();

    captureError(envWith({ SENTRY_DSN: FAKE_DSN }), new Error("boom"), {
      source: "worker",
      route: "/api/x/:id",
      method: "POST",
      status: 500,
    });

    const [url, init] = envelopeCalls(fetchSpy)[0] as [string, RequestInit];
    expect(url).toBe("https://o0.ingest.invalid/api/1234567/envelope/");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");
    expect(headers["X-Sentry-Auth"]).toContain("sentry_key=examplekey");
    const lines = String(init.body).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).type).toBe("event");
    expect(JSON.parse(lines[2]).exception.values[0].value).toBe("boom");
  });

  test("a sample rate of 0 reports nothing", () => {
    const fetchSpy = stubFetch();
    __resetRateLimitForTest();
    const e = envWith({ SENTRY_DSN: FAKE_DSN, SENTRY_SAMPLE_RATE: "0" });

    for (let i = 0; i < 10; i++) captureError(e, new Error("boom"), { source: "worker" });
    expect(envelopeCalls(fetchSpy)).toHaveLength(0);
  });

  test("an unreachable collector never surfaces as an application error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    __resetRateLimitForTest();

    const pending: Promise<unknown>[] = [];
    expect(() =>
      captureError(envWith({ SENTRY_DSN: FAKE_DSN }), new Error("boom"), { source: "worker" }, (p) =>
        pending.push(p),
      ),
    ).not.toThrow();
    // The rejection is swallowed INSIDE the reporter, so awaiting resolves
    // rather than rejects — otherwise waitUntil would log an unhandled
    // rejection every time the collector hiccups, which is the opposite of
    // what an error tracker is for.
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});

describe("error tracking — the Worker log line", () => {
  // The shape postgres.js throws: its stack starts at the frames, so logging the
  // error object alone wrote no message, no table and no constraint.
  class PostgresError extends Error {
    code = "23505";
    table_name = "sales_reps";
    constraint_name = "sales_reps_pkey";
    constructor(message: string) {
      super(message);
      this.name = "PostgresError";
      this.stack = "    at ErrorResponse (index.js:97495:30)\n    at handle (index.js:97244:7)";
    }
  }

  test("a database error names its code, table and constraint, not just frames", () => {
    const line = describeErrorForLog(
      new PostgresError('duplicate key value violates unique constraint "sales_reps_pkey"'),
    );
    expect(line).toBe(
      'PostgresError (code=23505 table=sales_reps constraint=sales_reps_pkey): duplicate key value violates unique constraint "sales_reps_pkey"',
    );
  });

  test("a value the message quotes is redacted, as in the reported event", () => {
    const line = describeErrorForLog(new Error("Key (email)=(someone@example.com) already exists."));
    expect(line).toBe("Error: Key (email)=([redacted]) already exists.");
  });

  test("something thrown that is not an Error still reads", () => {
    expect(describeErrorForLog("boom")).toBe("boom");
    expect(describeErrorForLog(undefined)).toBe("undefined");
  });
});

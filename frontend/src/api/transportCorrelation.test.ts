import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../lib/authToken";
import { requestIdFromError } from "../lib/requestCorrelation";
import { portalApi } from "../portal/portalApi";
import { fetchSoSlipUrl } from "../vendor/scm/lib/slip";
import { verifiedSave } from "../vendor/scm/lib/verified-save";

beforeEach(() => {
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("non-core API transport correlation", () => {
  test("customer portal errors keep the server id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", {
      status: 404,
      headers: { "X-Request-Id": "portal-trace-1234" },
    })));

    let caught: unknown;
    try {
      await portalApi.get("/api/portal/probe", "case-token");
    } catch (error) {
      caught = error;
    }

    expect(requestIdFromError(caught)).toBe("portal-trace-1234");
  });

  test("verified-save returns the actual client id when the server omits its echo", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response("rejected", { status: 409 });
    }));

    const result = await verifiedSave({
      endpoint: "/correlation-probe",
      body: { value: 1 },
      readback: async () => ({ value: 1 }),
      expect: { value: 1 },
    });

    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "http") expect(result.requestId).toBe(sent);
  });

  test("slip HTTP errors keep the server id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", {
      status: 404,
      headers: { "X-Request-Id": "slip-trace-1234" },
    })));

    let caught: unknown;
    try {
      await fetchSoSlipUrl("SO-TEST");
    } catch (error) {
      caught = error;
    }

    expect(requestIdFromError(caught)).toBe("slip-trace-1234");
  });
});

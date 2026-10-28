import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { requestIdFromError } from "../../../lib/requestCorrelation";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch } from "./authed-fetch";

beforeEach(() => {
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SCM request correlation", () => {
  test("stamps a bounded id and keeps the authoritative server id on HTTP errors", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response(JSON.stringify({ message: "No such order" }), {
        status: 404,
        headers: { "X-Request-Id": "scm-server-trace" },
      });
    }));

    let caught: unknown;
    try {
      await authedFetch("/correlation-probe", { method: "POST", body: "{}" });
    } catch (error) {
      caught = error;
    }

    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    expect(requestIdFromError(caught)).toBe("scm-server-trace");
  });

  test("mints a fresh id for each physical retry attempt", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      ids.push(new Headers(init?.headers).get("X-Request-Id") ?? "");
      if (ids.length === 1) return new Response("warming up", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const pending = authedFetch<{ ok: boolean }>("/correlation-retry");
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ ok: true });

    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[1]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });

  test("keeps the actual client id when a network failure has no response", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      throw new TypeError("network down");
    }));

    let caught: unknown;
    try {
      await authedFetch("/correlation-network", { method: "POST", body: "{}" });
    } catch (error) {
      caught = error;
    }

    expect(requestIdFromError(caught)).toBe(sent);
    expect((caught as Error).message).toContain("Network error");
  });
});

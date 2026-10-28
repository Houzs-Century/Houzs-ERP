import { afterEach, describe, expect, test, vi } from "vitest";
import { correlatedFetch, requestIdFromError } from "../lib/requestCorrelation";
import { resetPasswordResponseError } from "./ResetPassword";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reset-password response correlation", () => {
  test("non-2xx JSON errors keep the authoritative server id", async () => {
    const response = new Response(JSON.stringify({ error: "This link has expired." }), {
      status: 410,
      headers: { "X-Request-Id": "reset-server-trace" },
    });

    const error = await resetPasswordResponseError(response, "Invalid link");

    expect(error.message).toBe("This link has expired.");
    expect(requestIdFromError(error)).toBe("reset-server-trace");
  });

  test("malformed non-2xx bodies keep a friendly fallback and the client id", async () => {
    let sent: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("X-Request-Id");
      return new Response("not-json", { status: 502 });
    }));
    const response = await correlatedFetch("/api/auth/reset/test");

    const error = await resetPasswordResponseError(response, "Invalid link");

    expect(error.message).toBe("Invalid link");
    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    expect(requestIdFromError(error)).toBe(sent);
  });
});

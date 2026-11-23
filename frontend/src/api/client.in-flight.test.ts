import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../lib/authToken";
import { api } from "./client";

/* Ported from Conts (click sweep F11/F12): a keyed save that meets idempotency_in_flight waits for the first request's answer. */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("core API idempotency_in_flight", () => {
  test("a keyed POST waits and returns the replayed result", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "idempotency_in_flight" }), { status: 409, headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 5 }), { status: 201, headers: { "content-type": "application/json" } }));
      const p = api.post("/api/projects", { name: "A" }, { idempotencyKey: "k-1" });
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).resolves.toMatchObject({ ok: true, id: 5 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { authedFetch, fetchRidingInFlight } from "./authed-fetch";

const inFlight = () => new Response(JSON.stringify({ error: "idempotency_in_flight", message: "This request is already being processed." }), { status: 409 });
const created = () => new Response(JSON.stringify({ docNo: "HC-SO-2611-916" }), { status: 201, headers: { "Idempotent-Replay": "true" } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("fetchRidingInFlight", () => {
  test("waits while the first request runs and returns its replayed answer", async () => {
    const answers = [inFlight(), inFlight(), created()];
    const send = vi.fn(async () => answers.shift()!);
    const sleep = vi.fn(async () => {});
    const res = await fetchRidingInFlight(send, true, null, sleep);
    expect(res.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("a request without a key is never repeated", async () => {
    const send = vi.fn(async () => inFlight());
    const res = await fetchRidingInFlight(send, false, null, vi.fn(async () => {}));
    expect(res.status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("another 409 is not waited on", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ error: "so_version_conflict" }), { status: 409 }));
    await fetchRidingInFlight(send, true, null, vi.fn(async () => {}));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("gives up after the wait limit and lets the in-flight answer through", async () => {
    const send = vi.fn(async () => inFlight());
    const res = await fetchRidingInFlight(send, true, null, vi.fn(async () => {}));
    expect(res.status).toBe(409);
    expect(send).toHaveBeenCalledTimes(61);
  });
});

describe("authedFetch with an Idempotency-Key", () => {
  test("the second press of a save resolves with the first press's result", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(inFlight()).mockResolvedValueOnce(created());
      const p = authedFetch<{ docNo: string }>("/mfg-sales-orders", {
        method: "POST", body: JSON.stringify({ debtorName: "A" }), headers: { "Idempotency-Key": "k-1" },
      });
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).resolves.toEqual({ docNo: "HC-SO-2611-916" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe("k-1");
    } finally {
      vi.useRealTimers();
    }
  });
});

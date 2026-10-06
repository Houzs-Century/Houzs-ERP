import { beforeEach, describe, expect, test, vi } from "vitest";
import { AUTH_TOKEN_KEY } from "../../../lib/authToken";
import { combineAbortSignals } from "../../../lib/abort";
import { authedFetch } from "./authed-fetch";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(AUTH_TOKEN_KEY, "test-token");
  vi.restoreAllMocks();
});

describe("authedFetch cancellation", () => {
  test("caller and deadline cancellation both reach the combined signal", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const combined = combineAbortSignals(caller.signal, deadline.signal);
    expect(combined?.aborted).toBe(false);
    caller.abort("superseded");
    expect(combined?.aborted).toBe(true);

    const caller2 = new AbortController();
    const deadline2 = new AbortController();
    const combined2 = combineAbortSignals(caller2.signal, deadline2.signal);
    deadline2.abort("deadline");
    expect(combined2?.aborted).toBe(true);
  });

  test("a superseded GET aborts once and is not retried", async () => {
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("cancellation during retry backoff prevents the second fetch", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("warming up", { status: 503 }),
    );
    const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("a real request combines the caller signal with its deadline", async () => {
    const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const caller = new AbortController();
    const deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: vi.fn(() => deadline.signal),
    });

    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = () => reject(requestSignal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (requestSignal?.aborted) rejectOnAbort();
        else requestSignal?.addEventListener("abort", rejectOnAbort, { once: true });
      });
    });

    try {
      const pending = authedFetch("/mfg-sales-orders?q=A", { signal: caller.signal });
      await vi.waitFor(() => expect(requestSignal).toBeTruthy());
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      caller.abort(new DOMException("Aborted", "AbortError"));

      await expect(pending).rejects.toBeTruthy();
      expect(requestSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
      else delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
    }
  });
});

/* Owner 2026-09-22: a transient gateway 504 on a SAVE must be ridden out, not
   surfaced as a failure the operator's edit gets lost behind — but only when a
   replay is safe (an Idempotency-Key dedupes the write). */
describe("authedFetch rides out a transient 502/504", () => {
  const jsonOk = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  test("a 504 on an IDEMPOTENT mutation retries, then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? new Response("gateway timeout", { status: 504 }) : jsonOk({ ok: true }));
    });
    const p = authedFetch("/mfg-sales-orders/HC-SO-1/amendments", {
      method: "POST", body: JSON.stringify({ a: 1 }), headers: { "Idempotency-Key": "k-1" },
    });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  test("a 504 on a mutation with NO idempotency key is NOT retried (replay could double-write)", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls++;
      return Promise.resolve(new Response("gateway timeout", { status: 504 }));
    });
    await expect(authedFetch("/mfg-sales-orders/HC-SO-1/items", {
      method: "POST", body: JSON.stringify({ a: 1 }),
    })).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  test("a 504 on a GET retries (reads are always safe to replay)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      calls++;
      return Promise.resolve(calls === 1 ? new Response("gateway timeout", { status: 504 }) : jsonOk({ items: [] }));
    });
    const p = authedFetch("/mfg-sales-orders/HC-SO-1");
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ items: [] });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });
});

/* The bill readers (owner 2026-10-05): ONE paper to the AI reader can take past
   30 s, so they get the scan wait; they write nothing, so a timeout says so
   instead of warning of a duplicate save — and is not replayed by itself. */
describe("the bill readers", () => {
  const withDeadline = async (run: (deadline: AbortController, asked: number[]) => Promise<void>) => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const deadline = new AbortController();
    const asked: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: vi.fn((ms: number) => { asked.push(ms); return deadline.signal; }),
    });
    try {
      await run(deadline, asked);
    } finally {
      if (original) Object.defineProperty(AbortSignal, "timeout", original);
      else delete (AbortSignal as { timeout?: typeof AbortSignal.timeout }).timeout;
    }
  };
  const hangUntilAborted = () => vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      const fail = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    }));

  test.each(["/payment-vouchers/extract", "/credit-notes/scan", "/payment-requests/read-bill"])(
    "%s waits two minutes, and a timeout says nothing was saved", async (path) => {
      await withDeadline(async (deadline, asked) => {
        const fetchMock = hangUntilAborted();
        const pending = authedFetch(path, { method: "POST", body: "{}" });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(asked).toEqual([120_000]);
        deadline.abort(new DOMException("Timed out", "TimeoutError"));
        await expect(pending).rejects.toThrow("Reading took too long — nothing was saved. Please read it again.");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    },
  );

  test("a save keeps the 30-second wait and its duplicate warning", async () => {
    await withDeadline(async (deadline, asked) => {
      const fetchMock = hangUntilAborted();
      const pending = authedFetch("/ap-invoices", { method: "POST", body: "{}" });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(asked).toEqual([30_000]);
      deadline.abort(new DOMException("Timed out", "TimeoutError"));
      await expect(pending).rejects.toThrow(/couldn't confirm whether it saved/);
    });
  });
});

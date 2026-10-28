import { afterEach, describe, expect, test, vi } from "vitest";
import { abortableDelay, combineAbortSignals } from "./abort";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("abort utilities", () => {
  test("either caller or deadline aborts the combined signal", () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const combined = combineAbortSignals(caller.signal, deadline.signal)!;
    caller.abort("superseded");
    expect(combined.aborted).toBe(true);

    const caller2 = new AbortController();
    const deadline2 = new AbortController();
    const combined2 = combineAbortSignals(caller2.signal, deadline2.signal)!;
    deadline2.abort("timeout");
    expect(combined2.aborted).toBe(true);
  });

  test("fallback works when AbortSignal.any is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: () => { throw new TypeError("unsupported"); },
    });
    try {
      const caller = new AbortController();
      const deadline = new AbortController();
      const combined = combineAbortSignals(caller.signal, deadline.signal)!;
      deadline.abort("timeout");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("timeout");
    } finally {
      if (original) Object.defineProperty(AbortSignal, "any", original);
      else Reflect.deleteProperty(AbortSignal, "any");
    }
  });

  test("an already-aborted signal is preserved", () => {
    const caller = new AbortController();
    caller.abort("already done");
    const combined = combineAbortSignals(caller.signal, new AbortController().signal)!;
    expect(combined.aborted).toBe(true);
  });

  test("retry delay ends immediately when the request is cancelled", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const pending = abortableDelay(10_000, caller.signal);
    caller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

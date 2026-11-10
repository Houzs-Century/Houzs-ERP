import { afterEach, describe, expect, test, vi } from "vitest";
import { friendlySaveMessage, verifiedSave } from "./verified-save";

/* Hookka #268: a write that returned 2xx and whose confirming read was then
   interrupted was reported as "Save failed", so staff re-keyed a SKU price that
   had saved. Such a save is UNVERIFIED, never "network" or a failure. */
const okWrite = async () => new Response("{}", { status: 200 });

describe("verifiedSave after a successful write", () => {
  test("an interrupted read-back is unverified, not a failure", async () => {
    const r = await verifiedSave({
      endpoint: "/x",
      fetcher: okWrite,
      readback: async () => { throw new DOMException("signal is aborted without reason", "AbortError"); },
      expect: { v: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unverified");
  });

  test("a read-back that returns nothing is unverified too", async () => {
    const r = await verifiedSave({ endpoint: "/x", fetcher: okWrite, readback: async () => null, expect: { v: 1 } });
    if (!r.ok) expect(r.reason).toBe("unverified");
    else throw new Error("expected unverified");
  });

  test("the operator is told it saved, not that it failed", () => {
    const msg = friendlySaveMessage({ ok: false, reason: "unverified", details: "readback failed" }, { noun: "change" });
    expect(msg).toMatch(/^Change saved/);
    expect(msg).not.toMatch(/not saved|couldn't|failed/i);
  });

  test("a write that never reached the server is still a network failure", async () => {
    const r = await verifiedSave({
      endpoint: "/x",
      fetcher: async () => { throw new TypeError("Failed to fetch"); },
      readback: async () => ({ v: 1 }),
      expect: { v: 1 },
    });
    if (!r.ok) expect(r.reason).toBe("network");
    else throw new Error("expected network");
  });
});

/* Sister-ERP gap review P11: one dropped confirming read is retried before the
   save is reported as unconfirmed. */
describe("verifiedSave confirming read retries", () => {
  afterEach(() => { vi.useRealTimers(); });

  test("a read that fails twice and then answers confirms the save", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = verifiedSave({
      endpoint: "/x",
      fetcher: okWrite,
      readback: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("Failed to fetch");
        return { v: 1 };
      },
      expect: { v: 1 },
    });
    await vi.runAllTimersAsync();
    const r = await pending;
    expect(calls).toBe(3);
    expect(r.ok).toBe(true);
  });

  test("three failed reads are unverified, and no more than three are made", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = verifiedSave({
      endpoint: "/x",
      fetcher: okWrite,
      readback: async () => { calls += 1; return null; },
      expect: { v: 1 },
    });
    await vi.runAllTimersAsync();
    const r = await pending;
    expect(calls).toBe(3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unverified");
  });
});

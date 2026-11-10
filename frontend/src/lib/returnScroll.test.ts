// Where a page was scrolled when an order was opened from it — given back once,
// on the way back (owner 2026-10-21: 返回也要返回 merchant recon).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RETURN_PICKS_KEY, RETURN_SCROLL_KEY, dropReturnPicks, peekReturnPicks, rememberReturnPicks, rememberReturnScroll, takeReturnScroll,
} from "./returnScroll";

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("return scroll", () => {
  it("is kept per address and given back once", () => {
    rememberReturnScroll("/scm/merchant-recon?batch=230");
    expect(takeReturnScroll("/scm/merchant-recon?batch=230")).toEqual({ main: 0, window: 0 });
    expect(takeReturnScroll("/scm/merchant-recon?batch=230")).toBeNull();
    expect(takeReturnScroll("/scm/merchant-recon")).toBeNull();
  });

  it("goes stale after thirty minutes, so an old spot never yanks a page opened later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T06:00:00Z"));
    rememberReturnScroll("/scm/merchant-recon");
    vi.setSystemTime(new Date("2026-10-21T06:31:00Z"));
    expect(takeReturnScroll("/scm/merchant-recon")).toBeNull();
  });

  it("keeps the newest twenty addresses and survives junk in storage", () => {
    for (let i = 0; i < 25; i += 1) rememberReturnScroll(`/p/${i}`);
    expect(Object.keys(JSON.parse(sessionStorage.getItem(RETURN_SCROLL_KEY) ?? "{}") as object)).toHaveLength(20);
    sessionStorage.setItem(RETURN_SCROLL_KEY, "not json");
    expect(takeReturnScroll("/p/24")).toBeNull();
  });
});

/* What a page had ticked when an order was opened from it — the bank reconciliation's
   movements and entries (owner 2026-11-10: 点开后也可以返回这里). */
describe("return picks", () => {
  const bank = "/scm/bank-recon?account=310-0010&month=2026-10&tab=not-on-bank";

  it("are kept per address, read without being used up, and dropped once taken", () => {
    rememberReturnPicks({ lines: [1192], entries: ["2990-JE-2610-0354"] }, bank);
    expect(peekReturnPicks(bank)).toEqual({ lines: [1192], entries: ["2990-JE-2610-0354"] });
    expect(peekReturnPicks(bank)).toEqual({ lines: [1192], entries: ["2990-JE-2610-0354"] });
    expect(peekReturnPicks("/scm/bank-recon")).toBeNull();
    dropReturnPicks(bank);
    expect(peekReturnPicks(bank)).toBeNull();
  });

  it("go stale after thirty minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T08:00:00Z"));
    rememberReturnPicks({ lines: [1], entries: [] }, bank);
    vi.setSystemTime(new Date("2026-11-10T08:31:00Z"));
    expect(peekReturnPicks(bank)).toBeNull();
  });

  it("keep the newest twenty addresses and give back only well-formed ticks", () => {
    for (let i = 0; i < 25; i += 1) rememberReturnPicks({ lines: [i], entries: [] }, `/p/${i}`);
    expect(Object.keys(JSON.parse(sessionStorage.getItem(RETURN_PICKS_KEY) ?? "{}") as object)).toHaveLength(20);
    sessionStorage.setItem(RETURN_PICKS_KEY, JSON.stringify({ [bank]: { lines: [7, "x", 1.5], entries: ["JE-1", 3], at: Date.now() } }));
    expect(peekReturnPicks(bank)).toEqual({ lines: [7], entries: ["JE-1"] });
    sessionStorage.setItem(RETURN_PICKS_KEY, "not json");
    expect(peekReturnPicks(bank)).toBeNull();
  });
});

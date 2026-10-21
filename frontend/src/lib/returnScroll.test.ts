// Where a page was scrolled when an order was opened from it — given back once,
// on the way back (owner 2026-10-21: 返回也要返回 merchant recon).
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETURN_SCROLL_KEY, rememberReturnScroll, takeReturnScroll } from "./returnScroll";

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

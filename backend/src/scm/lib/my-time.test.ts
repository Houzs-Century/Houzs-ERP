import { describe, it, expect, afterEach, vi } from "vitest";
import { todayMyt, mytDateOf } from "./my-time";

// The whole point of todayMyt() is the 00:00-08:00 MYT window, where the UTC
// calendar date is still YESTERDAY. Every assertion below pins a moment inside
// or on the edge of that window — a fix that silently reverts to the raw UTC
// slice passes no test here.
//
// Workers freeze Date.now() to the last I/O rather than reading the wall clock,
// so the clock is faked explicitly rather than inferred from the runtime.
const at = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => {
  vi.useRealTimers();
});

describe("todayMyt", () => {
  it("returns TOMORROW's UTC date inside the 00:00-08:00 MYT window", () => {
    vi.useFakeTimers();
    // 17:00 UTC on the 16th IS 01:00 MYT on the 17th — a Malaysian office is
    // open-ish and every document dated here belongs to the 17th.
    at("2026-07-16T17:00:00Z");
    expect(todayMyt()).toBe("2026-07-17");
    // The bug this helper exists to prevent, pinned alongside the fix so the
    // 8-hour divergence is visible rather than asserted in prose.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("flips exactly at MY midnight, not UTC midnight", () => {
    vi.useFakeTimers();
    at("2026-07-16T15:59:59Z"); // 23:59:59 MYT on the 16th
    expect(todayMyt()).toBe("2026-07-16");
    at("2026-07-16T16:00:00Z"); // 00:00:00 MYT on the 17th
    expect(todayMyt()).toBe("2026-07-17");
  });

  it("crosses the MONTH boundary a day early in UTC — the closed-period case", () => {
    vi.useFakeTimers();
    // 01:00 MYT on 1 Aug. A document dated from the UTC slice here books into
    // JULY, a month the accounts may already have closed.
    at("2026-07-31T17:00:00Z");
    expect(todayMyt()).toBe("2026-08-01");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-31");
  });

  it("crosses the YEAR boundary the same way", () => {
    vi.useFakeTimers();
    at("2026-12-31T17:00:00Z"); // 01:00 MYT on 1 Jan 2027
    expect(todayMyt()).toBe("2027-01-01");
  });

  it("applies offsetDays against the MY date, not the UTC one", () => {
    vi.useFakeTimers();
    at("2026-07-16T17:00:00Z"); // 01:00 MYT on the 17th
    expect(todayMyt(1)).toBe("2026-07-18");
    expect(todayMyt(-1)).toBe("2026-07-16");
    expect(todayMyt(7)).toBe("2026-07-24");
    // Offsets must walk the calendar, not just the number line.
    at("2026-07-31T17:00:00Z"); // 01:00 MYT on 1 Aug
    expect(todayMyt(-1)).toBe("2026-07-31");
  });

  it("is stable at midday, where UTC and MY agree", () => {
    vi.useFakeTimers();
    at("2026-07-17T04:00:00Z"); // 12:00 MYT
    expect(todayMyt()).toBe("2026-07-17");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-17");
  });
});

describe("mytDateOf", () => {
  it("buckets a UTC instant to the MY calendar day it happened on", () => {
    // 23:30 UTC is 07:30 MYT the NEXT day — the row was created on the 17th as
    // far as anyone in the office is concerned.
    expect(mytDateOf("2026-07-16T23:30:00Z")).toBe("2026-07-17");
    expect(mytDateOf("2026-07-16T15:59:59Z")).toBe("2026-07-16");
    expect(mytDateOf("2026-07-16T16:00:00Z")).toBe("2026-07-17");
  });

  it("accepts Date and epoch-ms as well as an ISO string", () => {
    const iso = "2026-07-16T17:00:00Z";
    expect(mytDateOf(new Date(iso))).toBe("2026-07-17");
    expect(mytDateOf(new Date(iso).getTime())).toBe("2026-07-17");
  });
});

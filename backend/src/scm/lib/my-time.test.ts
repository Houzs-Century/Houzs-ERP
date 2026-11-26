import { describe, it, expect, afterEach, vi } from "vitest";
import { todayMyt, mytDateOf, mytDayWindow } from "./my-time";

const at = (iso: string) => vi.setSystemTime(new Date(iso));

afterEach(() => {
  vi.useRealTimers();
});

describe("todayMyt", () => {
  it("returns TOMORROW's UTC date inside the 00:00-08:00 MYT window", () => {
    vi.useFakeTimers();
    at("2026-07-16T17:00:00Z");
    expect(todayMyt()).toBe("2026-07-17");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("flips exactly at MY midnight, not UTC midnight", () => {
    vi.useFakeTimers();
    at("2026-07-16T15:59:59Z");
    expect(todayMyt()).toBe("2026-07-16");
    at("2026-07-16T16:00:00Z");
    expect(todayMyt()).toBe("2026-07-17");
  });

  it("crosses the MONTH boundary a day early in UTC — the closed-period case", () => {
    vi.useFakeTimers();
    at("2026-07-31T17:00:00Z");
    expect(todayMyt()).toBe("2026-08-01");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-31");
  });

  it("crosses the YEAR boundary the same way", () => {
    vi.useFakeTimers();
    at("2026-12-31T17:00:00Z");
    expect(todayMyt()).toBe("2027-01-01");
  });

  it("applies offsetDays against the MY date, not the UTC one", () => {
    vi.useFakeTimers();
    at("2026-07-16T17:00:00Z");
    expect(todayMyt(1)).toBe("2026-07-18");
    expect(todayMyt(-1)).toBe("2026-07-16");
    expect(todayMyt(7)).toBe("2026-07-24");
    at("2026-07-31T17:00:00Z");
    expect(todayMyt(-1)).toBe("2026-07-31");
  });

  it("is stable at midday, where UTC and MY agree", () => {
    vi.useFakeTimers();
    at("2026-07-17T04:00:00Z");
    expect(todayMyt()).toBe("2026-07-17");
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-07-17");
  });
});

describe("mytDateOf", () => {
  it("buckets a UTC instant to the MY calendar day it happened on", () => {
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

describe("mytDayWindow — a TIMESTAMPTZ filter by Malaysian calendar day", () => {
  it("runs from 00:00 MYT on `from` to 00:00 MYT the day after `to`", () => {
    expect(mytDayWindow("2026-11-10", "2026-11-10")).toEqual({
      startUtc: "2026-11-09T16:00:00.000Z",
      endUtc: "2026-11-10T16:00:00.000Z",
    });
    expect(mytDayWindow("2026-11-01", "2026-11-30")).toEqual({
      startUtc: "2026-10-31T16:00:00.000Z",
      endUtc: "2026-11-30T16:00:00.000Z",
    });
  });

  it("leaves an absent bound open", () => {
    expect(mytDayWindow(undefined, "2026-11-10")).toEqual({ startUtc: null, endUtc: "2026-11-10T16:00:00.000Z" });
    expect(mytDayWindow("", null)).toEqual({ startUtc: null, endUtc: null });
  });

  it("refuses a bound that is not YYYY-MM-DD instead of dropping the filter", () => {
    expect(mytDayWindow("10/11/2026", null)).toBeNull();
    expect(mytDayWindow(null, "2026-11-10T23:59:59Z")).toBeNull();
  });
});

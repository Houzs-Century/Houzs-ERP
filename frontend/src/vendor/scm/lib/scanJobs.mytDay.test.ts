import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hhmm, isTodayTs } from "./scan-jobs";
import { isPiTodayTs, piHhmm } from "./pi-scan-jobs";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T17:30:00Z"));
});
afterEach(() => vi.useRealTimers());

describe.each([
  ["sales-order scan", isTodayTs, hhmm],
  ["purchase-invoice scan", isPiTodayTs, piHhmm],
])("%s jobs judge 'today' by the Malaysian day", (_name, isToday, clock) => {
  it("a job from 00:10 on the 10th (Malaysia) is today's", () => {
    expect(isToday(Date.parse("2026-11-09T16:10:00Z"))).toBe(true);
  });
  it("a job from 23:30 on the 9th (Malaysia) is not", () => {
    expect(isToday(Date.parse("2026-11-09T15:30:00Z"))).toBe(false);
  });
  it("the day turns at 16:00 UTC, not at midnight UTC", () => {
    vi.setSystemTime(new Date("2026-11-09T15:59:00Z"));
    expect(isToday(Date.parse("2026-11-09T01:00:00Z"))).toBe(true);
    expect(isToday(Date.parse("2026-11-09T16:00:00Z"))).toBe(false);
  });
  it("a missing time is never today", () => {
    expect(isToday(0)).toBe(false);
  });
  it("the job time is the Malaysian clock", () => {
    expect(clock(Date.parse("2026-11-09T16:10:00Z"))).toBe("00:10");
  });
});
